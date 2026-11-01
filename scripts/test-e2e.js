// 端到端验证：WBI 签名 → playurl → 本地代理 Range → 封面代理
const path = require('node:path');
const { Bili } = require('../src/bili');
const { AudioProxy } = require('../src/audioProxy');

const DATA = path.join(__dirname, '..', '.userdata');

(async () => {
  const bili = new Bili(DATA);
  const proxy = new AudioProxy(bili);
  const port = await proxy.start();
  console.log('proxy port', port);

  // 1) nav（未登录也要能通）
  const nav = await bili.nav();
  console.log('nav:', JSON.stringify(nav));

  // 2) 二维码
  const qr = await bili.qrGenerate();
  console.log('qr url:', qr.url.slice(0, 70), 'key len', qr.key.length);

  // 3) 视频信息
  const BV = 'BV1GJ411x7h7';
  const meta = await bili.videoInfo(BV, { force: true });
  console.log('meta:', meta.title, '| cid', meta.cid, '| tid', meta.tid, meta.tname, '| isMusic', meta.isMusic, '| dur', meta.duration);

  // 4) 播放地址
  const streams = await bili.audioStreams(BV, meta.cid);
  console.log('streams:', streams.map((s) => `${s.id}=${s.label}(${Math.round(s.bandwidth / 1000)}kbps,${s.urls.length}url)`).join(' '));

  // 5) 走代理拉前 64KB
  const url = proxy.audioUrl(BV, meta.cid, streams[0].id);
  let t0 = Date.now();
  const r1 = await fetch(url, { headers: { Range: 'bytes=0-65535' } });
  const b1 = Buffer.from(await r1.arrayBuffer());
  console.log('proxy range:', r1.status, 'len', b1.length, 'type', r1.headers.get('content-type'),
    'range-header', r1.headers.get('content-range'), `${Date.now() - t0}ms`);
  const ftyp = b1.toString('latin1', 4, 8);
  console.log('first box type:', ftyp);

  // 6) 中段 Range（验证 seek 可行性）
  t0 = Date.now();
  const r2 = await fetch(url, { headers: { Range: 'bytes=2000000-2032767' } });
  const b2 = Buffer.from(await r2.arrayBuffer());
  console.log('proxy mid-range:', r2.status, 'len', b2.length, r2.headers.get('content-range'), `${Date.now() - t0}ms`);

  // 7) HEAD
  const r3 = await fetch(url, { method: 'HEAD' });
  console.log('proxy HEAD:', r3.status, 'len', r3.headers.get('content-length'));

  // 8) 封面代理
  const coverUrl = proxy.coverUrl(meta.pic);
  const r4 = await fetch(coverUrl);
  const b4 = Buffer.from(await r4.arrayBuffer());
  console.log('cover:', r4.status, 'len', b4.length, 'type', r4.headers.get('content-type'));

  // 9) token 校验
  const bad = await fetch(`http://127.0.0.1:${port}/audio/${BV}/${meta.cid}`);
  console.log('no token:', bad.status);

  // 10) 二次请求应命中直链缓存（stats.refreshes 不增）
  await fetch(url, { headers: { Range: 'bytes=0-1023' } }).then((r) => r.arrayBuffer());
  console.log('stats:', JSON.stringify(proxy.stats));

  proxy.stop();
  console.log('ALL OK');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
