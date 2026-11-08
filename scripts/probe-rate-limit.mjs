// 假设：playAll 会把整张歌单一次性解析完（47 首 → 47 次 playurl），
// 连续请求会触发 B 站风控，导致靠后的曲目拿不到地址 → 用户看到「取不到播放地址」。
//
// 跑法：node scripts/probe-rate-limit.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { Codec } = require('../src/sync.js');
const { createHash } = require('node:crypto');

const code = fs.readFileSync('android/app/src/test/resources/desktop-real-sync-code.txt', 'utf8').trim();
const doc = Codec.decode(code);
const tracks = Object.values(doc.tracks)
  .filter((e) => e.present.v && e.core.v.type === 'bili')
  .map((e) => e.core.v);

console.log(`歌单共 ${tracks.length} 首，全部按顺序解析（模拟 playAll 的预解析行为）\n`);

const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const mixinTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];
const md5 = (s) => createHash('md5').update(s).digest('hex');
const enc = (v) => encodeURIComponent(String(v)).replace(/[!'()*]/g, '');
const qs = (o) =>
  Object.keys(o)
    .sort()
    .map((k) => `${enc(k)}=${enc(o[k])}`)
    .join('&');
const headers = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const j = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers }).then((r) => r.json());
const pick = (u) => (u.split('/').pop() || '').split('.')[0];
const orig = pick(j?.data?.wbi_img?.img_url || '') + pick(j?.data?.wbi_img?.sub_url || '');
const mixin = mixinTab.map((i) => orig[i]).join('').slice(0, 32);

let ok = 0;
let bad = 0;
const failures = [];

for (const [i, t] of tracks.entries()) {
  const p = {
    bvid: t.bvid,
    cid: String(t.cid),
    fnval: '16',
    fnver: '0',
    fourk: '1',
    web_location: '1315873',
    wts: Math.round(Date.now() / 1000),
  };
  const q = qs(p);
  const url = `https://api.bilibili.com/x/player/wbi/playurl?${q}&w_rid=${md5(q + mixin)}`;
  try {
    const r = await fetch(url, { headers }).then((r) => r.json());
    const audios = r?.data?.dash?.audio?.length || 0;
    if (r.code === 0 && audios > 0) {
      ok++;
    } else {
      bad++;
      failures.push({ n: i + 1, bvid: t.bvid, code: r.code, msg: r.message });
      console.log(`  [${String(i + 1).padStart(2)}] FAIL code=${r.code} ${r.message} (${t.bvid})`);
    }
  } catch (e) {
    bad++;
    failures.push({ n: i + 1, bvid: t.bvid, code: 'EXC', msg: e.message });
    console.log(`  [${String(i + 1).padStart(2)}] EXC ${e.message}`);
  }
  // 不 sleep，模拟手机端连发
}

console.log(`\n成功 ${ok} / 失败 ${bad}（共 ${tracks.length}）`);
if (failures.length) {
  console.log('\n先失败的几个：');
  for (const f of failures.slice(0, 5)) console.log(`  #${f.n} ${f.bvid} code=${f.code} ${f.msg}`);
}
