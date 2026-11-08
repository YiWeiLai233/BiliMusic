// 诊断：把桌面端真实库投影成 SyncDoc，检查每条 bili 曲目是否带得动播放所需的字段。
// 用户报告「和电脑同步歌单之后找不到播放地址」，播放地址靠 bvid + cid 解析，
// 所以这里逐条看这两个字段有没有在同步过程中丢掉。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { Library } = require('../src/library.js');
const { SyncBridge } = require('../src/syncBridge.js');
const { Codec } = require('../src/sync.js');

const DATA = path.join(process.cwd(), '.userdata');
const libraryFile = path.join(DATA, 'library.json');
if (!fs.existsSync(libraryFile)) {
  console.error('没有找到', libraryFile);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-diag-'));
const lib = new Library(libraryFile);
const bridge = new SyncBridge({
  library: lib,
  file: path.join(tmp, 'sync-state.json'),
  deviceId: 'd0000000diag',
  deviceName: 'DIAG-PC',
});
bridge.captureLocal();
const doc = bridge.exportCompact();

const decoded = Codec.decode(Codec.encode(doc));

console.log('=== 桌面端 bili 曲目（library 原始） ===');
const raw = lib.biliTracks();
console.log('总数 =', raw.length);
let rawMissing = 0;
for (const t of raw.slice(0, 8)) {
  const hasBvid = !!t.bvid;
  const hasCid = !!t.cid;
  if (!hasBvid || !hasCid) rawMissing++;
  console.log(
    `  id=${String(t.id).padEnd(22)} bvid=${String(t.bvid || 'MISSING').padEnd(14)} cid=${t.cid ?? 'MISSING'} page=${t.page ?? '-'}`
  );
}
for (const t of raw) {
  if (!t.bvid || !t.cid) rawMissing++;
}
console.log('原始库里 bvid 或 cid 缺失的条目 =', rawMissing);

console.log('\n=== 投影后的 SyncDoc tracks ===');
const keys = Object.keys(decoded.tracks);
console.log('doc 里曲目总数 =', keys.length);
let docMissing = 0;
const bad = [];
for (const k of keys) {
  const e = decoded.tracks[k];
  const c = e.core.v;
  if (!c.bvid || !c.cid) {
    docMissing++;
    if (bad.length < 10) bad.push(k);
  }
}
console.log('doc 里 bvid 或 cid 缺失的条目 =', docMissing);
if (bad.length) console.log('  缺失的键:', bad.join(', '));

console.log('\n=== 抽样对照（doc 中前 6 条 bili）===');
let shown = 0;
for (const k of keys) {
  const c = decoded.tracks[k].core.v;
  if (c.type !== 'bili') continue;
  console.log(
    `  ${k.padEnd(26)} bvid=${String(c.bvid || 'MISSING').padEnd(14)} cid=${c.cid ?? 'MISSING'} present=${decoded.tracks[k].present.v}`
  );
  if (++shown >= 6) break;
}

console.log('\n=== 歌单里的条目 ===');
for (const pid of Object.keys(decoded.playlists)) {
  const p = decoded.playlists[pid];
  const items = Object.entries(p.items || {});
  console.log(`  歌单「${p.title.v}」 items=${items.length}`);
  let orphan = 0;
  for (const [ik, it] of items) {
    const key = it.key;
    const track = decoded.tracks[key];
    if (!track) {
      orphan++;
      if (orphan <= 5) console.log(`    孤立项（doc 里没有这首曲目）: ${key}`);
    }
  }
  console.log(`    孤立项 = ${orphan}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
