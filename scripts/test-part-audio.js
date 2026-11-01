'use strict';
// 验证拆分出来的分 P 能取到可播放的音频流
const path = require('node:path');
const { Bili } = require('../src/bili');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const bili = new Bili(path.join(__dirname, '..', '.userdata'));
  const { tracks } = await bili.resolveLinks('https://www.bilibili.com/video/BV1SknF6KE5g');
  console.log('拆出', tracks.length, '个分 P');

  let ok = 0;
  for (const t of tracks) {
    const streams = await bili.audioStreams(t.bvid, t.cid);
    const best = streams[0];
    const r = await fetch(best.urls[0], {
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': UA, Range: 'bytes=0-1023' },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const box = buf.subarray(4, 8).toString();
    const pass = r.status === 206 && buf.length === 1024 && /ftyp|moov|styp|sidx/.test(box);
    if (pass) ok++;
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${t.id}  ${best.label.padEnd(6)}  status=${r.status} bytes=${buf.length} box=${box}  ${t.title.slice(0, 34)}`,
    );
    await new Promise((r2) => setTimeout(r2, 200));
  }
  console.log(`\n${ok}/${tracks.length} 个分 P 的音频流可用`);
  console.log('PART_AUDIO_OK:', ok === tracks.length && tracks.length > 0);
  process.exit(ok === tracks.length && tracks.length > 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
