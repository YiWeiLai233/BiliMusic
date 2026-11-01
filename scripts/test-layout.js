// 布局审计：检查溢出、遮挡、元素可见性
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.userdata');
fs.mkdirSync(DATA, { recursive: true });
const LOG = path.join(DATA, 'layout.log');
fs.writeFileSync(LOG, '');
const log = (...a) => {
  const line = a
    .map((x) => (x instanceof Error ? x.stack : typeof x === 'object' ? JSON.stringify(x) : String(x)))
    .join(' ');
  fs.appendFileSync(LOG, line + '\n');
};

const { Bili } = require('../src/bili');
const { AudioProxy } = require('../src/audioProxy');

app.setPath('userData', DATA);
app.setPath('sessionData', path.join(DATA, 'session'));
// 逐个尺寸销毁窗口，不能让默认的 window-all-closed 提前退出
app.on('window-all-closed', () => {});

const SIZES = [
  [1180, 760, 'default'],
  [920, 600, 'min'],
  [1600, 1000, 'wide'],
];

async function main() {
  const bili = new Bili(DATA);
  const proxy = new AudioProxy(bili);
  await proxy.start();
  ipcMain.handle('test:audio-url', async (_e, { bvid, cid, quality }) => {
    const streams = await bili.audioStreams(bvid, Number(cid));
    proxy.prime(bvid, Number(cid), streams);
    const chosen = streams[0];
    return {
      url: proxy.audioUrl(bvid, Number(cid), chosen?.id || ''),
      qualityId: chosen?.id || 0,
      qualityLabel: chosen?.label || '',
      available: streams.map((s) => ({ id: s.id, label: s.label })),
    };
  });
  await app.whenReady();

  for (const [w, h, tag] of SIZES) {
    const win = new BrowserWindow({
      width: w,
      height: h,
      show: false,
      frame: false,
      backgroundColor: '#0d0f13',
      webPreferences: {
        preload: path.join(__dirname, 'test-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
    await new Promise((r) => setTimeout(r, 2400));

    const audit = await win.webContents.executeJavaScript(`(() => {
      const q = (s) => document.querySelector(s);
      const rect = (s) => { const n = q(s); if (!n) return null; const r = n.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const vw = window.innerWidth, vh = window.innerHeight;
      const issues = [];

      const nodes = [
        ['titlebar', '.titlebar'], ['sidebar', '.sidebar'], ['content', '.content'],
        ['playerbar', '.playerbar'], ['song-list', '.song-list'], ['list-head', '.list-head'],
        ['content-head', '.content-head'], ['pb-left', '.pb-left'], ['pb-center', '.pb-center'],
        ['pb-right', '.pb-right'], ['progress', '.pb-progress'], ['search', '.search-box'],
        ['play-all', '#btn-play-all'], ['folder-title', '#folder-title'],
      ];
      const boxes = {};
      for (const [name, sel] of nodes) {
        const b = rect(sel);
        boxes[name] = b;
        if (!b) { issues.push('missing ' + name); continue; }
        if (b.x < -1 || b.y < -1) issues.push(name + ' offscreen at ' + b.x + ',' + b.y);
        if (b.x + b.w > vw + 1) issues.push(name + ' overflows right: ' + (b.x + b.w) + ' > ' + vw);
        if (b.y + b.h > vh + 1) issues.push(name + ' overflows bottom: ' + (b.y + b.h) + ' > ' + vh);
        if (b.w <= 0 || b.h <= 0) issues.push(name + ' zero size');
      }

      // 播放条是否压住内容：检查最后一行哨兵元素是否被遮挡
      const pb = boxes['playerbar'], sl = boxes['song-list'];
      if (pb && sl) {
        const rows = [...document.querySelectorAll('.song-row')];
        const last = rows[rows.length - 1];
        if (last) {
          const lr = last.getBoundingClientRect();
          if (lr.y + lr.height > pb.y + 1) issues.push('last row hidden behind playerbar: ' + Math.round(lr.y + lr.height) + ' > ' + pb.y);
        }
        const lastSentinel = sl.y + sl.height;
        if (lastSentinel < pb.y) issues.push('song-list ends before playerbar: ' + lastSentinel + ' < ' + pb.y);
      }

      // 三块播放条区域是否互相重叠
      const l = boxes['pb-left'], c = boxes['pb-center'], r = boxes['pb-right'];
      if (l && c && l.x + l.w > c.x) issues.push('pb-left overlaps pb-center');
      if (c && r && c.x + c.w > r.x) issues.push('pb-center overlaps pb-right');

      // 进度条可用宽度
      const pr = boxes['progress'];
      if (pr && pr.w < 200) issues.push('progress too narrow: ' + pr.w);

      // 文本是否被裁切（scrollWidth > clientWidth 且没有 ellipsis）
      const clipped = [];
      for (const n of document.querySelectorAll('#folder-title, .pb-title, #folder-sub')) {
        if (n.scrollWidth > n.clientWidth + 2) clipped.push(n.id || n.className);
      }

      // 横向滚动条
      if (document.documentElement.scrollWidth > vw + 1) issues.push('page horizontal scroll');
      if (document.body.scrollWidth > vw + 1) issues.push('body horizontal scroll');

      return { vw, vh, boxes, issues, clipped,
        scrollbarW: window.innerWidth - document.documentElement.clientWidth,
        listScrollable: (() => { const n = q('.song-list'); return n ? n.scrollHeight > n.clientHeight : false; })(),
      };
    })()`);

    log(`--- ${tag} ${w}x${h} ---`);
    log('  vw/vh:', audit.vw, audit.vh, 'scrollbarW:', audit.scrollbarW, 'listScrollable:', audit.listScrollable);
    for (const [k, v] of Object.entries(audit.boxes)) log(`  ${k.padEnd(14)} ${JSON.stringify(v)}`);
    log('  clipped:', audit.clipped);
    log('  ISSUES:', audit.issues.length ? audit.issues : 'none');

    fs.writeFileSync(path.join(DATA, `layout-${tag}.png`), (await win.webContents.capturePage()).toPNG());
    win.destroy();
    await new Promise((r) => setTimeout(r, 400));
  }

  log('LAYOUT_DONE');
  proxy.stop();
  app.exit(0);
}

main().catch((e) => {
  log('FATAL', e);
  try { app.exit(1); } catch { process.exit(1); }
});
