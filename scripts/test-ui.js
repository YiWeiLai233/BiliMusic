// UI 自检：用假数据 preload 加载真实 renderer，跑完整流程并截图
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.userdata');
fs.mkdirSync(DATA, { recursive: true });
const LOG = path.join(DATA, 'ui-test.log');
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
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function main() {
  const bili = new Bili(DATA);
  const proxy = new AudioProxy(bili);
  await proxy.start();

  // 让测试 preload 能拿到真实播放地址
  ipcMain.handle('test:audio-url', async (_e, { bvid, cid, quality }) => {
    const streams = await bili.audioStreams(bvid, Number(cid));
    proxy.prime(bvid, Number(cid), streams);
    const q = quality ? String(quality) : '';
    const chosen = (q && streams.find((s) => String(s.id) === q)) || streams[0];
    return {
      url: proxy.audioUrl(bvid, Number(cid), chosen?.id || ''),
      qualityId: chosen?.id || 0,
      qualityLabel: chosen?.label || '',
      available: streams.map((s) => ({ id: s.id, label: s.label })),
    };
  });

  // 本地音乐：主进程起一个临时 WAV，让渲染进程真的能通过代理播它
  const tmpMusic = path.join(DATA, 'ui-local.wav');
  {
    const rate = 44100;
    const samples = rate * 3;
    const dataSize = samples * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < samples; i++) {
      buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 9000), 44 + i * 2);
    }
    fs.writeFileSync(tmpMusic, buf);
  }
  proxy.setLocalResolver((id) => (id === 'Ltest1' || id === 'Ltest2' ? tmpMusic : ''));
  ipcMain.handle('test:local-url', async (_e, { id }) => proxy.localUrl(id));

  await app.whenReady();

  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    frame: false,
    backgroundColor: '#0d0f13',
    webPreferences: {
      preload: path.join(__dirname, 'test-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.webContents.on('console-message', (_e, level, msg, lineNo, src) => {
    log(`[renderer:${level}] ${msg} (${src}:${lineNo})`);
  });
  win.webContents.on('preload-error', (_e, p, err) => log('preload-error', p, err && err.message));

  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  log('loaded');
  await new Promise((r) => setTimeout(r, 2200));

  const s1 = await win.webContents.executeJavaScript(`(() => ({
    step: 'after-boot',
    user: document.getElementById('user-name').textContent,
    folders: document.querySelectorAll('#folder-list .folder-item').length,
    folderTitles: [...document.querySelectorAll('#folder-list .folder-name')].map(n => n.textContent),
    header: document.getElementById('folder-title').textContent,
    sub: document.getElementById('folder-sub').textContent,
    rows: document.querySelectorAll('.song-row').length,
    rowTitles: [...document.querySelectorAll('.s-title')].map(n => n.textContent),
  }))()`);
  log('S1', s1);

  // 等后台 resolve 完成（假数据 2 批）
  await new Promise((r) => setTimeout(r, 2500));
  const s2 = await win.webContents.executeJavaScript(`(() => ({
    step: 'after-resolve',
    rows: document.querySelectorAll('.song-row').length,
    titles: [...document.querySelectorAll('.s-title')].map(n => n.textContent),
    sub: document.getElementById('folder-sub').textContent,
  }))()`);
  log('S2', s2);

  // 点第一行播放
  await win.webContents.executeJavaScript(`document.querySelector('.song-row').click()`);
  await new Promise((r) => setTimeout(r, 6000));
  const s3 = await win.webContents.executeJavaScript(`(() => {
    const a = document.getElementById('audio');
    return {
      step: 'after-play',
      pbTitle: document.getElementById('pb-title').textContent,
      pbArtist: document.getElementById('pb-artist').textContent,
      playing: !a.paused,
      dur: a.duration,
      ct: a.currentTime,
      err: a.error && a.error.code,
      qLabel: document.getElementById('q-label').textContent,
      total: document.getElementById('time-total').textContent,
      cur: document.getElementById('time-cur').textContent,
      idx: document.querySelectorAll('.song-row.playing').length,
      playIcon: document.getElementById('icon-play').innerHTML.slice(0, 40),
    };
  })()`);
  log('S3', s3);

  fs.writeFileSync(path.join(DATA, 'ui-playing.png'), (await win.webContents.capturePage()).toPNG());

  // 搜索过滤
  await win.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('search-input');
    s.value = '夜跑';
    s.dispatchEvent(new Event('input'));
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const s4 = await win.webContents.executeJavaScript(`(() => ({
    step: 'after-search',
    rows: document.querySelectorAll('.song-row').length,
    titles: [...document.querySelectorAll('.s-title')].map(n => n.textContent),
  }))()`);
  log('S4', s4);

  // 清空搜索 + 切收藏夹（此时正在播放第一首，切过去后高亮不能错位）
  await win.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('search-input');
    s.value = '';
    s.dispatchEvent(new Event('input'));
    document.querySelectorAll('#folder-list .folder-item')[1].click();
  })()`);
  await new Promise((r) => setTimeout(r, 1800));
  const s5 = await win.webContents.executeJavaScript(`(() => ({
    step: 'after-folder-switch',
    header: document.getElementById('folder-title').textContent,
    rows: document.querySelectorAll('.song-row').length,
    playingRows: document.querySelectorAll('.song-row.playing').length,
    playingIndex: document.querySelector('.song-row.playing')?.dataset.i ?? '',
    audioStillPlaying: !document.getElementById('audio').paused,
    audioTitle: document.getElementById('pb-title').textContent,
    active: document.querySelectorAll('#folder-list .folder-item.active .folder-name').length
      ? document.querySelector('#folder-list .folder-item.active .folder-name').textContent : '',
  }))()`);
  log('S5', s5);
  fs.writeFileSync(path.join(DATA, 'ui-folder2.png'), (await win.webContents.capturePage()).toPNG());

  // 空列表时按空格 / 点播放：不能崩，也不能误播别的歌
  await win.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('search-input');
    s.value = 'zzz不存在的关键词';
    s.dispatchEvent(new Event('input'));
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  await win.webContents.executeJavaScript(`document.getElementById('btn-play').click()`);
  await new Promise((r) => setTimeout(r, 700));
  const s6 = await win.webContents.executeJavaScript(`(() => ({
    step: 'empty-list-actions',
    rows: document.querySelectorAll('.song-row').length,
    toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent,
    playing: !document.getElementById('audio').paused,
    currentSrc: (document.getElementById('audio').currentSrc || '').slice(0, 30),
    pbTitle: document.getElementById('pb-title').textContent,
  }))()`);
  log('S6', s6);

  // ── S7：手动「音乐」标记 ────────────────────────────────────────────
  // 回到收藏夹 1001，清搜索，关掉「仅音乐」让被过滤的 BV2 露出来
  await win.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('search-input');
    s.value = '';
    s.dispatchEvent(new Event('input'));
    document.querySelectorAll('#folder-list .folder-item')[0].click();
  })()`);
  await new Promise((r) => setTimeout(r, 1600));
  await win.webContents.executeJavaScript(`(() => {
    const c = document.getElementById('chk-only-music');
    c.checked = false;
    c.dispatchEvent(new Event('change'));
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  const s7a = await win.webContents.executeJavaScript(`(() => ({
    step: 'marks-off-shows-all',
    rows: document.querySelectorAll('.song-row').length,
    markButtons: document.querySelectorAll('.s-mark').length,
    // BV2 自动判定为非音乐 → 标记按钮应带 auto 之外的样式（空）
    targets: [...document.querySelectorAll('.song-row')].map(r => ({
      title: r.querySelector('.s-title').textContent,
      markCls: r.querySelector('.s-mark').className,
    })),
  }))()`);
  log('S7a', s7a);

  // 点 BV2 那一行的 ♪ → 标为音乐
  await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.song-row')];
    const row = rows.find(r => r.querySelector('.s-title').textContent.includes('非音乐视频'));
    row.querySelector('.s-mark').click();
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  const s7b = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.song-row')];
    const row = rows.find(r => r.querySelector('.s-title').textContent.includes('非音乐视频'));
    return {
      step: 'marked-as-music',
      found: !!row,
      markCls: row ? row.querySelector('.s-mark').className : '',
      title: row ? row.querySelector('.s-title').textContent : '',
      markTitle: row ? row.querySelector('.s-mark').title : '',
    };
  })()`);
  log('S7b', s7b);

  // 重新打开「仅音乐」：手动标为音乐的 BV2 必须留下列表
  await win.webContents.executeJavaScript(`(() => {
    const c = document.getElementById('chk-only-music');
    c.checked = true;
    c.dispatchEvent(new Event('change'));
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const s7c = await win.webContents.executeJavaScript(`(() => ({
    step: 'only-music-keeps-manual',
    rows: document.querySelectorAll('.song-row').length,
    titles: [...document.querySelectorAll('.s-title')].map(n => n.textContent),
    markedRowPresent: [...document.querySelectorAll('.s-title')].some(n => n.textContent.includes('非音乐视频')),
  }))()`);
  log('S7c', s7c);
  fs.writeFileSync(path.join(DATA, 'ui-marked.png'), (await win.webContents.capturePage()).toPNG());

  // 再点一次 → 标为非音乐 → 「仅音乐」下应被隐藏
  await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.song-row')];
    const row = rows.find(r => r.querySelector('.s-title').textContent.includes('非音乐视频'));
    if (row) row.querySelector('.s-mark').click();
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  const s7d = await win.webContents.executeJavaScript(`(() => ({
    step: 'marked-as-non-music',
    rows: document.querySelectorAll('.song-row').length,
    markedRowPresent: [...document.querySelectorAll('.s-title')].some(n => n.textContent.includes('非音乐视频')),
  }))()`);
  log('S7d', s7d);

  // ── S8：本地音乐库 —— 添加文件夹 → 扫描 → 列表 → 播放 ─────────────
  await win.webContents.executeJavaScript(`document.getElementById('btn-add-folder').click()`);
  await new Promise((r) => setTimeout(r, 1400));
  const s8 = await win.webContents.executeJavaScript(`(() => ({
    step: 'local-library',
    header: document.getElementById('folder-title').textContent,
    rows: document.querySelectorAll('.song-row').length,
    titles: [...document.querySelectorAll('.s-title')].map(n => n.textContent),
    upper: [...document.querySelectorAll('.s-upper')].map(n => n.textContent),
    localRows: document.querySelectorAll('.song-row.s-row-local').length,
    libItems: [...document.querySelectorAll('#library-list .folder-name')].map(n => n.textContent),
    badge: (document.querySelector('.song-row .s-badge') || {}).textContent || '',
  }))()`);
  log('S8', s8);
  fs.writeFileSync(path.join(DATA, 'ui-local.png'), (await win.webContents.capturePage()).toPNG());

  // 点第一首本地歌播放
  await win.webContents.executeJavaScript(`document.querySelectorAll('.song-row')[0].click()`);
  await new Promise((r) => setTimeout(r, 2200));
  const s9 = await win.webContents.executeJavaScript(`(() => {
    const a = document.getElementById('audio');
    return {
      step: 'local-playback',
      playing: !a.paused,
      src: (a.currentSrc || '').slice(0, 60),
      dur: a.duration,
      ct: a.currentTime,
      err: a.error ? a.error.code : null,
      qLabel: document.getElementById('q-label').textContent,
      pbTitle: document.getElementById('pb-title').textContent,
    };
  })()`);
  log('S9', s9);

  // ── S10：B 站链接导入 ──────────────────────────────────────────────
  await win.webContents.executeJavaScript(`document.getElementById('btn-add-link').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const s10a = await win.webContents.executeJavaScript(`(() => ({
    step: 'link-dialog-open',
    visible: !document.getElementById('link-mask').hidden,
  }))()`);
  log('S10a', s10a);

  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('link-input').value = 'https://www.bilibili.com/video/BV9GJ411x7h7';
    document.getElementById('btn-link-parse').click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const s10b = await win.webContents.executeJavaScript(`(() => ({
    step: 'link-parsed',
    rows: document.querySelectorAll('#link-list .link-row').length,
    checks: document.querySelectorAll('#link-list .lr-check').length,
    checked: [...document.querySelectorAll('#link-list .lr-check')].filter(b => b.checked).length,
    groups: document.querySelectorAll('#link-list .link-group').length,
    groupName: document.querySelector('#link-list .link-group .lg-name')?.textContent || '',
    count: document.getElementById('link-result-count').textContent,
    confirmVisible: !document.getElementById('link-result').hidden,
    confirmDisabled: document.getElementById('btn-link-confirm').disabled,
  }))()`);
  log('S10b', s10b);

  // ── S10-1：「只导入指定分 P」——全不选后只勾 P2 ──────────────────────
  await win.webContents.executeJavaScript(`document.getElementById('btn-link-none').click()`);
  await new Promise((r) => setTimeout(r, 200));
  const s10d = await win.webContents.executeJavaScript(`(() => ({
    step: 'link-none',
    checked: [...document.querySelectorAll('#link-list .lr-check')].filter(b => b.checked).length,
    confirmDisabled: document.getElementById('btn-link-confirm').disabled,
    count: document.getElementById('link-result-count').textContent,
  }))()`);
  log('S10d', s10d);

  // 分组头的「全选」只勾该视频下的 3 个分 P
  await win.webContents.executeJavaScript(
    `document.querySelector('#link-list .link-group .lg-toggle').click()`,
  );
  await new Promise((r) => setTimeout(r, 200));
  const s10e = await win.webContents.executeJavaScript(`(() => ({
    step: 'link-group-select-all',
    checked: [...document.querySelectorAll('#link-list .lr-check')].filter(b => b.checked).length,
    confirmText: document.getElementById('btn-link-confirm').textContent,
  }))()`);
  log('S10e', s10e);

  // 只留下 P2：先关掉分组全选，再单独勾 P2
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('btn-link-none').click();
  })()`);
  await new Promise((r) => setTimeout(r, 150));
  await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('#link-list .link-row')];
    const p2 = rows.find(r => r.querySelector('.lr-title')?.textContent.includes('P2'));
    p2.querySelector('.lr-check').click();
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const s10f = await win.webContents.executeJavaScript(`(() => ({
    step: 'link-pick-p2',
    checked: [...document.querySelectorAll('#link-list .lr-check')].filter(b => b.checked).length,
    confirmText: document.getElementById('btn-link-confirm').textContent,
    count: document.getElementById('link-result-count').textContent,
  }))()`);
  log('S10f', s10f);

  await win.webContents.executeJavaScript(`document.getElementById('btn-link-confirm').click()`);
  await new Promise((r) => setTimeout(r, 1200));
  const s10c = await win.webContents.executeJavaScript(`(() => ({
    step: 'link-added',
    maskHidden: document.getElementById('link-mask').hidden,
    libItems: [...document.querySelectorAll('#library-list .folder-name')].map(n => n.textContent),
    rows: document.querySelectorAll('.song-row').length,
  }))()`);
  log('S10c', s10c);

  // ── S10-2：重新解析同一批链接，已导入的那条应显示「已导入」且不可勾 ──
  await win.webContents.executeJavaScript(`document.getElementById('btn-add-link').click()`);
  await new Promise((r) => setTimeout(r, 400));
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('link-input').value = 'https://www.bilibili.com/video/BV7GJ411x7h7';
    document.getElementById('btn-link-parse').click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const s10g = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('#link-list .link-row')];
    const done = rows.filter(r => r.classList.contains('done'));
    const doneRow = done[0];
    return {
      step: 'link-reparse-existing',
      rows: rows.length,
      doneCount: done.length,
      doneTitle: doneRow?.querySelector('.lr-title')?.textContent || '',
      doneBadge: doneRow?.querySelector('.lr-badge')?.textContent || '',
      doneDisabled: doneRow?.querySelector('.lr-check')?.disabled,
      checked: [...document.querySelectorAll('#link-list .lr-check')].filter(b => b.checked).length,
      confirmText: document.getElementById('btn-link-confirm').textContent,
    };
  })()`);
  log('S10g', s10g);
  await win.webContents.executeJavaScript(`document.getElementById('btn-link-close').click()`);
  await new Promise((r) => setTimeout(r, 300));

  // ── S11：新建歌单 + 右键加入歌单 ────────────────────────────────────
  await win.webContents.executeJavaScript(`document.getElementById('btn-new-playlist').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const s11a = await win.webContents.executeJavaScript(`(() => ({
    step: 'playlist-dialog',
    visible: !document.getElementById('pl-mask').hidden,
    title: document.getElementById('pl-title').textContent,
  }))()`);
  log('S11a', s11a);

  // 空名字应该被拦下
  await win.webContents.executeJavaScript(`document.getElementById('btn-pl-ok').click()`);
  await new Promise((r) => setTimeout(r, 200));
  const s11b = await win.webContents.executeJavaScript(`(() => ({
    step: 'playlist-empty-blocked',
    stillOpen: !document.getElementById('pl-mask').hidden,
    hint: document.getElementById('pl-hint').textContent,
    err: document.getElementById('pl-hint').className.includes('err'),
  }))()`);
  log('S11b', s11b);

  // 填名字提交
  await win.webContents.executeJavaScript(`(() => {
    const i = document.getElementById('pl-name');
    i.value = '我的歌单';
    document.getElementById('btn-pl-ok').click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const s11c = await win.webContents.executeJavaScript(`(() => ({
    step: 'playlist-created',
    maskHidden: document.getElementById('pl-mask').hidden,
    libItems: [...document.querySelectorAll('#library-list .folder-name')].map(n => n.textContent),
    header: document.getElementById('folder-title').textContent,
  }))()`);
  log('S11c', s11c);

  // 回到本地音乐，右键第一行进「加入歌单」
  await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('#library-list .folder-item')]
      .find(n => n.textContent.includes('本地音乐'));
    if (item) item.click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.song-row');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const s11d = await win.webContents.executeJavaScript(`(() => ({
    step: 'context-menu-open',
    visible: !document.getElementById('ctx-menu').hidden,
    items: [...document.querySelectorAll('#ctx-menu .ctx-item')].map(n => n.textContent),
    labels: [...document.querySelectorAll('#ctx-menu .ctx-label')].map(n => n.textContent),
  }))()`);
  log('S11d', s11d);

  // 点「加入歌单」下的那一条
  await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#ctx-menu .ctx-item')];
    const target = items.find(n => n.textContent === '我的歌单');
    if (target) target.click();
  })()`);
  await new Promise((r) => setTimeout(r, 800));
  const s11e = await win.webContents.executeJavaScript(`(() => ({
    step: 'added-via-context-menu',
    ctxHidden: document.getElementById('ctx-menu').hidden,
    toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent,
  }))()`);
  log('S11e', s11e);

  const libCalls = (await win.webContents.executeJavaScript(`window.api.__calls()`)).filter((c) =>
    String(c).startsWith('lib:'),
  );
  log('lib calls:', libCalls);

  // ── S12：歌单重命名 / 导出导入 / 恢复自动判断 ──────────────────────
  // 双击侧栏歌单名 → 出现输入框
  await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('#library-list .folder-item')]
      .find(n => n.textContent.includes('我的歌单'));
    if (item) item.querySelector('.folder-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const s12a = await win.webContents.executeJavaScript(`(() => ({
    step: 'rename-input-shown',
    exists: !!document.querySelector('.folder-rename'),
    value: (document.querySelector('.folder-rename') || {}).value || '',
  }))()`);
  log('S12a', s12a);

  // 改名后回车
  await win.webContents.executeJavaScript(`(() => {
    const i = document.querySelector('.folder-rename');
    i.value = '改名后的歌单';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 800));
  const s12b = await win.webContents.executeJavaScript(`(() => ({
    step: 'renamed',
    libItems: [...document.querySelectorAll('#library-list .folder-name')].map(n => n.textContent),
    inputGone: !document.querySelector('.folder-rename'),
  }))()`);
  log('S12b', s12b);

  // 库菜单 → 导出
  await win.webContents.executeJavaScript(`document.getElementById('btn-lib-menu').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const s12c = await win.webContents.executeJavaScript(`(() => ({
    step: 'lib-menu-open',
    visible: !document.getElementById('ctx-menu').hidden,
    items: [...document.querySelectorAll('#ctx-menu .ctx-item')].map(n => n.textContent),
  }))()`);
  log('S12c', s12c);

  await win.webContents.executeJavaScript(`(() => {
    const t = [...document.querySelectorAll('#ctx-menu .ctx-item')].find(n => n.textContent.includes('导出全部'));
    if (t) t.click();
  })()`);
  await new Promise((r) => setTimeout(r, 700));

  // 再开一次 → 导入
  await win.webContents.executeJavaScript(`document.getElementById('btn-lib-menu').click()`);
  await new Promise((r) => setTimeout(r, 350));
  await win.webContents.executeJavaScript(`(() => {
    const t = [...document.querySelectorAll('#ctx-menu .ctx-item')].find(n => n.textContent.includes('导入'));
    if (t) t.click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const s12d = await win.webContents.executeJavaScript(`(() => ({
    step: 'imported',
    libItems: [...document.querySelectorAll('#library-list .folder-name')].map(n => n.textContent),
    toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent,
  }))()`);
  log('S12d', s12d);

  // 恢复自动判断：先标一首，再用右键菜单恢复
  await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('#library-list .folder-item')]
      .find(n => n.textContent.includes('本地音乐'));
    if (item) item.click();
  })()`);
  await new Promise((r) => setTimeout(r, 800));
  await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.song-row');
    if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const s12e = await win.webContents.executeJavaScript(`(() => ({
    step: 'no-restore-for-local',
    items: [...document.querySelectorAll('#ctx-menu .ctx-item')].map(n => n.textContent),
  }))()`);
  log('S12e', s12e);
  await win.webContents.executeJavaScript(`document.body.click()`);
  await new Promise((r) => setTimeout(r, 200));

  const libCalls2 = (await win.webContents.executeJavaScript(`window.api.__calls()`)).filter((c) =>
    String(c).startsWith('lib:'),
  );

  // ── S13：B 站曲目的「恢复自动判断」 ────────────────────────────────
  await win.webContents.executeJavaScript(`(() => {
    const c = document.getElementById('chk-only-music');
    c.checked = false;
    c.dispatchEvent(new Event('change'));
    document.querySelectorAll('#folder-list .folder-item')[0].click();
  })()`);
  await new Promise((r) => setTimeout(r, 1600));
  // 把 BV2 点到「手动音乐」状态（三态循环，最多点 3 次）
  for (let k = 0; k < 3; k++) {
    const cls = await win.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.song-row')]
        .find(r => r.querySelector('.s-title').textContent.includes('非音乐视频'));
      return row ? row.querySelector('.s-mark').className : '';
    })()`);
    if (cls.includes('on')) break;
    await win.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.song-row')]
        .find(r => r.querySelector('.s-title').textContent.includes('非音乐视频'));
      if (row) row.querySelector('.s-mark').click();
    })()`);
    await new Promise((r) => setTimeout(r, 500));
  }
  // 右键它 → 应出现「恢复自动判断」
  await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.song-row')]
      .find(r => r.querySelector('.s-title').textContent.includes('非音乐视频'));
    if (row) row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 320 }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const s13a = await win.webContents.executeJavaScript(`(() => ({
    step: 'restore-item-shown',
    items: [...document.querySelectorAll('#ctx-menu .ctx-item')].map(n => n.textContent),
  }))()`);
  log('S13a', s13a);

  await win.webContents.executeJavaScript(`(() => {
    const t = [...document.querySelectorAll('#ctx-menu .ctx-item')].find(n => n.textContent.includes('恢复自动判断'));
    if (t) t.click();
  })()`);
  await new Promise((r) => setTimeout(r, 800));
  const s13b = await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.song-row')]
      .find(r => r.querySelector('.s-title').textContent.includes('非音乐视频'));
    return {
      step: 'restore-cleared',
      markCls: row ? row.querySelector('.s-mark').className : '',
      title: row ? row.querySelector('.s-title').textContent : '',
      toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent,
    };
  })()`);
  log('S13b', s13b);

  const allCalls = await win.webContents.executeJavaScript(`window.api.__calls()`);
  const restoreCalls = allCalls.filter((c) => String(c).includes('music-override') && String(c).endsWith(':null'));
  log('restore calls:', restoreCalls);

  // ── S14：歌单内拖拽排序 ──────────────────────────────────────────────
  // 先把本地两首加进「改名后的歌单」
  const plId = await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('#library-list .folder-item')]
      .find(n => n.textContent.includes('本地音乐'));
    if (item) item.click();
    return '';
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.song-row');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  await win.webContents.executeJavaScript(`(() => {
    const t = [...document.querySelectorAll('#ctx-menu .ctx-item')].find(n => n.textContent === '改名后的歌单');
    if (t) t.click();
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  // 第二首也加进去
  await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.song-row')];
    if (rows[1]) rows[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  await win.webContents.executeJavaScript(`(() => {
    const t = [...document.querySelectorAll('#ctx-menu .ctx-item')].find(n => n.textContent === '改名后的歌单');
    if (t) t.click();
  })()`);
  await new Promise((r) => setTimeout(r, 700));

  // 进歌单，检查 draggable 与顺序
  await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('#library-list .folder-item')]
      .find(n => n.textContent.includes('改名后的歌单'));
    if (item) item.click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const s14a = await win.webContents.executeJavaScript(`(() => ({
    step: 'playlist-draggable',
    rows: document.querySelectorAll('.song-row').length,
    titles: [...document.querySelectorAll('.s-title')].map(n => n.textContent),
    draggable: [...document.querySelectorAll('.song-row')].map(r => r.draggable),
  }))()`);
  log('S14a', s14a);

  // 模拟把第 0 行拖到第 1 行
  const dragResult = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.song-row')];
    if (rows.length < 2) return { ok: false, reason: '不足两行' };
    const dt = new DataTransfer();
    rows[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    rows[1].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    rows[1].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    rows[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return { ok: true };
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const s14b = await win.webContents.executeJavaScript(`(() => ({
    step: 'after-drag',
    titles: [...document.querySelectorAll('.s-title')].map(n => n.textContent),
    playingRows: document.querySelectorAll('.song-row.playing').length,
  }))()`);
  log('S14b', s14b, dragResult);

  const moveCalls = (await win.webContents.executeJavaScript(`window.api.__calls()`)).filter((c) =>
    String(c).includes('lib:move'),
  );
  log('move calls:', moveCalls);

  // ── S15：多 P 视频按分 P 拆成多条曲目 ──
  // 切到 1003（只有一条收藏，是个 3 分 P 的合集），应展开成 3 行
  const s15a = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('#folder-list .folder-item[data-id="1003"]')?.click();
    return { clicked: true };
  })()`);
  await new Promise((r) => setTimeout(r, 1600));

  const s15b = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.song-row')];
    return {
      step: 'multi-page-split',
      rows: rows.length,
      titles: rows.map(r => r.querySelector('.s-title')?.textContent || ''),
      partBadges: rows.map(r => r.querySelector('.s-badge.part')?.textContent || ''),
      durations: rows.map(r => r.querySelector('.s-sub')?.textContent || ''),
    };
  })()`);
  log('S15b', s15b, s15a);

  // 点第 2 个分 P 播放，确认用的是该分 P 的 cid
  const s15c = await win.webContents.executeJavaScript(`(async () => {
    const rows = [...document.querySelectorAll('.song-row')];
    if (rows.length < 2) return { ok: false, reason: '不足两行' };
    rows[1].click();
    await new Promise(r => setTimeout(r, 2000));
    const calls = await window.api.__calls();
    const audioCall = (calls.filter(c => String(c).startsWith('audioUrl:')).pop()) || '';
    return {
      ok: true,
      playingRows: document.querySelectorAll('.song-row.playing').length,
      playingIndex: document.querySelector('.song-row.playing')?.dataset.i || '',
      pbTitle: document.querySelector('.pb-title')?.textContent || '',
      audioCall,
    };
  })()`);
  log('S15c', s15c);

  // 拆分出来的分 P 应各自可独立标记（键是 bvid:pN 而不是 bvid）
  const s15d = await win.webContents.executeJavaScript(`(async () => {
    // 每次点击都会重建列表 DOM，必须重新查询按钮，否则拿到的是已脱离文档的旧节点
    for (let i = 0; i < 4; i++) {
      const btn = document.querySelectorAll('.song-row')[2]?.querySelector('.s-mark');
      if (!btn) return { ok: false, reason: '没有标记按钮' };
      if (btn.className.includes('on')) {
        const calls = await window.api.__calls();
        const last = (calls.filter(c => String(c).startsWith('music-override:')).pop()) || '';
        return {
          ok: true,
          markCls: btn.className,
          title: btn.closest('.song-row').querySelector('.s-title')?.textContent || '',
          key: last.replace('music-override:', '').replace(/:(true|false|null)$/, ''),
        };
      }
      btn.click();
      await new Promise(r => setTimeout(r, 300));
    }
    const last = document.querySelectorAll('.song-row')[2]?.querySelector('.s-mark');
    return { ok: false, markCls: last?.className || '', title: '', key: '' };
  })()`);
  log('S15d', s15d);

  // ── S16：我喜欢的歌（本地 + 链接收藏自动汇总） ──
  const s16a = await win.webContents.executeJavaScript(`(async () => {
    const items = [...document.querySelectorAll('#library-list .folder-item')];
    const node = items.find((n) => n.querySelector('.folder-name')?.textContent === '我喜欢的歌');
    if (!node) return { found: false };
    node.click();
    await new Promise((r) => setTimeout(r, 900));
    const rows = [...document.querySelectorAll('.song-row')];
    return {
      found: true,
      header: document.getElementById('folder-title').textContent,
      sub: document.getElementById('folder-sub').textContent,
      rows: rows.length,
      titles: rows.map((r) => r.querySelector('.s-title')?.textContent || ''),
      localRows: document.querySelectorAll('.song-row.s-row-local').length,
      count: node.querySelector('.lib-count')?.textContent || '',
    };
  })()`);
  log('S16a', s16a);

  // S16b：从「我喜欢的歌」里移除一首，列表应该少一条，且库里的原曲目还在
  const s16b = await win.webContents.executeJavaScript(`(async () => {
    const row = document.querySelectorAll('.song-row')[0];
    if (!row) return { ok: false };
    const title = row.querySelector('.s-title')?.textContent || '';
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 300 }));
    await new Promise((r) => setTimeout(r, 400));
    const items = [...document.querySelectorAll('#ctx-menu .ctx-item')];
    const target = items.find((n) => n.textContent.includes('从我喜欢的歌删除'));
    if (!target) return { ok: false, items: items.map((n) => n.textContent) };
    target.click();
    await new Promise((r) => setTimeout(r, 1200));
    const rows = [...document.querySelectorAll('.song-row')];
    return {
      ok: true,
      items: items.map((n) => n.textContent),
      removedTitle: title,
      rowsAfter: rows.length,
      titles: rows.map((r) => r.querySelector('.s-title')?.textContent || ''),
      sub: document.getElementById('folder-sub').textContent,
    };
  })()`);
  log('S16b', s16b);

  // S16b2：「我喜欢的歌」里来自「链接收藏」的歌，右键只该有「从我喜欢的歌删除」，
  // 不能同时冒出「从『链接收藏』移除」（两个删法容易点错）
  const s16b2 = await win.webContents.executeJavaScript(`(async () => {
    const rows = [...document.querySelectorAll('.song-row')];
    const row = rows.find((r) => (r.querySelector('.s-title')?.textContent || '').includes('链接合集'));
    if (!row) return { ok: false, titles: rows.map((r) => r.querySelector('.s-title')?.textContent) };
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 300 }));
    await new Promise((r) => setTimeout(r, 400));
    const items = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((n) => n.textContent);
    document.body.click();
    await new Promise((r) => setTimeout(r, 200));
    return {
      ok: true,
      items,
      hasLovedDelete: items.some((t) => t.includes('从我喜欢的歌删除')),
      hasLinkRemove: items.some((t) => t.includes('链接收藏') && t.includes('移除')),
      hasLibRemove: items.some((t) => t.includes('从库中移除')),
    };
  })()`);
  log('S16b2', s16b2);

  // S16c：被移除的曲目在「链接收藏」里仍然存在（只移出歌单，不删库）
  const s16c = await win.webContents.executeJavaScript(`(async () => {
    const items = [...document.querySelectorAll('#library-list .folder-item')];
    const node = items.find((n) => n.querySelector('.folder-name')?.textContent === '链接收藏');
    if (!node) return { found: false };
    node.click();
    await new Promise((r) => setTimeout(r, 900));
    const rows = [...document.querySelectorAll('.song-row')];
    return {
      found: true,
      rows: rows.length,
      titles: rows.map((r) => r.querySelector('.s-title')?.textContent || ''),
    };
  })()`);
  log('S16c', s16c);

  // ── S17：收藏夹爱心 → 「我喜欢的歌」 ──
  const s17a = await win.webContents.executeJavaScript(`(async () => {
    const before = [...document.querySelectorAll('#folder-list .folder-item')].map((n) => ({
      title: n.querySelector('.folder-name')?.textContent || '',
      hasHeart: !!n.querySelector('.fav-heart'),
      heartOn: n.querySelector('.fav-heart')?.classList.contains('on') || false,
    }));
    const node = document.querySelector('#folder-list .folder-item[data-id="1002"]');
    if (!node) return { found: false, before };
    const heart = node.querySelector('.fav-heart');
    if (!heart) return { found: true, hasHeart: false, before };
    heart.click();
    await new Promise((r) => setTimeout(r, 1500));
    const after = [...document.querySelectorAll('#folder-list .folder-item')].map((n) => ({
      title: n.querySelector('.folder-name')?.textContent || '',
      following: !!n.querySelector('.fav-following'),
      heartOn: n.querySelector('.fav-heart')?.classList.contains('on') || false,
      heartFollow: n.querySelector('.fav-heart')?.classList.contains('follow') || false,
    }));
    return {
      found: true,
      hasHeart: true,
      before,
      after,
      toast: document.getElementById('toast').textContent,
    };
  })()`);
  log('S17a', s17a);

  // S17b：跟随之后「我喜欢的歌」曲目数变多
  const s17b = await win.webContents.executeJavaScript(`(async () => {
    const items = [...document.querySelectorAll('#library-list .folder-item')];
    const node = items.find((n) => n.querySelector('.folder-name')?.textContent === '我喜欢的歌');
    node.click();
    await new Promise((r) => setTimeout(r, 900));
    const rows = [...document.querySelectorAll('.song-row')];
    return {
      rows: rows.length,
      sub: document.getElementById('folder-sub').textContent,
      titles: rows.map((r) => r.querySelector('.s-title')?.textContent || ''),
    };
  })()`);
  log('S17b', s17b);

  // S17c：再点一次爱心 = 取消跟随
  const s17c = await win.webContents.executeJavaScript(`(async () => {
    const node = document.querySelector('#folder-list .folder-item[data-id="1002"]');
    const heart = node?.querySelector('.fav-heart');
    if (!heart) return { ok: false };
    heart.click();
    await new Promise((r) => setTimeout(r, 500));
    // 确认框是动态插入的 .modal-mask（没有固定 id），找带"确定"按钮的那个
    const masks = [...document.querySelectorAll('body > .modal-mask')].filter((m) => !m.id);
    const visible = masks.length > 0;
    const yes = masks[0]?.querySelector('[data-act="yes"]');
    if (yes) yes.click();
    await new Promise((r) => setTimeout(r, 1200));
    const after = [...document.querySelectorAll('#folder-list .folder-item')].map((n) => ({
      title: n.querySelector('.folder-name')?.textContent || '',
      following: !!n.querySelector('.fav-following'),
      heartOn: n.querySelector('.fav-heart')?.classList.contains('on') || false,
    }));
    return { ok: true, confirmShown: !!visible, after };
  })()`);
  log('S17c', s17c);

  // ── S17-once：一次性批量导入（不跟随），爱心仍是实心但不带跟随点 ──
  const s17d = await win.webContents.executeJavaScript(`(async () => {
    const node = document.querySelector('#folder-list .folder-item[data-id="1003"]');
    if (!node) return { ok: false };
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
    await new Promise((r) => setTimeout(r, 300));
    const items = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((n) => n.textContent);
    const once = [...document.querySelectorAll('#ctx-menu .ctx-item')].find((n) =>
      n.textContent.includes('一次性全量加入'),
    );
    if (!once) return { ok: false, items };
    once.click();
    await new Promise((r) => setTimeout(r, 1500));
    const row = document.querySelector('#folder-list .folder-item[data-id="1003"]');
    return {
      ok: true,
      items,
      heartOn: row?.querySelector('.fav-heart')?.classList.contains('on') || false,
      heartFollow: row?.querySelector('.fav-heart')?.classList.contains('follow') || false,
      followingMark: !!row?.querySelector('.fav-following'),
      toast: document.getElementById('toast').textContent,
    };
  })()`);
  log('S17d', s17d);

  // S17e：一次性导入的收藏夹，右键给的是「移出」而不是「取消跟随」
  const s17e = await win.webContents.executeJavaScript(`(async () => {
    const node = document.querySelector('#folder-list .folder-item[data-id="1003"]');
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
    await new Promise((r) => setTimeout(r, 300));
    const items = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((n) => n.textContent);
    const rm = [...document.querySelectorAll('#ctx-menu .ctx-item')].find((n) =>
      n.textContent.includes('移出'),
    );
    if (!rm) return { ok: false, items };
    rm.click();
    await new Promise((r) => setTimeout(r, 400));
    const mask = [...document.querySelectorAll('body > .modal-mask')].filter((m) => !m.id)[0];
    const yes = mask?.querySelector('[data-act="yes"]');
    if (yes) yes.click();
    await new Promise((r) => setTimeout(r, 1200));
    const row = document.querySelector('#folder-list .folder-item[data-id="1003"]');
    return {
      ok: true,
      items,
      heartOn: row?.querySelector('.fav-heart')?.classList.contains('on') || false,
    };
  })()`);
  log('S17e', s17e);

  // ── S18：关闭行为三选一 ──────────────────────────────────────────────
  // 主进程在 closeAction='ask' 时发 win:ask-close，渲染层应弹出三选一
  const s18a = await win.webContents.executeJavaScript(`(async () => {
    document.querySelectorAll('[data-close-ask]').forEach(n => n.remove());
    window.api.__emit('win:ask-close');
    await new Promise(r => setTimeout(r, 250));
    const mask = document.querySelector('[data-close-ask]');
    const labels = mask ? [...mask.querySelectorAll('button')].map(b => b.textContent.trim()) : [];
    return {
      visible: !!mask,
      labels,
      hasRemember: !!mask?.querySelector('[data-act="remember"]'),
      heading: mask ? mask.querySelector('h2')?.textContent.trim() : '',
    };
  })()`);
  log('S18a', s18a);

  const s18b = await win.webContents.executeJavaScript(`(async () => {
    const before = (await window.api.__calls()).length;
    document.querySelector('[data-close-ask] [data-act="tray"]').click();
    await new Promise(r => setTimeout(r, 250));
    const calls = (await window.api.__calls()).slice(before);
    return {
      maskGone: !document.querySelector('[data-close-ask]'),
      trayCall: calls.some(c => String(c) === 'win:hideToTray'),
      setCall: calls.some(c => String(c).includes('closeAction')),
    };
  })()`);
  log('S18b', s18b);

  const s18c = await win.webContents.executeJavaScript(`(async () => {
    document.querySelectorAll('[data-close-ask]').forEach(n => n.remove());
    window.api.__emit('win:ask-close');
    await new Promise(r => setTimeout(r, 200));
    const before = (await window.api.__calls()).length;
    document.querySelector('[data-close-ask] [data-act="quit"]').click();
    await new Promise(r => setTimeout(r, 250));
    const calls = (await window.api.__calls()).slice(before);
    return {
      maskGone: !document.querySelector('[data-close-ask]'),
      quitCall: calls.some(c => String(c) === 'win:quit'),
    };
  })()`);
  log('S18c', s18c);

  const s18d = await win.webContents.executeJavaScript(`(async () => {
    document.querySelectorAll('[data-close-ask]').forEach(n => n.remove());
    window.api.__emit('win:ask-close');
    await new Promise(r => setTimeout(r, 200));
    const before = (await window.api.__calls()).length;
    document.querySelector('[data-close-ask] [data-act="cancel"]').click();
    await new Promise(r => setTimeout(r, 200));
    const calls = (await window.api.__calls()).slice(before);
    return {
      maskGone: !document.querySelector('[data-close-ask]'),
      noAction: !calls.some(c => String(c) === 'win:hideToTray' || String(c) === 'win:quit'),
    };
  })()`);
  log('S18d', s18d);

  // 设置里应有「点关闭按钮时」下拉，且默认 ask
  const s18e = await win.webContents.executeJavaScript(`(async () => {
    document.querySelectorAll('[data-close-ask]').forEach(n => n.remove());
    document.getElementById('btn-settings').click();
    await new Promise(r => setTimeout(r, 400));
    const sel = document.getElementById('set-close-action');
    const opts = sel ? [...sel.options].map(o => o.value) : [];
    const value = sel ? sel.value : '';
    document.getElementById('btn-settings-close')?.click();
    await new Promise(r => setTimeout(r, 200));
    return { exists: !!sel, opts, value };
  })()`);
  log('S18e', s18e);

  // ── S19：列表里每首歌单独的爱心 ──────────────────────────────────────
  // S19a：回到收藏夹，每行都有爱心，且非音乐的视频也照样有（爱心和音乐判定无关）
  const s19a = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('search-input').value = '';
    document.getElementById('search-input').dispatchEvent(new Event('input', { bubbles: true }));
    const items = [...document.querySelectorAll('#folder-list .folder-item')];
    items.find((n) => n.querySelector('.folder-name')?.textContent === '我的音乐收藏')?.click();
    await new Promise((r) => setTimeout(r, 1200));
    const chk = document.getElementById('chk-only-music');
    if (!chk.checked) { chk.checked = true; chk.dispatchEvent(new Event('change', { bubbles: true })); }
    await new Promise((r) => setTimeout(r, 400));
    const rows = [...document.querySelectorAll('.song-row')];
    const hearts = rows.map((r) => r.querySelector('.s-heart'));
    return {
      rows: rows.length,
      hearts: hearts.filter(Boolean).length,
      onCount: hearts.filter((h) => h && h.className.includes('on')).length,
      headCols: document.querySelectorAll('.list-head .col-heart').length,
    };
  })()`);
  log('S19a', s19a);

  // S19b：点第一首的爱心 → 立刻点亮，并出现在「我喜欢的歌」里
  const s19b = await win.webContents.executeJavaScript(`(async () => {
    const row = document.querySelectorAll('.song-row')[0];
    const title = row?.querySelector('.s-title')?.textContent || '';
    const heart = row?.querySelector('.s-heart');
    if (!heart) return { ok: false };
    heart.click();
    await new Promise((r) => setTimeout(r, 900));
    const after = document.querySelectorAll('.song-row')[0]?.querySelector('.s-heart');
    const node = [...document.querySelectorAll('#library-list .folder-item')]
      .find((n) => n.querySelector('.folder-name')?.textContent === '我喜欢的歌');
    node?.click();
    await new Promise((r) => setTimeout(r, 1000));
    const rows = [...document.querySelectorAll('.song-row')];
    return {
      ok: true,
      title,
      lit: !!after && after.className.includes('on'),
      heartTitle: after?.getAttribute('title') || '',
      inLoved: rows.some((r) => (r.querySelector('.s-title')?.textContent || '').includes(title)),
      lovedRows: rows.length,
      count: node?.querySelector('.lib-count')?.textContent || '',
    };
  })()`);
  log('S19b', s19b);
  // 记下刚收藏的那首标题，S19c 要在「我喜欢的歌」里定位到同一行
  await win.webContents.executeJavaScript(`window.__s19bTitle = ${JSON.stringify(s19b.title || '')}; true`);

  // S19c：在「我喜欢的歌」里同一首的爱心应当常亮；再点一次取消收藏
  const s19c = await win.webContents.executeJavaScript(`(async () => {
    const want = window.__s19bTitle || '';
    const rows = [...document.querySelectorAll('.song-row')];
    const row = rows.find((r) => (r.querySelector('.s-title')?.textContent || '').includes(want)) || rows[0];
    const title = row?.querySelector('.s-title')?.textContent || '';
    const before = row?.querySelector('.s-heart');
    const litBefore = !!before && before.className.includes('on');
    before?.click();
    await new Promise((r) => setTimeout(r, 1100));
    const afterRows = [...document.querySelectorAll('.song-row')];
    return {
      title,
      litBefore,
      rowsAfter: afterRows.length,
      stillThere: afterRows.some((r) => (r.querySelector('.s-title')?.textContent || '').includes(title)),
    };
  })()`);
  log('S19c', s19c);

  // S19d：回到收藏夹，刚才取消收藏的那首爱心应该是灭的（状态真的持久了）
  const s19d = await win.webContents.executeJavaScript(`(async () => {
    const items = [...document.querySelectorAll('#folder-list .folder-item')];
    items.find((n) => n.querySelector('.folder-name')?.textContent === '我的音乐收藏')?.click();
    await new Promise((r) => setTimeout(r, 1200));
    const rows = [...document.querySelectorAll('.song-row')];
    const hearts = rows.map((r) => r.querySelector('.s-heart')).filter(Boolean);
    return { rows: rows.length, onCount: hearts.filter((h) => h.className.includes('on')).length };
  })()`);
  log('S19d', s19d);

  // S19e：右键菜单也有「添加到『我喜欢的歌』」，点完爱心同样是亮的
  const s19e = await win.webContents.executeJavaScript(`(async () => {
    const row = document.querySelectorAll('.song-row')[1];
    const title = row?.querySelector('.s-title')?.textContent || '';
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 320 }));
    await new Promise((r) => setTimeout(r, 400));
    const items = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((n) => n.textContent);
    const target = [...document.querySelectorAll('#ctx-menu .ctx-item')]
      .find((n) => n.textContent.includes('添加到「我喜欢的歌」'));
    if (!target) return { ok: false, items };
    target.click();
    await new Promise((r) => setTimeout(r, 1000));
    const rowsAfter = [...document.querySelectorAll('.song-row')];
    const targetRow = rowsAfter.find((r) => (r.querySelector('.s-title')?.textContent || '').includes(title));
    return {
      ok: true,
      title,
      items,
      ctxHidden: document.getElementById('ctx-menu').hidden,
      lit: !!targetRow && targetRow.querySelector('.s-heart')?.className.includes('on'),
      heartTitle: targetRow?.querySelector('.s-heart')?.getAttribute('title') || '',
    };
  })()`);
  log('S19e', s19e);

  // S19f：已收藏的歌，右键项变成「从『我喜欢的歌』移除」
  const s19f = await win.webContents.executeJavaScript(`(async () => {
    const rows = [...document.querySelectorAll('.song-row')];
    const row = rows.find((r) => r.querySelector('.s-heart')?.className.includes('on'));
    if (!row) return { ok: false };
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 320 }));
    await new Promise((r) => setTimeout(r, 400));
    const items = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((n) => n.textContent);
    const hasRemove = items.some((t) => t.includes('从我喜欢的歌删除'));
    const hasAdd = items.some((t) => t.includes('添加到「我喜欢的歌」'));
    document.body.click();
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true, items, hasRemove, hasAdd };
  })()`);
  log('S19f', s19f);

  // ── S20：收藏夹条目在本应用隐藏 ──
  const s20a = await win.webContents.executeJavaScript(`(async () => {
    // 回到第一个收藏夹
    [...document.querySelectorAll('#folder-list .folder-item')].find((n) => n.dataset.id === '1001')?.click();
    await new Promise((r) => setTimeout(r, 900));
    const rows = [...document.querySelectorAll('.song-row')];
    return { rows: rows.length, titles: rows.map((r) => r.querySelector('.s-title')?.textContent),
             sub: document.getElementById('folder-sub')?.textContent };
  })()`);
  log('S20a', s20a);

  const s20b = await win.webContents.executeJavaScript(`(async () => {
    const rows = [...document.querySelectorAll('.song-row')];
    const row = rows.find((r) => r.querySelector('.s-title')?.textContent?.includes('三号'));
    if (!row) return { ok: false };
    const before = rows.length;
    const title = row.querySelector('.s-title').textContent;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 320 }));
    await new Promise((r) => setTimeout(r, 350));
    const items = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((n) => n.textContent);
    const target = [...document.querySelectorAll('#ctx-menu .ctx-item')].find((n) => n.textContent.includes('在本应用隐藏'));
    if (!target) { document.body.click(); return { ok: false, items }; }
    target.click();
    await new Promise((r) => setTimeout(r, 800));
    const after = [...document.querySelectorAll('.song-row')];
    return {
      ok: true, title, before, hasHideItem: true,
      after: after.length,
      stillThere: after.some((r) => r.querySelector('.s-title')?.textContent?.includes('三号')),
      toast: document.getElementById('toast')?.textContent || '',
      sub: document.getElementById('folder-sub')?.textContent || '',
    };
  })()`);
  log('S20b', s20b);

  const s20c = await win.webContents.executeJavaScript(`(async () => {
    // 重新打开收藏夹，隐藏要持久
    [...document.querySelectorAll('#folder-list .folder-item')].find((n) => n.dataset.id === '1001')?.click();
    await new Promise((r) => setTimeout(r, 1200));
    const rows = [...document.querySelectorAll('.song-row')];
    return {
      rows: rows.length,
      stillThere: rows.some((r) => r.querySelector('.s-title')?.textContent?.includes('三号')),
      sub: document.getElementById('folder-sub')?.textContent || '',
    };
  })()`);
  log('S20c', s20c);

  const s20d = await win.webContents.executeJavaScript(`(async () => {
    const row = document.querySelector('.song-row');
    if (!row) return { ok: false };
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 320 }));
    await new Promise((r) => setTimeout(r, 350));
    const items = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((n) => n.textContent);
    const restore = [...document.querySelectorAll('#ctx-menu .ctx-item')].find((n) => n.textContent.includes('恢复全部隐藏'));
    if (!restore) { document.body.click(); return { ok: false, items }; }
    restore.click();
    await new Promise((r) => setTimeout(r, 500));
    // 确认弹层（动态创建，无 id）
    const mask = [...document.querySelectorAll('body > .modal-mask')].filter((m) => !m.id)[0];
    const confirmShown = !!mask;
    mask?.querySelector('[data-act="yes"]')?.click();
    await new Promise((r) => setTimeout(r, 1500));
    const rows = [...document.querySelectorAll('.song-row')];
    return {
      ok: true, confirmShown,
      rows: rows.length,
      backAgain: rows.some((r) => r.querySelector('.s-title')?.textContent?.includes('三号')),
      sub: document.getElementById('folder-sub')?.textContent || '',
    };
  })()`);
  log('S20d', s20d);

  // 更窄窗口，检查布局不塌
  win.setSize(920, 600);
  await new Promise((r) => setTimeout(r, 700));
  fs.writeFileSync(path.join(DATA, 'ui-narrow.png'), (await win.webContents.capturePage()).toPNG());

  const calls = await win.webContents.executeJavaScript(`window.api.__calls()`);
  log('IPC calls:', calls);

  const markCalls = calls.filter((c) => String(c).startsWith('music-override:'));
  log('mark calls:', markCalls);

  const ok =
    s1.folders === 3 &&
    s2.rows === 2 && // 非音乐被过滤
    s3.playing === true &&
    s3.dur > 100 &&
    s4.rows === 0 &&
    s5.rows === 2 && // 第二收藏夹有 2 首，正在播的 BV1 排在 index 1
    s5.playingRows === 1 && // 切收藏夹后高亮仍指向正在放的那首
    s5.playingIndex === '1' && // 该收藏夹里 BV1 排在第二个位置
    s6.rows === 0 &&
    s6.toast === '' && // 有正在播放的歌时，不该提示"列表是空的"
    s6.playing === false && // 点播放键 = 暂停正在放的这首
    s6.pbTitle !== '' && // 播放条仍显示当前曲目
    // ── 手动标记 ──
    s7a.rows === 3 && // 关掉仅音乐后 3 条全在
    s7a.markButtons === 3 && // 每行都有标记按钮
    s7b.found === true &&
    s7b.markCls.includes('on') && // 点完变"手动音乐"状态
    s7b.title.includes('音乐 · 手动') && // 徽章写明是手动
    s7c.rows === 3 && // 重开仅音乐，手动标为音乐的仍在
    s7c.markedRowPresent === true &&
    s7d.markedRowPresent === false && // 标为非音乐后被隐藏
    markCalls.length >= 2 && // 至少保存了两次
    // ── 本地库 ──
    s8.header === '本地音乐' && // 侧边栏入口点开后的标题
    s8.rows === 2 && // 扫到 2 首
    s8.localRows === 2 && // 都标成"本地"行
    s8.titles.includes('晨光') &&
    s8.libItems.includes('本地音乐') && // 侧边栏出现入口
    s9.playing === true && // 本地文件真的能播
    s9.err === null &&
    s9.dur > 2 &&
    s9.qLabel === '本地' && // 音质位显示"本地"
    // ── 链接导入 ──
    s10a.visible === true && // 弹层打开
    s10b.rows === 5 && // 2 条单 P + 一个多 P 的 3 个分 P
    s10b.checks === 5 && // 每条都有勾选框
    s10b.checked === 5 && // 默认全勾（库里还没有）
    s10b.groups === 1 && // 多 P 归到一个分组
    s10b.groupName.includes('多P链接合集') && // 分组头显示视频标题
    s10b.confirmVisible === true &&
    s10b.confirmDisabled === false &&
    // ── 只导入指定分 P ──
    s10d.checked === 0 && // 全不选
    s10d.confirmDisabled === true && // 一首都没选时不能提交
    s10e.checked === 3 && // 分组全选只勾该视频的 3 个分 P
    s10e.confirmText.includes('3') && // 按钮显示数量
    s10f.checked === 1 && // 只勾了 P2
    s10f.confirmText.includes('（1）') &&
    s10f.count.includes('已选 1 首') &&
    s10c.maskHidden === true && // 确认后关闭
    s10c.libItems.includes('链接收藏') && // 侧边栏出现"链接收藏"
    s10c.rows === 1 && // 只导入了勾上的那 1 首
    // 重复解析时已导入的显示「已导入」且不可勾
    s10g.doneCount === 1 &&
    s10g.doneTitle.includes('P2') &&
    s10g.doneBadge === '已导入' &&
    s10g.doneDisabled === true &&
    s10g.checked === 4 && // 除了已导入的 P2，其余 4 条仍默认勾上
    // ── 歌单 ──
    s11a.visible === true && // 新建歌单弹层打开
    s11b.stillOpen === true && // 空名字不提交
    s11b.err === true &&
    s11c.maskHidden === true && // 提交后关闭
    s11c.libItems.includes('我的歌单') && // 侧边栏出现新歌单
    s11c.header === '我的歌单' && // 自动切到新歌单
    s11d.visible === true && // 右键菜单弹出
    s11d.items.includes('我的歌单') && // 菜单里有"加入歌单"
    s11e.ctxHidden === true && // 点完关掉
    s11e.toast.includes('已加入') && // 提示加入成功
    libCalls.some((c) => String(c).includes('addToPlaylist')) && // 真的调了加入接口
    // ── 重命名 / 导出导入 ──
    s12a.exists === true && // 双击出现输入框
    s12a.value === '我的歌单' && // 预填原名
    s12b.inputGone === true && // 回车后输入框消失
    s12b.libItems.includes('改名后的歌单') && // 名字已更新
    s12c.visible === true && // 库菜单弹出
    s12c.items.some((t) => t.includes('导出全部')) &&
    s12c.items.some((t) => t.includes('导入')) &&
    s12d.libItems.includes('导入的歌单') && // 导入后侧栏出现新歌单
    s12e.items.some((t) => t.includes('从库中移除')) && // 本地曲目有移除项
    !s12e.items.some((t) => t.includes('恢复自动判断')) && // 本地曲目不显示该项
    libCalls2.some((c) => String(c).includes('export')) &&
    libCalls2.some((c) => String(c).includes('import')) &&
    // ── 恢复自动判断 ──
    s13a.items.includes('恢复自动判断') && // 手动标过的曲目才有这一项
    !s13b.markCls.includes('on') && // 恢复后不再是手动音乐
    s13b.title.includes('非音乐视频') &&
    !s13b.title.includes('手动') && // 徽章不再写"手动"
    s13b.toast.includes('恢复自动判断') &&
    restoreCalls.length >= 1 && // 真的写入了 null
    // ── 拖拽排序 ──
    s14a.rows === 2 && // 歌单里有 2 首
    s14a.draggable.every(Boolean) && // 每行都可拖
    s14b.titles[0] === s14a.titles[1] && // 第 1 首挪到了第二首后面
    s14b.titles[1] === s14a.titles[0] &&
    moveCalls.length >= 1 && // 确实调用了 move 接口
    // ── 多 P 拆分 ──
    s15b.rows === 3 && // 一条 3 分 P 的收藏拆成 3 行
    s15b.titles[0].includes('P1') && // 标题带分 P 序号
    s15b.titles[1].includes('P2') &&
    s15b.titles[0].includes('第一曲') && // 带分 P 名
    s15b.titles[1].includes('第二曲') &&
    s15b.partBadges[0] === 'P1' && // 行上有分 P 角标
    s15b.partBadges[2] === 'P3' &&
    s15c.playingRows === 1 && // 单个分 P 能独立播放
    s15c.playingIndex === '1' && // 点的是第二行
    s15c.pbTitle.includes('P2') &&
    s15c.audioCall.includes('400002') && // 用的是 P2 自己的 cid，不是 P1
    s15d.ok === true &&
    s15d.markCls.includes('on') && // 分 P 可以独立标记
    s15d.key !== 'BV4GJ411x7h7' && // 写进存储的键带分 P 后缀
    // ── 我喜欢的歌 ──
    s16a.found === true && // 侧边栏有「我喜欢的歌」
    s16a.header === '我喜欢的歌' &&
    s16a.rows === 3 && // 本地 2 首 + 链接导入 1 首（S10 里只勾了 P2）自动汇总
    s16a.localRows === 2 && // 本地曲目也在里面
    Number(s16a.count) >= 3 && // 角标显示数量
    s16b.ok === true &&
    s16b.items.some((t) => t.includes('从我喜欢的歌删除')) && // 右键有删除项
    s16b2.ok === true && // 「我喜欢的歌」里来自链接库的歌
    s16b2.hasLovedDelete === true && // 只有「从我喜欢的歌删除」
    s16b2.hasLinkRemove === false && // 不该同时出现「从链接收藏移除」
    s16b2.hasLibRemove === false && // 也不该出现「从库中移除」
    s16b.rowsAfter === s16a.rows - 1 && // 移除后少一条
    !s16b.titles.includes(s16b.removedTitle) && // 确实不见了
    s16b.sub.includes('已移除') && // 副标题说明移除过几首
    s16c.found === true && s16c.rows === 1 && // 库里原曲目还在（只移出歌单）
    // ── 收藏夹爱心 ──
    s17a.found === true &&
    s17a.hasHeart === true && // 每个收藏夹前面都有爱心
    s17a.before.every((f) => f.hasHeart && !f.heartOn) && // 初始都没点亮
    s17a.after.some((f) => f.heartOn === true) && // 点一下就点亮
    s17a.after.some((f) => f.heartFollow === true) && // 跟随的带小圆点
    s17a.toast.includes('我喜欢的歌') &&
    s17b.rows > 0 &&
    // ── 取消跟随 ──
    s17c.ok === true &&
    s17c.confirmShown === true && // 取消前有确认
    s17c.after.every((f) => f.following === false) && // 全部取消跟随
    s17c.after.every((f) => f.heartOn === false) && // 爱心也熄灭
    // ── 一次性批量加入（不跟随） ──
    s17d.ok === true &&
    s17d.items.includes('一次性全量加入「我喜欢的歌」') &&
    s17d.heartOn === true && // 爱心点亮（已收进喜欢的歌）
    s17d.heartFollow === false && // 但没有跟随小圆点
    s17d.followingMark === false && // 也没有 ★
    s17d.toast.includes('不跟随更新') &&
    // ── 一次性导入的移出 ──
    s17e.ok === true &&
    s17e.items.some((t) => t.includes('移出')) &&
    !s17e.items.some((t) => t.includes('取消跟随')) && // 一次性来源不给"取消跟随"
    s17e.heartOn === false && // 移出后爱心熄灭
    // ── 关闭行为三选一 ──
    s18a.visible === true && // 点关闭会弹窗询问
    s18a.labels.includes('收进托盘') && // 三个选项
    s18a.labels.includes('退出程序') &&
    s18a.labels.includes('取消') &&
    s18a.hasRemember === true && // 有「记住我的选择」
    s18a.heading.includes('关闭') &&
    s18b.maskGone === true && // 选收进托盘后弹窗关闭
    s18b.trayCall === true && // 真的收进托盘
    s18c.maskGone === true &&
    s18c.quitCall === true && // 选退出真的退出
    s18d.maskGone === true &&
    s18d.noAction === true && // 取消不做任何事
    s18e.exists === true && // 设置里有下拉
    s18e.opts.join(',') === 'ask,tray,quit' && // 三个档位
    s18e.value === 'ask' && // 默认每次询问
    // ── 列表单曲爱心 ──
    s19a.rows === 2 && // 仅音乐下 2 首
    s19a.hearts === s19a.rows && // 每行都有爱心
    s19a.headCols === 1 && // 表头有爱心列
    s19b.ok === true &&
    s19b.lit === true && // 点一下立刻点亮
    s19b.heartTitle.includes('已在我喜欢的歌里') && // 提示语切换
    s19b.inLoved === true && // 真的出现在「我喜欢的歌」里
    Number(s19b.count) >= 1 && // 侧边栏角标跟着变
    s19c.litBefore === true && // 在「我喜欢的歌」里爱心是常亮的
    s19c.rowsAfter === s19b.lovedRows - 1 && // 再点一次就移出
    s19c.stillThere === false &&
    s19d.onCount === 0 && // 回到收藏夹，爱心状态持久（已灭）
    // ── 右键也能收藏 ──
    s19e.ok === true &&
    s19e.items.some((t) => t.includes('添加到「我喜欢的歌」')) && // 没收藏时给「添加」
    s19e.ctxHidden === true && // 点完菜单收起
    s19e.lit === true && // 行尾爱心同步点亮
    s19e.heartTitle.includes('已在我喜欢的歌里') &&
    s19f.ok === true &&
    s19f.hasRemove === true && // 已收藏时变成「移除」
    s19f.hasAdd === false && // 不再显示「添加」
    // ── 收藏夹条目在本应用隐藏 ──
    s20a.rows === 2 && // 仅音乐开着，第一个收藏夹显示 2 条
    s20b.ok === true && // 右键菜单里有隐藏项
    s20b.hasHideItem === true &&
    s20b.after === s20b.before - 1 && // 隐藏后少一条
    s20b.stillThere === false && // 被隐藏的那条不在了
    s20b.toast.includes('B 站收藏夹没有变化') && // 说明清楚没动 B 站
    s20c.stillThere === false && // 重新打开收藏夹仍然看不到
    s20c.sub.includes('已隐藏') && // 副标题标注隐藏数量
    s20d.ok === true &&
    s20d.confirmShown === true && // 恢复前先确认
    s20d.backAgain === true && // 恢复后那条回来了
    s20d.rows === s20a.rows; // 条数回到隐藏前
  log('UI_OK:', ok);
  proxy.stop();
  app.exit(ok ? 0 : 3);
}

main().catch((e) => {
  log('FATAL', e);
  try {
    app.exit(1);
  } catch {
    process.exit(1);
  }
});
