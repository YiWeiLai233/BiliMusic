'use strict';
/**
 * 桌面端无服务器同步的端到端测试。
 * 跑法：node scripts/test-sync.js
 *
 * 覆盖：
 *   1. 编解码往返 / 坏数据拒绝
 *   2. library.data ↔ SyncDoc 双向投影不丢信息
 *   3. 两台桌面端（不同 deviceId）合并收敛
 *   4. 与安卓端同构的 SyncDoc（手工按 Kotlin 序列化形状构造）能合并进来
 *   5. 歌单增删改 / 拖动排序后两端一致
 *   6. 跨端 HTTP 交换（起真服务端 + 真客户端）
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Library } = require('../src/library');
const { Codec, Pos, Merger, Hlc, crc32 } = require('../src/sync');
const { SyncBridge, SyncService, exchange, sameCore } = require('../src/syncBridge');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`);
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

const TMP = path.join(os.tmpdir(), 'bili-sync-test-' + process.pid);

function newLib(name) {
  fs.mkdirSync(TMP, { recursive: true });
  const lib = new Library(path.join(TMP, name + '.json'));
  return lib;
}

function newBridge(lib, name, id) {
  return new SyncBridge({
    library: lib,
    file: path.join(TMP, name + '-sync.json'),
    deviceId: id,
    deviceName: name,
  });
}

/** 造一个看起来像 B 站曲目的条目 */
function biliTrack(id, title) {
  return {
    id,
    bvid: id.split(':')[0],
    cid: 123,
    page: id.includes(':p') ? Number(id.split(':p')[1]) : 1,
    title,
    artist: 'UP 主',
    cover: 'https://i0.hdslb.com/bfs/archive/x.jpg',
    duration: 200,
    addedAt: Date.now(),
  };
}

