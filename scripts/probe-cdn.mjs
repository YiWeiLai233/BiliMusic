// 按安卓端 BiliClient.audioStreams 的真实路径复现：WBI 签名 + fnval=16，
// 再用各种请求头去 CDN 取流，看哪种组合会被拒。
// 跑法：node scripts/probe-cdn.mjs <BVID>

import { createHash } from 'node:crypto';

const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const H = {
  'User-Agent': UA_PC,
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const md5 = (s) => createHash('md5').update(s).digest('hex');

const encodeValue = (v) =>
  encodeURIComponent(String(v)).replace(/[!'()*]/g, '');

const buildQuery = (obj) =>
  Object.keys(obj)
    .sort()
    .map((k) => `${encodeValue(k)}=${encodeValue(obj[k])}`)
    .join('&');

async function getMixin() {
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: H,
  });
  const j = await r.json();
  const img = j?.data?.wbi_img?.img_url || '';
  const sub = j?.data?.wbi_img?.sub_url || '';
  const pick = (u) => (u.split('/').pop() || '').split('.')[0];
  const orig = pick(img) + pick(sub);
  return MIXIN_TAB.map((i) => orig[i])
    .join('')
    .slice(0, 32);
}

async function signedGet(base, params, mixin) {
  const withWts = { ...params, wts: Math.round(Date.now() / 1000) };
  const q = buildQuery(withWts);
  const url = `${base}?${q}&w_rid=${md5(q + mixin)}`;
  const r = await fetch(url, { headers: H });
  const t = await r.text();
  let j = null;
  try {
    j = JSON.parse(t);
  } catch {}
  return { status: r.status, json: j, text: t.slice(0, 200) };
}

async function probe(url, headers, method = 'GET') {
  try {
    const r = await fetch(url, { method, headers });
    let first = '';
    if (method === 'GET') {
      const buf = Buffer.from(await r.arrayBuffer());
      first = buf.subarray(0, 12).toString('hex');
    }
    return {
      status: r.status,
      ct: r.headers.get('content-type'),
      cl: r.headers.get('content-length'),
      cr: r.headers.get('content-range'),
      first,
    };
  } catch (e) {
    return { error: e.message };
  }
}

const BVID = process.argv[2] || 'BV1zKZrYAEi8';

const main = async () => {
  const info = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${BVID}`,
    { headers: H }
  ).then((r) => r.json());
  if (info.code !== 0) {
    console.log('view failed', info.code, info.message);
    return;
  }
  const cid = info.data.pages?.[0]?.cid ?? info.data.cid;
  console.log('bvid=', BVID, 'cid=', cid);
  console.log('title=', info.data.title);

  const mixin = await getMixin();
  console.log('mixin=', mixin);

  console.log('\n=== playurl via x/player/wbi/playurl (fnval=16) ===');
  const pu = await signedGet(
    'https://api.bilibili.com/x/player/wbi/playurl',
    {
      bvid: BVID,
      cid: String(cid),
      fnval: '16',
      fnver: '0',
      fourk: '1',
      web_location: '1315873',
    },
    mixin
  );
  console.log('code=', pu.json?.code, 'msg=', pu.json?.message);
  const audios = pu.json?.data?.dash?.audio || [];
  console.log('dash audio count =', audios.length);
  if (!audios.length) {
    console.log('raw:', JSON.stringify(pu.json).slice(0, 500));
    return;
  }
  const sorted = [...audios].sort((a, b) => b.bandwidth - a.bandwidth);
  for (const a of sorted) {
    console.log(`  id=${a.id} bw=${a.bandwidth} codecs=${a.codecs}`);
  }
  const top = sorted[0];
  const url = top.baseUrl || top.base_url;
  const u = new URL(url);
  console.log('\nchosen id=', top.id);
  console.log('host =', u.host);
  console.log('query keys =', [...u.searchParams.keys()].join(','));

  console.log('\n=== 各头组合请求 CDN ===');
  const cases = [
    ['PC UA+Ref+Origin', { 'User-Agent': UA_PC, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com' }],
    ['Android UA+Ref+Origin', { 'User-Agent': UA_ANDROID, Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com' }],
    ['PC UA+Ref', { 'User-Agent': UA_PC, Referer: 'https://www.bilibili.com/' }],
    ['PC UA only', { 'User-Agent': UA_PC }],
    ['no headers', {}],
    ['Ref only', { Referer: 'https://www.bilibili.com/' }],
    ['PC UA+Ref+Range', { 'User-Agent': UA_PC, Referer: 'https://www.bilibili.com/', Range: 'bytes=0-1023' }],
  ];
  for (const [name, h] of cases) {
    const r = await probe(url, h);
    console.log(
      `  ${name.padEnd(22)} ${String(r.status ?? 'ERR').padEnd(4)} ct=${(r.ct || '-').padEnd(18)} len=${r.cl || '-'} range=${r.cr || '-'} head=${r.first || '-'} ${r.error || ''}`
    );
  }

  const hd = await probe(url, cases[0][1], 'HEAD');
  console.log(`  ${'HEAD PC UA+Ref+Origin'.padEnd(22)} ${String(hd.status ?? 'ERR').padEnd(4)} ct=${hd.ct || '-'} len=${hd.cl || '-'} range=${hd.cr || '-'}`);

  const backups = top.backupUrl || top.backup_url || [];
  console.log('\n=== 备份地址 ===');
  for (let i = 0; i < Math.min(backups.length, 3); i++) {
    const r = await probe(backups[i], cases[0][1]);
    console.log(`  backup[${i}] host=${new URL(backups[i]).host} status=${r.status ?? 'ERR'} len=${r.cl || '-'}`);
  }
};

main().catch((e) => console.error('FATAL', e));
