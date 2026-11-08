// 用真实 .userdata 生成一份同步码，供安卓端单测验证「同步后播放字段是否完整」。
// 目的：用户报告「和电脑同步歌单之后就找不到播放地址」，
// 播放地址靠 bvid + cid 解析，所以要把真实数据送进安卓端的解码路径检查一遍。
//
// 跑法：node scripts/gen-real-sync-code.mjs
// 产物：android/app/src/test/resources/desktop-real-sync-code.txt
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { Library } = require('../src/library.js');
const { SyncBridge } = require('../src/syncBridge.js');

const libraryFile = path.join(process.cwd(), '.userdata', 'library.json');
if (!fs.existsSync(libraryFile)) {
  console.error('没有找到', libraryFile);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-code-'));
const lib = new Library(libraryFile);
const bridge = new SyncBridge({
  library: lib,
  file: path.join(tmp, 'sync-state.json'),
  deviceId: 'd0000real01',
  deviceName: 'REAL-PC',
});
bridge.captureLocal();
const code = bridge.exportCode();

const out = path.join('android', 'app', 'src', 'test', 'resources', 'desktop-real-sync-code.txt');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, code, 'utf8');

// 顺便把预期值写成一份 JSON，供测试核对「桌面端认为这些曲目是可播的」
const doc = bridge.exportCompact();
const expect = [];
for (const [key, e] of Object.entries(doc.tracks)) {
  if (!e.present.v) continue;
  const c = e.core.v;
  if (c.type !== 'bili') continue;
  expect.push({ key, bvid: c.bvid, cid: c.cid, title: c.title });
}
const expectOut = path.join('android', 'app', 'src', 'test', 'resources', 'desktop-real-expect.json');
fs.writeFileSync(expectOut, JSON.stringify(expect, null, 2), 'utf8');

console.log('同步码长度 =', code.length, '字符 ->', out);
console.log('可播曲目 =', expect.length, '条 ->', expectOut);
const noCid = expect.filter((x) => !x.cid);
console.log('其中 cid 缺失的 =', noCid.length);
if (noCid.length) console.log('  例:', JSON.stringify(noCid.slice(0, 3), null, 2));
const playlists = Object.values(doc.playlists || {});
console.log('歌单数 =', playlists.length);
for (const p of playlists) {
  console.log(`  「${p.title.v}」 items=${Object.keys(p.items || {}).length} present=${p.present.v}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
