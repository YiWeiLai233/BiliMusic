// 探测：CDN 对不同 UA 的态度，找出最稳妥的组合。
// 已确认 Android 桌面版 UA 被 403。这里验证原因假设：
//   - 移动 UA 需要移动 Referer(m.bilibili.com)？
//   - 还是这个 UA 串本身被拉黑？
// 跑法：node scripts/probe-ua.mjs <BVID>

import { createHash } from 'node:crypto';

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const UA_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_ANDROID_MOBILE =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const UA_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const md5 = (s) => createHash('md5').update(s).digest('hex');
const enc = (v) => encodeURIComponent(String(v)).replace(/[!'()*]/g, '');
const qs = (o) =>
  Object.keys(o)
    .sort()
    .map((k) => `${enc(k)}=${enc(o[k])}`)
    .join('&');

const API_H = {
  'User-Agent': UA_WIN,
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
};

async function mixin() {
  const j = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: API_H,
  }).then((r) => r.json());
  const pick = (u) => (u.split('/').pop() || '').split('.')[0];
  const orig =
    pick(j?.data?.wbi_img?.img_url || '') + pick(j?.data?.wbi_img?.sub_url || '');
  return MIXIN_TAB.map((i) => orig[i])
    .join('')
    .slice(0, 32);
}

async function playurl(bvid, cid, mix) {
  const p = {
    bvid,
    cid: String(cid),
    fnval: '16',
    fnver: '0',
    fourk: '1',
    wts: Math.round(Date.now() / 1000),
  };
  const q = qs(p);
  const url = `https://api.bilibili.com/x/player/wbi/playurl?${q}&w_rid=${md5(q + mix)}`;
  return fetch(url, { headers: API_H }).then((r) => r.json());
}

async function probe(url, headers) {
  try {
    const r = await fetch(url, { headers, redirect: 'follow' });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ct: r.headers.get('content-type'), n: buf.length };
  } catch (e) {
    return { error: e.message };
  }
}

const BVID = process.argv[2] || 'BV1zKZrYAEi8';

const main = async () => {
  const info = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${BVID}`,
    { headers: API_H }
  ).then((r) => r.json());
  const cid = info.data.pages?.[0]?.cid ?? info.data.cid;

  const mix = await mixin();
  const pu = await playurl(BVID, cid, mix);
  const audio = (pu?.data?.dash?.audio || []).sort(
    (a, b) => b.bandwidth - a.bandwidth
  )[0];
  if (!audio) {
    console.log('no audio', JSON.stringify(pu).slice(0, 300));
    return;
  }
  const url = audio.baseUrl || audio.base_url;

  const cases = [
    ['Win UA + PC Referer', { 'User-Agent': UA_WIN, Referer: 'https://www.bilibili.com/' }],
    ['Mac UA + PC Referer', { 'User-Agent': UA_MAC, Referer: 'https://www.bilibili.com/' }],
    ['Android phone UA + PC Referer', { 'User-Agent': UA_ANDROID_MOBILE, Referer: 'https://www.bilibili.com/' }],
    ['Android phone UA + MOBILE Referer', { 'User-Agent': UA_ANDROID_MOBILE, Referer: 'https://m.bilibili.com/' }],
    ['Android tablet UA + PC Referer', { 'User-Agent': UA_ANDROID_TABLET, Referer: 'https://www.bilibili.com/' }],
    ['Android phone UA + Origin only', { 'User-Agent': UA_ANDROID_MOBILE, Origin: 'https://www.bilibili.com' }],
    ['no UA + PC Referer', { Referer: 'https://www.bilibili.com/' }],
    ['Win UA + Origin + Referer + Accept', { 'User-Agent': UA_WIN, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com', Accept: '*/*' }],
  ];

  console.log('CDN host =', new URL(url).host);
  console.log('audio id =', audio.id, 'bw =', audio.bandwidth);
  console.log('\n=== UA / Referer 组合 ===');
  for (const [name, h] of cases) {
    const r = await probe(url, h);
    console.log(
      `  ${name.padEnd(34)} ${String(r.status ?? 'ERR').padEnd(4)} ct=${(r.ct || '-').padEnd(12)} bytes=${r.n ?? '-'} ${r.error || ''}`
    );
  }
};

main().catch((e) => console.error('FATAL', e));
