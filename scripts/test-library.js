'use strict';
/**
 * 本地库 + 本地代理的端到端测试。
 * 不依赖 ffmpeg：手工合成合法 WAV 文件当素材。
 * 跑法：node scripts/test-library.js
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { scanFolder, guessFromName } = require('../src/localLibrary');
const { Library } = require('../src/library');
const { AudioProxy } = require('../src/audioProxy');

const TMP_ROOT = path.join(__dirname, '..', '.userdata', 'lib-test');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** 合成一个指定时长的 16bit 单声道 WAV（正弦波，44100Hz） */
function makeWav(filePath, seconds, freq = 440) {
  const rate = 44100;
  const samples = Math.round(rate * seconds);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
  return buf.length;
}

function rangeFetch(url, start, end) {
  return fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
}

(async () => {
  // ── 准备素材 ──
  await fsp.rm(TMP_ROOT, { recursive: true, force: true });
  const musicDir = path.join(TMP_ROOT, 'music');
  const subDir = path.join(musicDir, '专辑A');
  await fsp.mkdir(subDir, { recursive: true });

  makeWav(path.join(musicDir, '01. 晨光 - 测试歌手.wav'), 2.0, 440);
  makeWav(path.join(musicDir, '02 - 夜航 - 测试歌手.wav'), 1.5, 550);
  makeWav(path.join(subDir, '没有分隔符的歌名.wav'), 1.0, 660);
  // 干扰项
  fs.writeFileSync(path.join(musicDir, 'readme.txt'), 'not audio');
  fs.writeFileSync(path.join(musicDir, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
  console.log('素材已生成于', musicDir);

  // ── 1. 文件名兜底解析 ──
  const g1 = guessFromName('01. 晨光 - 测试歌手.mp3');
  check('文件名解析「序号. 歌名 - 歌手」', g1.title === '晨光' && g1.artist === '测试歌手', JSON.stringify(g1));
  const g2 = guessFromName('02 - 夜航 - 测试歌手.flac');
  check('文件名解析「序号 - 歌名 - 歌手」', g2.title === '夜航' && g2.artist === '测试歌手', JSON.stringify(g2));
  const g3 = guessFromName('没有分隔符的歌名.wav');
  check('文件名解析「纯歌名」', g3.title === '没有分隔符的歌名' && g3.artist === '', JSON.stringify(g3));

  // ── 2. 扫描文件夹 ──
  const progress = [];
  const { tracks } = await scanFolder(musicDir, {
    onProgress: (p) => progress.push(p.phase),
  });
  check('扫描只收音频文件（跳过 .txt/.jpg）', tracks.length === 3, `tracks=${tracks.length}`);
  check('扫描上报了进度事件', progress.includes('tags') || progress.includes('done'), progress.join(','));

  const t0 = tracks.find((t) => t.title === '晨光');
  check('WAV 时长被正确读出', !!t0 && Math.abs(t0.duration - 2) <= 1, t0 ? `dur=${t0.duration}` : 'not found');
  check('文件名兜底歌名/歌手生效', !!t0 && t0.artist === '测试歌手', t0 ? `${t0.title} / ${t0.artist}` : '');
  check('子目录里的文件也被扫到', tracks.some((t) => t.title === '没有分隔符的歌名'));
  check('每个条目都有稳定 id', tracks.every((t) => typeof t.id === 'string' && t.id.startsWith('L')));

  // ── 3. Library 持久化 ──
  const libFile = path.join(TMP_ROOT, 'library.json');
  const lib = new Library(libFile);
  const up = lib.upsertLocal(tracks);
  check('入库新增 3 首', up.added === 3 && up.total === 3, JSON.stringify(up));
  lib.addFolder(musicDir, tracks.length);
  check('文件夹被记录', lib.folders().length === 1 && lib.folders()[0].count === 3);

  // 重新从磁盘加载，验证持久化
  const lib2 = new Library(libFile);
  check('重新加载后曲目还在', lib2.localTracks().length === 3, `n=${lib2.localTracks().length}`);

  // 重复扫描不应重复添加
  const up2 = lib2.upsertLocal(tracks);
  check('重复扫描不重复入库', up2.added === 0 && up2.updated === 3, JSON.stringify(up2));

  // ── 4. B 站曲目入库 + 歌单 ──
  lib2.addBili([
    { bvid: 'BV1GJ411x7h7', cid: 111, title: '测试 B 站曲目', artist: 'UP 主', duration: 212, cover: '' },
  ]);
  check('B 站曲目入库', lib2.biliTracks().length === 1);

  const pl = lib2.createPlaylist('我的测试歌单');
  const localIds = lib2.localTracks().map((t) => t.id);
  lib2.addToPlaylist(pl.id, 'local', localIds.slice(0, 2));
  lib2.addToPlaylist(pl.id, 'bili', ['BV1GJ411x7h7']);
  const resolved = lib2.resolvePlaylist(pl.id);
  check('歌单混合本地与 B 站曲目', resolved.tracks.length === 3, `n=${resolved.tracks.length}`);
  check('歌单顺序为加入顺序', resolved.tracks[0]._type === 'local' && resolved.tracks[2]._type === 'bili');

  // 去重
  const dup = lib2.addToPlaylist(pl.id, 'local', localIds.slice(0, 2));
  check('重复加入歌单被去重', dup.added === 0 && dup.total === 3, JSON.stringify(dup));

  // 移除歌单里的第 2 首
  lib2.removeFromPlaylist(pl.id, 1);
  check('从歌单移除一条', lib2.resolvePlaylist(pl.id).tracks.length === 2);

  // 删除本地曲目后歌单里也消失
  const beforePl = lib2.resolvePlaylist(pl.id).tracks.length;
  lib2.removeLocal([localIds[0]]);
  const afterPl = lib2.resolvePlaylist(pl.id).tracks.length;
  check('删除曲目会同步清出歌单', afterPl === beforePl - 1, `${beforePl} → ${afterPl}`);

  // ── 5. 文件丢失检测 ──
  const remaining = lib2.localTracks().map((t) => t.id);
  const missingCount = lib2.markMissing(remaining.filter((id) => id !== remaining[0]));
  check('能标记出丢失的文件', missingCount === 1, `marked=${missingCount}`);

  // ── 6. 本地代理服务文件 ──
  const proxy = new AudioProxy({ audioStreams: async () => [] });
  proxy.setLocalResolver((id) => {
    const t = lib2.getLocal(id);
    return t ? t.path : '';
  });
  await proxy.start();
  const target = lib2.localTracks().find((t) => !t.missing);
  check('找到可服务的本地曲目', !!target, target ? target.title : 'none');

  const url = proxy.localUrl(target.id);
  const full = await fetch(url);
  const fullBuf = Buffer.from(await full.arrayBuffer());
  check('整文件请求返回 200', full.status === 200, `status=${full.status}`);
  check(
    '返回了正确大小',
    Number(full.headers.get('content-length')) === target.size && fullBuf.length === target.size,
    `cl=${full.headers.get('content-length')} actual=${fullBuf.length} expect=${target.size}`,
  );
  check('content-type 是 audio/wav', (full.headers.get('content-type') || '').includes('audio/wav'), full.headers.get('content-type'));
  check('声明支持 Range', full.headers.get('accept-ranges') === 'bytes');
  check('文件头是 RIFF', fullBuf.slice(0, 4).toString() === 'RIFF', fullBuf.slice(0, 4).toString());

  const part = await rangeFetch(url, 0, 1023);
  const partBuf = Buffer.from(await part.arrayBuffer());
  check('Range 请求返回 206', part.status === 206, `status=${part.status}`);
  check('Range 长度正确', partBuf.length === 1024, `len=${partBuf.length}`);
  check(
    'content-range 正确',
    part.headers.get('content-range') === `bytes 0-1023/${target.size}`,
    part.headers.get('content-range'),
  );

  // 中段 Range（模拟拖动进度条）
  const midStart = Math.floor(target.size / 2);
  const mid = await rangeFetch(url, midStart, midStart + 4095);
  const midBuf = Buffer.from(await mid.arrayBuffer());
  check('中段 Range 返回 206', mid.status === 206, `status=${mid.status} start=${midStart} size=${target.size}`);
  check('中段 Range 长度正确', midBuf.length === 4096, `len=${midBuf.length}`);

  // 越界 Range 应 416
  const bad = await rangeFetch(url, target.size + 100, target.size + 200);
  check('越界 Range 返回 416', bad.status === 416, `status=${bad.status}`);

  // 未知 id 应 404
  const unknown = await fetch(proxy.localUrl('Lnotexist'));
  check('未知曲目返回 404', unknown.status === 404, `status=${unknown.status}`);

  // 无 token 应 403
  const noToken = await fetch(url.replace(/token=[^&]+/, 'token=wrong'));
  check('错误 token 返回 403', noToken.status === 403, `status=${noToken.status}`);

  // data: URL 封面直接透传
  const dataCover = proxy.coverUrl('data:image/png;base64,AAAA');
  check('data: 封面原样返回', dataCover === 'data:image/png;base64,AAAA');

  proxy.stop();

  // ── 7. B 站链接解析（纯字符串，不发网络请求） ──
  const { extractBiliRefs } = require('../src/bili');
  const c1 = extractBiliRefs('https://www.bilibili.com/video/BV1GJ411x7h7?p=3');
  check('链接里能取出 BV 号和 p 参数', c1.length === 1 && c1[0].bvid === 'BV1GJ411x7h7' && c1[0].page === 3, JSON.stringify(c1));

  const c2 = extractBiliRefs('BV1GJ411x7h7 BV2GJ411x7h7');
  check('多个 BV 号都能取出', c2.length === 2, `n=${c2.length}`);

  // ── 汇总 ──
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '─'.repeat(60));
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
  }
  console.log(`LIB_OK: ${failed.length === 0}`);

  // 清理素材（保留 library.json 供人工查看）
  await fsp.rm(path.join(TMP_ROOT, 'music'), { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本异常', e);
  process.exit(1);
});
