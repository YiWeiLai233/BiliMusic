// 验证修复方案：API 仍用 Android UA（登录/收藏夹当前工作正常，不动），
// 只把 CDN 取流用的 UA 换成桌面 UA，看是否 200。
// 跑法：node scripts/probe-fix.mjs <BVID>

import { createHash } from 'node:crypto';

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const UA_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 模拟安卓端：API 全部用 Android UA
const API_H = {
  'User-Agent': UA_ANDROID,
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const md5 = (s) => createHash('md5').update(s).digest('hex');
const enc = (v) => encodeURIComponent(String(v)).replace(/[!'()*]/g, '');
const qs = (o) =>
  Object.keys(o)
    .sort()
    .map((k) => `${enc(k)}=${enc(o[k])}`)
    .join('&');

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

async function probe(url, headers, method = 'GET') {
  try {
    const r = await fetch(url, { method, headers });
    let n = 0;
    if (method === 'GET') {
      n = Buffer.from(await r.arrayBuffer()).length;
    }
    return {
      status: r.status,
      ct: r.headers.get('content-type'),
      cl: r.headers.get('content-length'),
      n,
    };
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
  if (info.code !== 0) {
    console.log('view failed', info.code, info.message);
    return;
  }
  const cid = info.data.pages?.[0]?.cid ?? info.data.cid;

  const mix = await mixin();
  const p = {
    bvid: BVID,
    cid: String(cid),
    fnval: '16',
    fnver: '0',
    fourk: '1',
    web_location: '1315873',
    wts: Math.round(Date.now() / 1000),
  };
  const q = qs(p);
  const url = `https://api.bilibili.com/x/player/wbi/playurl?${q}&w_rid=${md5(q + mix)}`;
  const pu = await fetch(url, { headers: API_H }).then((r) => r.json());
  console.log('playurl with Android UA: code =', pu.code, 'msg =', pu.message);
  const audios = pu?.data?.dash?.audio || [];
  console.log('dash audio count =', audios.length);

  if (!audios.length) {
    console.log('!! API 用 Android UA 拿不到 dash，返回的是:');
    console.log(JSON.stringify(pu.data).slice(0, 400));
    return;
  }
  const top = [...audios].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  const su = top.baseUrl || top.base_url;
  console.log('chosen id =', top.id, 'host =', new URL(su).host);
  console.log('URL 里 platform =', new URL(su).searchParams.get('platform'));

  const withRef = (ua) => ({ 'User-Agent': ua, Referer: 'https://www.bilibili.com/' });

  console.log('\n=== 关键验证：API 用 Android UA 拿的 URL，换 UA 去取流 ===');
  for (const [name, h] of [
    ['Android UA（现状，应 403）', withRef(UA_ANDROID)],
    ['Win UA（修复后，应 200）', withRef(UA_WIN)],
    ['Win UA + Range（应 206）', { ...withRef(UA_WIN), Range: 'bytes=0-' }],
    ['Win UA + Origin', { ...withRef(UA_WIN), Origin: 'https://www.bilibili.com' }],
  ]) {
    const r = await probe(su, h);
    console.log(
      `  ${name.padEnd(28)} ${String(r.status ?? 'ERR').padEnd(4)} ct=${(r.ct || '-').padEnd(11)} bytes=${r.n || r.cl || '-'} ${r.error || ''}`
    );
  }

  const hd = await probe(su, withRef(UA_WIN), 'HEAD');
  console.log(`  ${'Win UA HEAD'.padEnd(28)} ${String(hd.status ?? 'ERR').padEnd(4)} ct=${hd.ct || '-'} len=${hd.cl || '-'}`);
};

main().catch((e) => console.error('FATAL', e));
