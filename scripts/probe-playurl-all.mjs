// 用真实同步码里的 bvid/cid 逐条打 playurl，看这些曲目本身能不能取到播放地址。
// 目的：用户说「和电脑同步歌单之后就找不到播放地址」。
// 如果同步后的数据字段完整（已验证），那失败点就在 playurl 这一步，逐条打出来定位。
//
// 跑法：node scripts/probe-playurl-all.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { Codec } = require('../src/sync.js');

const code = fs.readFileSync('android/app/src/test/resources/desktop-real-sync-code.txt', 'utf8').trim();
const doc = Codec.decode(code);

const UA_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = {
  'User-Agent': UA_WIN,
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
};

const mixinTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];
const { createHash } = require('node:crypto');
const md5 = (s) => createHash('md5').update(s).digest('hex');
const enc = (v) => encodeURIComponent(String(v)).replace(/[!'()*]/g, '');
const qs = (o) =>
  Object.keys(o)
    .sort()
    .map((k) => `${enc(k)}=${enc(o[k])}`)
    .join('&');

async function getMixin() {
  const j = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: H }).then((r) => r.json());
  const pick = (u) => (u.split('/').pop() || '').split('.')[0];
  const orig = pick(j?.data?.wbi_img?.img_url || '') + pick(j?.data?.wbi_img?.sub_url || '');
  return mixinTab.map((i) => orig[i]).join('').slice(0, 32);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tracks = Object.entries(doc.tracks)
  .filter(([, e]) => e.present.v && e.core.v.type === 'bili')
  .map(([k, e]) => ({ key: k, ...e.core.v }));

console.log('现场曲目 =', tracks.length);

const mix = await getMixin();
const results = [];

for (const t of tracks) {
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
  const url = `https://api.bilibili.com/x/player/wbi/playurl?${q}&w_rid=${md5(q + mix)}`;
  let code2 = null;
  let msg = '';
  let audios = 0;
  try {
    const r = await fetch(url, { headers: H }).then((r) => r.json());
    code2 = r.code;
    msg = r.message || '';
    audios = r?.data?.dash?.audio?.length || 0;
  } catch (e) {
    msg = 'EXC ' + e.message;
  }
  results.push({ key: t.key, bvid: t.bvid, cid: t.cid, code: code2, msg, audios });
  const bad = code2 !== 0 || audios === 0;
  console.log(
    `  ${bad ? 'BAD ' : 'ok  '} ${String(t.bvid).padEnd(14)} cid=${String(t.cid).padEnd(12)} code=${code2} audios=${audios} ${msg}`
  );
  await sleep(150);
}

const bad = results.filter((r) => r.code !== 0 || r.audios === 0);
console.log('\n失败条目 =', bad.length, '/', results.length);
const byCode = {};
for (const b of bad) byCode[b.code] = (byCode[b.code] || 0) + 1;
console.log('按返回码分组:', byCode);
if (bad.length) {
  console.log('\n失败样例:');
  for (const b of bad.slice(0, 8)) console.log(`  ${b.key} bvid=${b.bvid} cid=${b.cid} code=${b.code} ${b.msg}`);
}
