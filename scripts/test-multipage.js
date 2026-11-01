'use strict';
/**
 * 用真实 B 站接口验证多 P 拆分：
 *  1. extractBiliRefs 能从文本里抠出 BV 号和 ?p= 参数
 *  2. resolveLinks 对多 P 视频返回每个分 P 一条，id 是 `bvid:pN`
 *  3. 单 P 视频仍然只有一条，id 就是 bvid
 *
 * 跑法：node scripts/test-multipage.js
 */
const path = require('node:path');
const { Bili, extractBiliRefs } = require('../src/bili');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

async function main() {
  // ── 1. 链接解析 ──
  const cases = [
    ['BV1GJ411x7h7', 'BV1GJ411x7h7', 0],
    ['https://www.bilibili.com/video/BV1GJ411x7h7?spm_id_from=333', 'BV1GJ411x7h7', 0],
    ['https://www.bilibili.com/video/BV1GJ411x7h7?p=3', 'BV1GJ411x7h7', 3],
    ['https://b23.tv/BV1GJ411x7h7', 'BV1GJ411x7h7', 0],
    ['av170001', null, 0],
  ];
  for (const [input, wantBvid, wantPage] of cases) {
    const refs = extractBiliRefs(input);
    const r = refs[0] || {};
    check(
      `extractBiliRefs(${input.slice(0, 40)})`,
      refs.length > 0 && (!wantBvid || r.bvid === wantBvid) && (r.page || 0) === wantPage,
      JSON.stringify(refs),
    );
  }
  check('extractBiliRefs 一句里两个 BV', extractBiliRefs('BV1GJ411x7h7 和 BV1Lknb6fEnH').length === 2);
  check('extractBiliRefs 无关文本返回空', extractBiliRefs('今天天气不错').length === 0);

  const bili = new Bili(path.join(__dirname, '..', '.userdata'));

  // ── 2. 多 P 视频 ──
  // 样本来自真实收藏夹里确认过的多 P 视频（4 个分 P）
  const multiCandidates = ['BV1SknF6KE5g', 'BV1yrhU6tEPM'];
  let checkedMulti = false;

  for (const bvid of multiCandidates) {
    let meta;
    try {
      meta = await bili.videoInfo(bvid);
    } catch (e) {
      console.log(`SKIP  取不到 ${bvid} 的元信息：${e.message}`);
      continue;
    }
    const pages = meta.pages || [];
    console.log(`INFO  ${bvid}「${meta.title}」共 ${pages.length} 个分 P`);
    if (pages.length <= 1) {
      console.log('SKIP  这个视频只有一个分 P，换一个');
      continue;
    }

    const { tracks } = await bili.resolveLinks(`https://www.bilibili.com/video/${bvid}`);
    check(
      `${bvid} 拆出 ${pages.length} 条`,
      tracks.length === pages.length,
      `实际 ${tracks.length} 条`,
    );
    check(
      `${bvid} 每条 id 都带分 P 后缀`,
      tracks.every((t) => t.id === `${bvid}:p${t.page}`),
      tracks.map((t) => t.id).join(', '),
    );
    check(
      `${bvid} 每条 cid 各不相同`,
      new Set(tracks.map((t) => t.cid)).size === tracks.length,
      tracks.map((t) => t.cid).join(', '),
    );
    check(
      `${bvid} 标题带 P 序号`,
      tracks.every((t, i) => t.title.includes(`P${i + 1}`)),
      tracks[0]?.title,
    );

    // 指定 ?p=2 时只取那一 P
    const one = await bili.resolveLinks(`https://www.bilibili.com/video/${bvid}?p=2`);
    check(
      `${bvid} ?p=2 只取一 P`,
      one.tracks.length === 1 && one.tracks[0].page === 2 && one.tracks[0].id === `${bvid}:p2`,
      JSON.stringify(one.tracks.map((t) => t.id)),
    );
    checkedMulti = true;
    break;
  }

  if (!checkedMulti) {
    console.log('WARN  没有可用的多 P 视频样本，多 P 相关断言已跳过');
  }

  // ── 3. 单 P 视频不受影响 ──
  const single = await bili.resolveLinks('https://www.bilibili.com/video/BV1GJ411x7h7');
  check(
    '单 P 视频只有一条且 id 是裸 bvid',
    single.tracks.length === 1 && single.tracks[0].id === 'BV1GJ411x7h7',
    JSON.stringify(single.tracks.map((t) => t.id)),
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  console.log('MULTIPAGE_OK:', failed.length === 0);
  process.exit(failed.length === 0 ? 0 : 3);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
