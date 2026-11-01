'use strict';
/**
 * 「我喜欢的歌」真实接口验证：跟随收藏夹 → 汇总 → 排除 → 取消跟随。
 * 用真实 B 站账号，但只读不写，最后回滚所有改动。
 * 跑法: node scripts/test-loved.js
 */
const path = require('node:path');
const fs = require('node:fs');
const { Bili, expandFavTracks } = require('../src/bili');
const { Library } = require('../src/library');

const DATA = path.join(__dirname, '..', '.userdata');
let pass = 0;
let fail = 0;

function ok(cond, label, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`);
  }
}

function rm(p) {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

async function main() {
  const bili = new Bili(DATA);

  // 用临时库文件，不碰真实数据
  const tmpLib = path.join(DATA, 'loved-test-library.json');
  rm(tmpLib);
  const library = new Library(tmpLib);

  console.log('\n=== 1. 登录与收藏夹 ===');
  const nav = await bili.nav();
  ok(nav.isLogin, '已登录', `mid=${nav.mid}`);
  if (!nav.isLogin) {
    console.log('\nLOVED_OK: false (未登录)');
    return;
  }
  const folders = await bili.favFolders(nav.mid);
  ok(Array.isArray(folders) && folders.length > 0, '拿到收藏夹列表', `${folders.length} 个`);
  for (const f of folders) console.log(`       - ${f.id}  ${f.title}  (${f.mediaCount})`);
  if (!folders.length) {
    console.log('\nLOVED_OK: false (无收藏夹)');
    return;
  }

  // 挑一个内容最多的收藏夹来验证
  const target = folders.slice().sort((a, b) => (b.mediaCount || 0) - (a.mediaCount || 0))[0];
  console.log(`\n=== 2. 跟随「${target.title}」(${target.id}) ===`);

  const { items } = await bili.favItems(target.id, { max: 600 });
  ok(Array.isArray(items) && items.length > 0, '抓到收藏夹条目', `${items.length} 条`);

  const bvids = items.map((i) => i.bvid).filter(Boolean);
  const metas = await bili.resolveMany(bvids, { concurrency: 4 });
  ok(metas.size > 0, '解析出元信息', `${metas.size}/${bvids.length}`);

  const tracks = expandFavTracks(items, metas);
  ok(tracks.length > 0, '展开成曲目', `${tracks.length} 首`);

  const multi = tracks.filter((t) => t.multiPage);
  console.log(`       其中多 P 拆出的分 P：${multi.length} 首`);
  if (multi.length) {
    const sample = multi.slice(0, 3);
    for (const t of sample) console.log(`       - ${t.id}  ${t.title}`);
    ok(
      sample.every((t) => /:p\d+$/.test(t.id)),
      '多 P 曲目 id 带分 P 后缀',
    );
    ok(
      sample.every((t) => t.cid > 0),
      '多 P 曲目都有 cid',
    );
    const byBvid = {};
    for (const t of multi) (byBvid[t.bvid] ||= []).push(t.cid);
    const dupCid = Object.values(byBvid).some((cids) => new Set(cids).size !== cids.length);
    ok(!dupCid, '同一视频下各分 P 的 cid 互不相同');
  }

  const r1 = library.followFolder(target.id, target.title, tracks);
  ok(r1.total === tracks.length, '入库曲目数一致', `${r1.total}`);
  ok(library.isFollowing(target.id), '已记录跟随状态');
  ok(library.favSources().length === 1, 'favSources 有 1 条');
  ok(library.favSources()[0].title === target.title, '跟随记录带收藏夹标题');

  console.log('\n=== 3. 我喜欢的歌汇总 ===');
  const loved = library.lovedTracks();
  ok(loved.length === tracks.length, '汇总数量 = 收藏夹曲目数', `${loved.length}`);
  ok(
    loved.every((t) => t._type === 'bili'),
    '全部标记为 bili 类型',
  );

  // 再加一个本地曲目和一个链接导入的曲目，验证三源合并
  library.upsertLocal([
    {
      id: 'Ltest0001',
      kind: 'local',
      bvid: '',
      path: path.join(DATA, 'fake.flac'),
      name: 'fake.flac',
      size: 1000,
      mtime: Date.now(),
      title: '本地测试曲',
      artist: '本地歌手',
      album: '本地专辑',
      duration: 100,
      cover: '',
      tagged: true,
      missing: false,
    },
  ]);
  library.addBili([
    {
      id: 'BVlinkTest01',
      bvid: 'BVlinkTest01',
      cid: 999,
      title: '链接导入曲',
      artist: '链接UP',
      cover: '',
      duration: 120,
      isMusic: true,
      addedAt: Date.now(),
    },
  ]);

  const loved2 = library.lovedTracks();
  ok(loved2.length === tracks.length + 2, '本地 + 链接 + 收藏夹三源合并', `${loved2.length}`);
  ok(
    loved2.some((t) => t._type === 'local' && t.title === '本地测试曲'),
    '本地曲目进汇总',
  );
  ok(
    loved2.some((t) => t._type === 'bili' && t.title === '链接导入曲'),
    '链接导入曲目进汇总',
  );

  console.log('\n=== 4. 移除与排除表 ===');
  const victim = loved2.find((t) => t._type === 'bili' && !t.multiPage) || loved2[0];
  const before = library.lovedTracks().length;
  library.excludeFromLoved(victim._type, victim.id);
  const after = library.lovedTracks();
  ok(after.length === before - 1, '移除后少一首', `${before} → ${after.length}`);
  ok(
    !after.some((t) => t.id === victim.id),
    '被移除的曲目不在汇总里',
  );
  ok(library.excludedCount() === 1, '排除表记录 1 条');
  // 移除只影响汇总，库里的曲目还在
  const stillThere = victim._type === 'local' ? library.getLocal(victim.id) : library.getBili(victim.id);
  ok(!!stillThere, '被移除的曲目仍留在库里');

  // 再跟随一次（模拟收藏夹同步），被移除的不应复活
  const r2 = library.followFolder(target.id, target.title, tracks);
  const after2 = library.lovedTracks();
  ok(
    !after2.some((t) => t.id === victim.id),
    '再次同步后仍保持移除状态',
    `added=${r2.added}`,
  );

  library.includeInLoved(victim._type, victim.id);
  ok(library.lovedTracks().length === before, '撤销移除后恢复');
  ok(library.excludedCount() === 0, '排除表清空');

  console.log('\n=== 5. 收藏夹内容变化跟随 ===');
  // 砍掉一半曲目模拟"收藏夹里删了歌"
  const half = tracks.slice(0, Math.max(1, Math.floor(tracks.length / 2)));
  const r3 = library.followFolder(target.id, target.title, half);
  ok(r3.removed > 0, '收藏夹少歌时会同步移除', `removed=${r3.removed}`);
  const after3 = library.lovedTracks().filter((t) => t._type === 'bili' && t.id !== 'BVlinkTest01');
  ok(after3.length === half.length, '汇总数量跟着收藏夹走', `${after3.length} vs ${half.length}`);

  console.log('\n=== 6. 取消跟随 ===');
  library.unfollowFolder(target.id);
  ok(!library.isFollowing(target.id), '跟随状态已清除');
  ok(library.favSources().length === 0, 'favSources 为空');
  const afterUnfollow = library.lovedTracks();
  ok(
    afterUnfollow.length === 2,
    '取消跟随只剩本地 + 链接导入',
    `${afterUnfollow.length}`,
  );

  console.log('\n=== 7. 持久化 ===');
  const reopened = new Library(tmpLib);
  ok(reopened.lovedTracks().length === 2, '重新打开后汇总数量不变');
  ok(reopened.stats().loved === 2, 'stats() 报告 loved 数量');
  ok(reopened.data.version === 2, '库文件版本升到 2');

  rm(tmpLib);
  console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}  ${pass} passed, ${fail} failed`);
  console.log(`\nLOVED_OK: ${fail === 0}`);
}

main().catch((e) => {
  console.log('FATAL', e);
  console.log('\nLOVED_OK: false');
  process.exit(1);
});
