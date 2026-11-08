'use strict';
/**
 * 生成一份「桌面端产出的同步码」给安卓单测当固定样例。
 *
 * 为什么要这个：两端各有一套编解码实现（Kotlin / Node），只各自跑自己的
 * roundtrip 测试是证明不了互通的——得让安卓真的去解一份桌面端写出来的字节。
 * 反过来（安卓 → 桌面）由 android 的单测写出 fixture，本仓库的
 * scripts/test-sync.js 会顺带读它。
 *
 * 跑法：node scripts/gen-sync-fixture.js
 * 产物：android/app/src/test/resources/desktop-sync-code.txt
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Library } = require('../src/library');
const { SyncService } = require('../src/syncBridge');

const OUT = path.join(__dirname, '..', 'android', 'app', 'src', 'test', 'resources', 'desktop-sync-code.txt');

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-fixture-'));
  const lib = new Library(path.join(dir, 'library.json'));

  // 固定内容，别用真实 .userdata：那份会随使用变化，fixture 就没法当样例了
  lib.addBili(
    [
      {
        id: 'BV1fx411c7mD',
        bvid: 'BV1fx411c7mD',
        cid: 111,
        page: 1,
        title: '夜曲',
        artist: '周同学',
        cover: 'https://i0.hdslb.com/bfs/archive/a.jpg',
        duration: 227,
        multiPage: false,
        partCount: 1,
      },
      {
        id: 'BV1fx411c7mD:p2',
        bvid: 'BV1fx411c7mD',
        cid: 222,
        page: 2,
        title: '夜曲 · P2 伴奏版',
        artist: '周同学',
        cover: 'https://i0.hdslb.com/bfs/archive/a.jpg',
        duration: 225,
        multiPage: true,
        partCount: 2,
      },
    ],
    '4469944130'
  );

  // createPlaylist 返回的是歌单对象（不是 id），别搞错了
  const commute = lib.createPlaylist('通勤');
  lib.addToPlaylist(commute.id, 'bili', ['BV1fx411c7mD', 'BV1fx411c7mD:p2']);
  const night = lib.createPlaylist('深夜');
  lib.addToPlaylist(night.id, 'bili', ['BV1fx411c7mD:p2']);
  lib.addToLoved('bili', { id: 'BV1fx411c7mD', bvid: 'BV1fx411c7mD', title: '夜曲' });

  const svc = new SyncService({
    library: lib,
    file: path.join(dir, 'sync-state.json'),
    deviceId: 'd0000000001',
    deviceName: 'FIXTURE-PC',
  });
  svc.bridge.captureLocal();
  const code = svc.exportCode();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, code + '\n', 'utf8');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`wrote ${OUT}`);
  console.log(`code length = ${code.length}`);
}

main();