(async () => {
  await fsp.rm(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // ───────────────────────── 1. 编解码
  {
    const doc = {
      version: 1,
      deviceId: 'd1',
      deviceName: 'PC',
      at: Date.now(),
      tracks: {
        'bili:BV1xx411c7mD': {
          core: {
            v: {
              key: 'bili:BV1xx411c7mD',
              type: 'bili',
              id: 'BV1xx411c7mD',
              bvid: 'BV1xx411c7mD',
              cid: 1,
              page: 1,
              title: '测试歌',
              artist: 'UP',
              cover: '',
              duration: 100,
              partCount: 1,
            },
            ts: { wall: 1700000000000, counter: 0 },
            by: 'd1',
          },
          present: { v: true, ts: { wall: 1700000000000, counter: 0 }, by: 'd1' },
        },
      },
      playlists: {},
      marks: {},
    };
    const code = Codec.encode(doc);
    check('encode 产出非空串', typeof code === 'string' && code.length > 0);
    check('code 只有 base64url 字符', /^[A-Za-z0-9_-]+$/.test(code), code.slice(0, 40));
    const back = Codec.decode(code);
    eq('编解码往返：tracks 键一致', Object.keys(back.tracks), Object.keys(doc.tracks));
    check('编解码往返：core 内容一致', sameCore(back.tracks['bili:BV1xx411c7mD'].core.v, doc.tracks['bili:BV1xx411c7mD'].core.v));
    eq('编解码往返：时间戳一致', back.tracks['bili:BV1xx411c7mD'].core.ts, { wall: 1700000000000, counter: 0 });

    // 坏数据
    let bad = 0;
    try {
      Codec.unpack(Buffer.from([0x42, 0x4d, 1, 0, 1, 1, 0, 0, 0, 0]));
      bad++;
    } catch (_) {}
    try {
      Codec.decode('这不是同步码');
      bad++;
    } catch (_) {}
    check('坏数据都被拒绝', bad === 0);

    // CRC 校验：改一个字节应当失败
    const packed = Codec.pack(doc);
    packed[packed.length - 1] ^= 0xff;
    let crcCaught = false;
    try {
      Codec.unpack(packed);
    } catch (_) {
      crcCaught = true;
    }
    check('载荷被篡改后 CRC 报错', crcCaught);
  }

  // ───────────────────────── 2. library ↔ doc 投影
  {
    const lib = newLib('proj');
    lib.addBili([biliTrack('BV1aa411c7m1', '第一首')], '');
    const b2 = lib.createPlaylist('我的歌单');
    lib.addToPlaylist(b2.id, 'bili', ['BV1aa411c7m1']);
    lib.addToLoved('bili', lib.getBili('BV1aa411c7m1'));

    const bridge = newBridge(lib, 'proj', 'desk1');
    check('captureLocal 首次有改动', bridge.captureLocal() === true);
    check('captureLocal 第二次无改动', bridge.captureLocal() === false);

    const doc = bridge.doc;
    check('doc 里有曲目', !!doc.tracks['bili:BV1aa411c7m1'], Object.keys(doc.tracks).join(','));
    check('doc 里有歌单', !!doc.playlists[b2.id], Object.keys(doc.playlists).join(','));
    eq('歌单标题正确', doc.playlists[b2.id].title.v, '我的歌单');
    eq('歌单里有一条', Object.keys(doc.playlists[b2.id].items), ['bili:BV1aa411c7m1']);
    check('doc 里有爱心标记', doc.marks['bili:BV1aa411c7m1'] && doc.marks['bili:BV1aa411c7m1'].loved.v === true);

    // 反向：清空 library 再由 doc 恢复
    const lib2 = newLib('proj2');
    const bridge2 = new SyncBridge({
      library: lib2,
      file: path.join(TMP, 'proj2-sync.json'),
      deviceId: 'desk2',
      deviceName: 'desk2',
    });
    bridge2.mergeRemote(Codec.decode(Codec.encode(bridge.exportCompact())));
    check('反向恢复：曲目回到 library', !!lib2.getBili('BV1aa411c7m1'));
    const pls = lib2.playlists();
    check('反向恢复：歌单回来了', pls.length === 1 && pls[0].title === '我的歌单', JSON.stringify(pls.map((p) => p.title)));
    eq('反向恢复：歌单项一致', pls[0].items, [{ type: 'bili', id: 'BV1aa411c7m1' }]);
    check('反向恢复：爱心一致', lib2.isLoved('bili', 'BV1aa411c7m1'));
  }

  // ───────────────────────── 3. 两台桌面端合并
  {
    const A = newLib('mA');
    const B = newLib('mB');
    A.addBili([biliTrack('BV1aa411c7m2', '甲')], '');
    B.addBili([biliTrack('BV1bb411c7m3', '乙')], '');

    const ba = newBridge(A, 'mA', 'devA');
    const bb = newBridge(B, 'mB', 'devB');
    ba.captureLocal();
    bb.captureLocal();

    ba.mergeRemote(Codec.decode(Codec.encode(bb.exportCompact())));
    bb.mergeRemote(Codec.decode(Codec.encode(ba.exportCompact())));
    ba.mergeRemote(Codec.decode(Codec.encode(bb.exportCompact())));

    const keysA = Object.keys(A.data.bili).sort();
    const keysB = Object.keys(B.data.bili).sort();
    eq('两轮往返后曲目集合一致', keysA, keysB);
    check('两边都有两首歌', keysA.length === 2, keysA.join(','));

    // 幂等：再合并一次不应再变化
    const before = JSON.stringify(ba.doc.tracks);
    ba.mergeRemote(Codec.decode(Codec.encode(bb.exportCompact())));
    eq('幂等：重复合并不产生改动', JSON.stringify(ba.doc.tracks), before);
  }

  // ───────────────────────── 4. 安卓同构文档
  {
    const lib = newLib('android');
    const bridge = newBridge(lib, 'android', 'deskX');
    // 完全按 Kotlin @Serializable 的形状手写一份 —— 这就是手机发过来的东西
    const androidDoc = {
      version: 1,
      deviceId: 'd1a2b3c4d5e',
      deviceName: 'Pixel 7',
      at: 1762500000000,
      tracks: {
        'bili:BV1yrhU6tEPM:p1': {
          core: {
            v: {
              key: 'bili:BV1yrhU6tEPM:p1',
              type: 'bili',
              id: 'BV1yrhU6tEPM:p1',
              bvid: 'BV1yrhU6tEPM',
              cid: 900001,
              page: 1,
              title: '某个合集 · P1 开场',
              artist: '某 UP',
              cover: 'https://i0.hdslb.com/a.jpg',
              duration: 180,
              partCount: 18,
            },
            ts: { wall: 1762500000000, counter: 0 },
            by: 'd1a2b3c4d5e',
          },
          present: { v: true, ts: { wall: 1762500000000, counter: 0 }, by: 'd1a2b3c4d5e' },
        },
      },
      playlists: {
        pabc123: {
          id: 'pabc123',
          title: { v: '手机上建的单', ts: { wall: 1762500000001, counter: 0 }, by: 'd1a2b3c4d5e' },
          createdAt: 1762500000001,
          present: { v: true, ts: { wall: 1762500000001, counter: 0 }, by: 'd1a2b3c4d5e' },
          items: {
            'bili:BV1yrhU6tEPM:p1': {
              key: 'bili:BV1yrhU6tEPM:p1',
              pos: { v: '12', ts: { wall: 1762500000002, counter: 0 }, by: 'd1a2b3c4d5e' },
              present: { v: true, ts: { wall: 1762500000002, counter: 0 }, by: 'd1a2b3c4d5e' },
              addedAt: 1762500000002,
            },
          },
        },
      },
      marks: {
        'bili:BV1yrhU6tEPM:p1': {
          key: 'bili:BV1yrhU6tEPM:p1',
          loved: { v: true, ts: { wall: 1762500000003, counter: 0 }, by: 'd1a2b3c4d5e' },
          at: 1762500000003,
        },
      },
    };
    const d = bridge.mergeRemote(androidDoc);
    check('安卓文档带来 1 首新歌', d.newTracks === 1, JSON.stringify(d));
    check('安卓歌单落进 library', !!lib.getPlaylist('pabc123'));
    eq('安卓歌单项 id 正确', lib.getPlaylist('pabc123').items, [{ type: 'bili', id: 'BV1yrhU6tEPM:p1' }]);
    const t = lib.getBili('BV1yrhU6tEPM:p1');
    check('多 P 曲目标记为 multiPage', t && t.multiPage === true, JSON.stringify(t && t.multiPage));
    check('曲目 title 保留', t && t.title === '某个合集 · P1 开场', t && t.title);
    check('爱心被带回', lib.isLoved('bili', 'BV1yrhU6tEPM:p1'));

    // 手机发过来之后，桌面端不该把它又顶回去
    const changed = bridge.captureLocal();
    check('合并后 captureLocal 不产生新写入', changed === false);
  }

  // ───────────────────────── 5. 歌单顺序
  {
    const lib = newLib('order');
    lib.addBili(
      [biliTrack('BV1aa411c7m4', '一'), biliTrack('BV1bb411c7m5', '二'), biliTrack('BV1cc411c7m6', '三')],
      ''
    );
    const p = lib.createPlaylist('顺序测');
    lib.addToPlaylist(p.id, 'bili', ['BV1aa411c7m4', 'BV1bb411c7m5', 'BV1cc411c7m6']);

    const bridge = newBridge(lib, 'order', 'dO');
    bridge.captureLocal();
    eq('顺序：doc 里三条按加入顺序', Object.keys(bridge.doc.playlists[p.id].items).length, 3);
    eq(
      '顺序：位置键单调递增',
      Object.values(bridge.doc.playlists[p.id].items)
        .sort((a, b) => Pos.compare(Pos.decode(a.pos.v), Pos.decode(b.pos.v)))
        .map((i) => i.key),
      ['bili:BV1aa411c7m4', 'bili:BV1bb411c7m5', 'bili:BV1cc411c7m6']
    );

    // 拖动：把第三条挪到最前
    lib.moveInPlaylist(p.id, 2, 0);
    bridge.captureLocal();
    eq(
      '顺序：拖动后 doc 顺序跟着变',
      Object.values(bridge.doc.playlists[p.id].items)
        .sort((a, b) => Pos.compare(Pos.decode(a.pos.v), Pos.decode(b.pos.v)))
        .map((i) => i.key),
      ['bili:BV1cc411c7m6', 'bili:BV1aa411c7m4', 'bili:BV1bb411c7m5']
    );
    eq(
      '顺序：library 里的数组也还是对的',
      lib.getPlaylist(p.id).items.map((i) => i.id),
      ['BV1cc411c7m6', 'BV1aa411c7m4', 'BV1bb411c7m5']
    );

    // 另一端拿到这份 doc，顺序应当一致
    const lib2 = newLib('order2');
    const bridge2 = newBridge(lib2, 'order2', 'dO2');
    bridge2.mergeRemote(Codec.decode(Codec.encode(bridge.exportCompact())));
    eq('顺序：另一端渲染顺序一致', lib2.getPlaylist(p.id).items.map((i) => i.id), [
      'BV1cc411c7m6',
      'BV1aa411c7m4',
      'BV1bb411c7m5',
    ]);
  }

  // ───────────────────────── 6. 删除不复活
  {
    const A = newLib('dA');
    const B = newLib('dB');
    A.addBili([biliTrack('BV1dd411c7m7', '会被删的')], '');
    const p = A.createPlaylist('删测');
    A.addToPlaylist(p.id, 'bili', ['BV1dd411c7m7']);

    const ba = newBridge(A, 'dA', 'devDelA');
    const bb = newBridge(B, 'dB', 'devDelB');
    ba.captureLocal();
    bb.mergeRemote(Codec.decode(Codec.encode(ba.exportCompact())));
    check('删除前 B 有这首歌', !!B.getBili('BV1dd411c7m7'));

    // A 删歌单 + 删曲目
    A.deletePlaylist(p.id);
    A.removeBili(['BV1dd411c7m7']);
    ba.captureLocal();

    bb.mergeRemote(Codec.decode(Codec.encode(ba.exportCompact())));
    check('删除传播：B 的歌单没了', !B.getPlaylist(p.id));
    check('删除传播：B 的曲目没了', !B.getBili('BV1dd411c7m7'));

    // B 再发回 A，不能复活
    ba.mergeRemote(Codec.decode(Codec.encode(bb.exportCompact())));
    check('墓碑生效：A 也没有', !A.getBili('BV1dd411c7m7') && !A.getPlaylist(p.id));
  }

  // ───────────────────────── 7. 真 HTTP 交换
  {
    const A = newLib('httpA');
    const B = newLib('httpB');
    A.addBili([biliTrack('BV1ee411c7m8', 'HTTP 甲')], '');
    B.addBili([biliTrack('BV1ff411c7m9', 'HTTP 乙')], '');

    const sa = new SyncService({
      library: A,
      file: path.join(TMP, 'httpA-sync.json'),
      deviceId: 'httpA',
      deviceName: 'A机',
    });
    const sb = new SyncService({
      library: B,
      file: path.join(TMP, 'httpB-sync.json'),
      deviceId: 'httpB',
      deviceName: 'B机',
    });

    const infoA = await sa.startServer();
    check('服务端启动拿到端口', infoA.port > 0, String(infoA.port));
    const payload = sa.pairingPayload();
    check('配对串格式正确', /^bilimusic:\/\/pair\?ip=.+&port=\d+&token=[a-z0-9]{12}$/.test(payload), payload);

    const r = await exchange('127.0.0.1', infoA.port, infoA.token, sb.bridge.exportCompact());
    sb.bridge.mergeRemote(r.remote);
    await exchange('127.0.0.1', infoA.port, infoA.token, sb.bridge.exportCompact());

    check('HTTP 交换后 A 有乙', !!A.getBili('BV1ff411c7m9'), Object.keys(A.data.bili).join(','));
    check('HTTP 交换后 B 有甲', !!B.getBili('BV1ee411c7m8'), Object.keys(B.data.bili).join(','));

    // 错误口令
    let rejected = false;
    try {
      await exchange('127.0.0.1', infoA.port, 'wrong-token-xx', sb.bridge.exportCompact());
    } catch (e) {
      rejected = /403/.test(e.message);
    }
    check('错误口令被拒绝', rejected);

    sa.stopServer();
    sb.stopServer();
  }

  // ───────────────────────── 8. 文本同步码
  {
    const A = newLib('codeA');
    A.addBili([biliTrack('BV1gg411c7ma', '码甲')], '');
    const sa = new SyncService({ library: A, file: path.join(TMP, 'codeA-sync.json'), deviceId: 'cA', deviceName: '码A' });
    const code = sa.exportCode();
    check('同步码非空', code.length > 10, String(code.length));

    const B = newLib('codeB');
    const sb = new SyncService({ library: B, file: path.join(TMP, 'codeB-sync.json'), deviceId: 'cB', deviceName: '码B' });
    const ret = sb.importCode(code);
    check('导入同步码成功', ret.ok === true, JSON.stringify(ret));
    check('导入后 B 有曲目', !!B.getBili('BV1gg411c7ma'));

    let badImport = false;
    try {
      sb.importCode('这不是码');
    } catch (_) {
      badImport = true;
    }
    const ret2 = sb.importCode('这不是码');
    check('坏码返回失败而不是崩', ret2.ok === false, JSON.stringify(ret2));
  }

  // ───────────────────────── 9. 与安卓端的真实互通
  //
  // 两端各有一套编解码实现（Kotlin / Node）。各自跑自己的 roundtrip 只能说明
  // 各自自洽，**证明不了互通**。这里解一份安卓单测真正写出来的字节，
  // 字段名或编码一变就立刻红。
  {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'android-sync-code.txt');
    const exists = fs.existsSync(fixturePath);
    check('安卓 fixture 存在', exists, fixturePath);

    if (exists) {
      const text = fs.readFileSync(fixturePath, 'utf8').trim();
      let doc = null;
      try {
        doc = Codec.decode(text);
      } catch (e) {
        check('能解出安卓写的同步码', false, e.message);
      }
      if (doc) {
        check('能解出安卓写的同步码', true);
        check('设备名读得对', doc.deviceName === 'FIXTURE-ANDROID', doc.deviceName);
        check('设备 id 读得对', doc.deviceId === 'd0000000002', doc.deviceId);

        const live = Object.entries(doc.tracks).filter(([, v]) => v.present.v);
        check('曲目数正确', live.length === 2, String(live.length));

        const p2 = doc.tracks['bili:BV1fx411c7mD:p2'];
        check('多 P 曲目在', !!p2);
        if (p2) {
          check('分 P 序号正确', p2.core.v.page === 2, String(p2.core.v.page));
          check('总 P 数正确', p2.core.v.partCount === 2, String(p2.core.v.partCount));
          check('分 P 标题正确', p2.core.v.title === '夜曲 · P2 伴奏版', p2.core.v.title);
        }

        const commute = Object.values(doc.playlists).find((p) => p.title.v === '通勤');
        check('歌单「通勤」在', !!commute);
        if (commute) {
          const keys = Object.values(commute.items)
            .filter((i) => i.present.v)
            .sort((a, b) => Pos.compare(Pos.decode(a.pos.v), Pos.decode(b.pos.v)))
            .map((i) => i.key);
          check(
            '歌单顺序与安卓一致',
            keys.join('|') === 'bili:BV1fx411c7mD|bili:BV1fx411c7mD:p2',
            keys.join('|')
          );
        }

        check('爱心同步过来了', doc.marks['bili:BV1fx411c7mD']?.loved?.v === true);

        // 真的合进一个本地库，确认安卓来的数据能落成桌面端可用的条目
        const C = newLib('interop');
        const sc = new SyncService({ library: C, file: path.join(TMP, 'interop-sync.json'), deviceId: 'dI', deviceName: '互通' });
        const r = sc.importCode(text);
        check('导入安卓同步码成功', r.ok === true, JSON.stringify(r));
        const t = C.getBili('BV1fx411c7mD:p2');
        check('桌面库拿到多 P 曲目', !!t);
        if (t) {
          check('曲目标题落对了', t.title === '夜曲 · P2 伴奏版', t.title);
          check('艺术家落对了', t.artist === '周同学', t.artist);
        }
        check('桌面库拿到歌单', C.playlists().some((p) => p.title === '通勤'));
      }
    }
  }

  // ───────────────────────── 汇总
  await fsp.rm(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log('  FAIL ' + f.name + (f.detail ? '  — ' + f.detail : ''));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试崩溃:', e);
  process.exit(1);
});
