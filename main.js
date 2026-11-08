'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, shell, dialog, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const QRCode = require('qrcode');

const { Bili, cleanPartName, expandFavTracks } = require('./src/bili');
const { AudioProxy } = require('./src/audioProxy');
const { Store } = require('./src/store');
const { Library } = require('./src/library');
const { scanFolder, listAudioFiles } = require('./src/localLibrary');
const { SyncService } = require('./src/syncBridge');

// ---- 数据目录 ----
// 开发态：项目内 .userdata（便携，也规避本机 AppData 权限问题）
// 打包态：__dirname 在 app.asar 里是只读的，得落到用户目录。
// 但不能盲写 %APPDATA%：本机沙箱会拒绝创建 chromium 的 session/Network 等子目录 -> 写不进去就换下一个。
function pickDataDir() {
  if (!app.isPackaged) return path.join(__dirname, '.userdata');
  const candidates = [
    path.join(app.getPath('appData'), 'BiliMusic'),
    path.join(app.getPath('userData'), '..', 'BiliMusic'),
    path.join(app.getPath('temp'), 'BiliMusic'),
    path.join(path.dirname(app.getPath('exe')), 'BiliMusic-data'),
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // chromium 要往里建 session/Network、Code Cache 等，先真写一次探测
      const probe = path.join(dir, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return dir;
    } catch {
      /* 换下一个候选 */
    }
  }
  return path.join(app.getPath('temp'), 'BiliMusic');
}

const DATA_DIR = pickDataDir();
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* ignore */
}
app.setPath('userData', DATA_DIR);
app.setPath('sessionData', path.join(DATA_DIR, 'session'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const TRAY_PATH = path.join(__dirname, 'assets', 'tray.png');

/** @type {BrowserWindow|null} */
let win = null;
/** @type {Tray|null} */
let tray = null;
/** @type {Bili} */
let bili = null;
/** @type {AudioProxy} */
let proxy = null;
/** @type {Store} */
let store = null;
/** @type {Library} */
let library = null;
/** @type {SyncService} */
let sync = null;
let psbId = null;
let quitting = false;
/** 扫描任务状态，防止重复触发 */
let scanning = null;

const state = {
  playing: false,
  title: '',
  artist: '',
  floor: 'window', // window | tray
};

// ---------------------------------------------------------------- 单实例

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

// ---------------------------------------------------------------- 图标

function loadIcon(p, size) {
  try {
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return size ? img.resize({ width: size, height: size }) : img;
    }
  } catch {
    /* ignore */
  }
  return nativeImage.createEmpty();
}

// ---------------------------------------------------------------- 创建窗口

function createWindow() {
  const saved = store.get('windowBounds');
  const bounds =
    saved && Number(saved.width) > 400
      ? saved
      : { width: 1180, height: 760 };

  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    frame: false,
    backgroundColor: '#0f1115',
    title: 'Bili Music',
    icon: loadIcon(ICON_PATH),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (bounds.maximized) win.maximize();
    win.show();
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const b = win.getBounds();
    store.patch({ windowBounds: { ...b, maximized: win.isMaximized() } });
  };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);

  // 关闭 → 由设置 closeAction 决定：ask=问用户 / tray=收进托盘 / quit=退出
  win.on('close', (e) => {
    if (quitting) return;
    const action = store.get('closeAction');
    if (action === 'quit') {
      quitting = true;
      app.quit();
      return;
    }
    e.preventDefault();
    if (action === 'tray') {
      hideToTray();
      return;
    }
    // ask：把选择权交给用户（渲染进程弹窗）
    win.webContents.send('win:ask-close');
  });

  win.on('minimize', () => {
    if (store.get('minimizeToTray')) {
      hideToTray();
    }
  });

  win.on('closed', () => {
    win = null;
  });

  // 外链一律用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  state.floor = 'window';
  updateTray();
}

function hideToTray() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  state.floor = 'tray';
  updateTray();
}

// ---------------------------------------------------------------- 托盘

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: state.title ? truncate(`${state.title}`, 46) : '未在播放',
      enabled: false,
    },
    {
      label: state.artist ? `　${truncate(state.artist, 40)}` : '',
      enabled: false,
      visible: !!state.artist,
    },
    { type: 'separator' },
    { label: '上一首', click: () => send('media:prev'), enabled: state.playing || !!state.title },
    {
      label: state.playing ? '暂停' : '播放',
      click: () => send('media:toggle'),
    },
    { label: '下一首', click: () => send('media:next'), enabled: state.playing || !!state.title },
    { type: 'separator' },
    { label: '显示主界面', click: showWindow },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
  const tip = state.title
    ? `${state.playing ? '▶' : '⏸'} ${truncate(state.title, 40)}${state.artist ? ' - ' + truncate(state.artist, 20) : ''}`
    : 'Bili Music';
  tray.setToolTip(tip);
}

function createTray() {
  const img = loadIcon(TRAY_PATH, 16);
  tray = new Tray(img.isEmpty() ? loadIcon(ICON_PATH) : img);
  tray.setToolTip('Bili Music');
  tray.on('click', () => {
    if (win && win.isVisible() && !win.isMinimized()) {
      hideToTray();
    } else {
      showWindow();
    }
  });
  tray.on('double-click', showWindow);
  updateTray();
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function send(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.send(channel, payload);
  }
}

/**
 * 库内容被外部改动过（同步把对方的歌单/曲目并进来了）。
 * 通知渲染层重新拉一遍数据，否则界面还停在旧样子。
 */
function notifyLibraryChanged() {
  send('library:changed', { at: Date.now() });
}

/**
 * 本机的稳定设备标识，存在数据目录里。
 *
 * CRDT 里时间戳相同的两次并发写入要靠设备 id 定胜负，所以这个值必须**一次生成、
 * 永久不变**（换掉会让「同一毫秒内谁赢」的判定在新旧记录之间变得不一致）。
 */
function getDeviceId() {
  const f = path.join(DATA_DIR, 'device-id.txt');
  try {
    const s = fs.readFileSync(f, 'utf8').trim();
    if (/^d[0-9a-f]{10}$/.test(s)) return s;
  } catch {
    /* 没就生成 */
  }
  const id = 'd' + crypto.randomBytes(5).toString('hex');
  try {
    fs.writeFileSync(f, id, 'utf8');
  } catch {
    /* ignore */
  }
  return id;
}

// ---------------------------------------------------------------- 媒体键

const MEDIA_KEYS = ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop'];

function registerMediaKeys() {
  const map = {
    MediaPlayPause: 'media:toggle',
    MediaNextTrack: 'media:next',
    MediaPreviousTrack: 'media:prev',
    MediaStop: 'media:stop',
  };
  for (const key of MEDIA_KEYS) {
    try {
      globalShortcut.register(key, () => {
        send(map[key]);
      });
    } catch {
      /* 被其他播放器占用时跳过 */
    }
  }
}

function unregisterMediaKeys() {
  for (const key of MEDIA_KEYS) {
    try {
      globalShortcut.unregister(key);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- 开机自启

function getAutoLaunch() {
  try {
    return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
  } catch {
    return !!store.get('autoLaunch');
  }
}

function setAutoLaunch(enabled) {
  const opts = {
    openAtLogin: !!enabled,
    args: ['--hidden'],
    path: process.execPath,
  };
  try {
    app.setLoginItemSettings(opts);
    store.set('autoLaunch', !!enabled);
  } catch (e) {
    return { ok: false, error: e.message, enabled: getAutoLaunch() };
  }
  return { ok: true, enabled: getAutoLaunch() };
}

// ---------------------------------------------------------------- 电源

function updatePowerBlocker(playing) {
  try {
    if (playing && psbId === null) {
      psbId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!playing && psbId !== null) {
      powerSaveBlocker.stop(psbId);
      psbId = null;
    }
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- IPC

/** 把任意文本转成二维码图片 dataURL（同步配对串用） */
async function qrDataUrlOf(text) {
  if (!text) return '';
  try {
    return await QRCode.toDataURL(text, {
      margin: 1,
      width: 320,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
  } catch (e) {
    console.warn('[main] 生成同步二维码失败', e.message);
    return '';
  }
}

function registerIpc() {
  // --- 登录 ---
  ipcMain.handle('bili:qr-generate', async () => {
    await bili.ensureBuvid();
    const qr = await bili.qrGenerate();
    let dataUrl = '';
    try {
      dataUrl = await QRCode.toDataURL(qr.url, {
        margin: 1,
        width: 400,
        color: { dark: '#000000', light: '#ffffff' },
      });
    } catch (e) {
      console.warn('[main] 生成二维码图片失败', e.message);
    }
    return { ...qr, dataUrl };
  });

  ipcMain.handle('bili:qr-poll', async (_e, key) => bili.qrPoll(key));

  ipcMain.handle('bili:nav', async () => {
    try {
      return await bili.nav();
    } catch (e) {
      return { isLogin: false, error: e.message };
    }
  });

  ipcMain.handle('bili:logout', async () => {
    bili.logout();
    return { ok: true };
  });

  // --- 收藏夹 ---
  ipcMain.handle('bili:folders', async (_e, mid) => {
    const folders = await bili.favFolders(mid);
    return folders;
  });

  ipcMain.handle('bili:items', async (_e, { mediaId, max }) => {
    const { items, total } = await bili.favItems(mediaId, { max: max || 600 });
    // 已知元信息的立即补齐 cid / 是否音乐
    for (const it of items) {
      const meta = bili.videoMeta[it.bvid];
      if (meta) {
        it.cid = meta.cid;
        it.tid = meta.tid;
        it.tname = meta.tname;
        it.isMusic = meta.isMusic;
        it.resolved = true;
        // 多 P 视频：带上分 P 表，渲染端据此拆分成多条曲目
        if (meta.pages && meta.pages.length > 1) {
          it.pages = meta.pages.map((p) => ({
            page: p.page,
            cid: p.cid,
            part: p.part || '',
            duration: p.duration || 0,
          }));
        }
      }
    }
    return { items, total };
  });

  // 补全元信息（渲染端分批调用，避免一次请求太多）
  ipcMain.handle('bili:resolve', async (_e, bvids) => {
    const map = await bili.resolveMany(bvids, { concurrency: 4 });
    return [...map.entries()].map(([bvid, meta]) => ({
      bvid,
      ok: !!meta,
      cid: meta?.cid || 0,
      tid: meta?.tid || 0,
      tname: meta?.tname || '',
      isMusic: meta ? meta.isMusic : false,
      title: meta?.title || '',
      cover: meta?.pic || '',
      duration: meta?.duration || 0,
      owner: meta?.owner || '',
      // 多 P 视频：带上全部分 P，渲染端据此拆成多条曲目
      pages: (meta?.pages || []).map((p) => ({
        page: p.page,
        cid: p.cid,
        part: p.part || '',
        duration: p.duration || 0,
      })),
    }));
  });

  // --- 播放 ---
  ipcMain.handle('player:audio-url', async (_e, { bvid, cid, quality }) => {
    const nCid = Number(cid);
    // 先取流（同时校验可用性），再把结果预热进代理缓存，避免重复请求 playurl
    const streams = await bili.audioStreams(bvid, nCid);
    proxy.prime(bvid, nCid, streams);
    const q = quality ? String(quality) : '';
    const chosen = (q && streams.find((s) => String(s.id) === q)) || streams[0];
    return {
      url: proxy.audioUrl(bvid, nCid, chosen?.id || ''),
      qualityId: chosen?.id || 0,
      qualityLabel: chosen?.label || '',
      codecs: chosen?.codecs || '',
      available: streams.map((s) => ({ id: s.id, label: s.label })),
    };
  });

  ipcMain.handle('player:cover-url', async (_e, url) => proxy.coverUrl(url));

  // --- 本地库 ---
  ipcMain.handle('library:stats', async () => library.stats());

  ipcMain.handle('library:pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择音乐文件夹',
      properties: ['openDirectory'],
      buttonLabel: '扫描这个文件夹',
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    return { canceled: false, dir: r.filePaths[0] };
  });

  /** 扫描文件夹：先数文件，再读标签，全程推进度到渲染进程 */
  ipcMain.handle('library:scan', async (_e, { dir }) => {
    if (scanning) return { ok: false, error: '已有扫描任务在进行' };
    if (!dir) return { ok: false, error: '没有指定文件夹' };
    scanning = { dir, startedAt: Date.now() };
    try {
      const progress = (p) => send('library:scan-progress', { dir, ...p });
      progress({ phase: 'listing', files: 0, done: 0, total: 0 });
      const { tracks } = await scanFolder(dir, { onProgress: progress });
      const merged = library.upsertLocal(tracks);
      library.addFolder(dir, tracks.length);
      progress({ phase: 'done', files: tracks.length, done: tracks.length, total: tracks.length });
      return { ok: true, dir, scanned: tracks.length, ...merged };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      scanning = null;
    }
  });

  /** 只数一下有多少音频文件（不读标签，快） */
  ipcMain.handle('library:count-files', async (_e, { dir }) => {
    try {
      const files = await listAudioFiles(dir);
      return { ok: true, count: files.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('library:folders', async () => library.folders());

  ipcMain.handle('library:remove-folder', async (_e, { dir }) => {
    const folders = library.removeFolder(dir);
    return { ok: true, folders };
  });

  ipcMain.handle('library:local-tracks', async () => library.localTracks());

  ipcMain.handle('library:remove-local', async (_e, ids) => ({
    ok: true,
    removed: library.removeLocal(ids),
  }));

  /** 本地曲目的播放地址 */
  ipcMain.handle('player:local-url', async (_e, { id }) => {
    const t = library.getLocal(id);
    if (!t) throw new Error('本地曲目不存在');
    return { url: proxy.localUrl(id), title: t.title, artist: t.artist, cover: t.cover };
  });

  // --- 通过 B 站链接导入 ---
  ipcMain.handle('library:resolve-links', async (_e, { text }) => {
    try {
      const { tracks, failed } = await bili.resolveLinks(text);
      // 补上曲目 id 与元信息，供「我的库」直接使用
      const enriched = tracks.map((t) => ({
        ...t,
        isMusic: true,
        source: 'link',
      }));
      return { ok: true, tracks: enriched, failed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('library:add-bili', async (_e, { tracks, folderId }) => {
    const r = library.addBili(tracks, folderId || '');
    return { ok: true, ...r };
  });

  ipcMain.handle('library:bili-tracks', async () => library.biliTracks());

  ipcMain.handle('library:remove-bili', async (_e, bvids) => ({
    ok: true,
    removed: library.removeBili(bvids),
  }));

  // --- 歌单 ---
  ipcMain.handle('library:playlists', async () => library.playlists());

  ipcMain.handle('library:create-playlist', async (_e, { title }) => ({
    ok: true,
    playlist: library.createPlaylist(title),
  }));

  ipcMain.handle('library:rename-playlist', async (_e, { id, title }) => ({
    ok: true,
    playlist: library.renamePlaylist(id, title),
  }));

  ipcMain.handle('library:delete-playlist', async (_e, { id }) => ({
    ok: true,
    removed: library.deletePlaylist(id),
  }));

  ipcMain.handle('library:add-to-playlist', async (_e, { id, type, ids }) => ({
    ok: true,
    ...(library.addToPlaylist(id, type, ids) || { added: 0, total: 0 }),
  }));

  ipcMain.handle('library:remove-from-playlist', async (_e, { id, index }) => {
    const p = library.removeFromPlaylist(id, Number(index));
    return { ok: !!p };
  });

  ipcMain.handle('library:playlist-tracks', async (_e, { id }) => {
    const r = library.resolvePlaylist(id);
    if (!r) return { ok: false, error: '歌单不存在' };
    return {
      ok: true,
      playlist: { id: r.id, title: r.title, special: !!r.special },
      tracks: r.tracks,
    };
  });

  // --- 我喜欢的歌 ---
  ipcMain.handle('library:loved-tracks', async () => ({
    ok: true,
    tracks: library.lovedTracks(),
    total: library.lovedTracks().length,
    excluded: library.excludedCount(),
  }));

  ipcMain.handle('library:exclude-loved', async (_e, { type, id }) => ({
    ok: true,
    ...(library.excludeFromLoved(type, id) || {}),
  }));

  ipcMain.handle('library:include-loved', async (_e, { type, id }) => ({
    ok: true,
    ...(library.includeInLoved(type, id) || {}),
  }));

  /** 逐首点爱心：type 为 'local' | 'bili'，track 是完整曲目对象（未入库的也能收） */
  ipcMain.handle('library:add-loved', async (_e, { type, track }) => ({
    ok: true,
    ...(library.addToLoved(type, track) || {}),
  }));

  ipcMain.handle('library:remove-loved', async (_e, { type, track }) => ({
    ok: true,
    ...(library.removeFromLoved(type, track) || {}),
  }));

  /** 已收藏曲目的键集合，列表里用它点亮爱心 */
  ipcMain.handle('library:loved-keys', async () => ({
    ok: true,
    keys: library.lovedKeys(),
    total: library.lovedTracks().length,
  }));

  // --- 收藏夹条目在本应用内隐藏（不动 B 站） ---
  ipcMain.handle('library:hide-fav-item', async (_e, { folderId, item }) => ({
    ok: true,
    ...(library.hideFavItem(folderId, item) || {}),
  }));

  ipcMain.handle('library:unhide-fav-item', async (_e, { folderId, key }) => ({
    ok: true,
    ...(library.unhideFavItem(folderId, key) || {}),
  }));

  ipcMain.handle('library:hidden-keys', async (_e, { folderId }) => ({
    ok: true,
    keys: library.hiddenKeys(folderId),
  }));

  ipcMain.handle('library:hidden-items', async (_e, { folderId } = {}) => ({
    ok: true,
    items: library.hiddenItems(folderId),
    total: library.hiddenCount(),
  }));

  ipcMain.handle('library:clear-hidden', async (_e, { folderId } = {}) => ({
    ok: true,
    ...(library.clearHidden(folderId) || {}),
  }));

  /** 当前跟随的收藏夹（用于界面标星） */
  ipcMain.handle('library:fav-sources', async () => library.favSources());

  /**
   * 抓一个收藏夹的完整曲目（多 P 展开、非音乐过滤在 expandFavTracks 里统一处理）。
   * 跟随导入和一次性导入都走这里，保证两条路径收到的曲目一致。
   */
  async function fetchFolderTracks(folderId) {
    const fid = String(folderId);
    const { items } = await bili.favItems(fid, { max: 600 });
    const bvids = items.map((i) => i.bvid).filter(Boolean);
    const metas = await bili.resolveMany(bvids, { concurrency: 4 });
    const tracks = expandFavTracks(items, metas);
    const nav = await bili.nav().catch(() => null);
    const folders = nav?.mid ? await bili.favFolders(nav.mid).catch(() => []) : [];
    const title = (folders || []).find((f) => String(f.id) === fid)?.title;
    return { fid, title: title || '收藏夹', tracks };
  }

  /**
   * 把整个收藏夹导入「我喜欢的歌」并持续跟随。
   * 抓取的条目要先展开多 P、过滤非音乐，和界面里的逻辑保持一致，否则会收进一堆无关视频。
   */
  ipcMain.handle('library:follow-folder', async (_e, { folderId }) => {
    try {
      const { fid, title, tracks } = await fetchFolderTracks(folderId);
      const r = library.followFolder(fid, title, tracks);
      return { ok: true, ...r, sources: library.favSources(), once: library.favOnceSources() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 一次性把整个收藏夹批量加进「我喜欢的歌」，不跟随以后的变化 */
  ipcMain.handle('library:import-folder-once', async (_e, { folderId }) => {
    try {
      const { fid, title, tracks } = await fetchFolderTracks(folderId);
      const r = library.importFolderOnce(fid, title, tracks);
      return { ok: true, ...r, sources: library.favSources(), once: library.favOnceSources() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 取消跟随某个收藏夹 */
  ipcMain.handle('library:unfollow-folder', async (_e, { folderId }) => ({
    ok: true,
    sources: library.unfollowFolder(folderId),
    once: library.favOnceSources(),
  }));

  /** 把「一次性导入」的收藏夹整个从喜欢的歌里摘掉 */
  ipcMain.handle('library:remove-folder-once', async (_e, { folderId }) => ({
    ok: true,
    ...library.removeFolderOnce(folderId),
  }));

  /** 一次性导入来源列表 */
  ipcMain.handle('library:fav-once', async () => library.favOnceSources());

  /** 拖拽排序：把 from 挪到 to */
  ipcMain.handle('library:move-in-playlist', async (_e, { id, from, to }) => {
    const p = library.moveInPlaylist(id, Number(from), Number(to));
    return { ok: !!p, order: p ? p.items.map((i) => i.id) : [] };
  });

  /** 导出歌单到 JSON 文件 */
  ipcMain.handle('library:export-playlists', async (_e, { playlists: ids } = {}) => {
    try {
      const data = library.exportData(ids);
      const n = Object.keys(data.playlists).length;
      if (!n) return { ok: false, error: '没有可导出的歌单' };
      const r = await dialog.showSaveDialog(win, {
        title: '导出歌单',
        defaultPath: `bili-music-playlists-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      await fsp.writeFile(r.filePath, JSON.stringify(data, null, 2), 'utf8');
      return { ok: true, count: n, path: r.filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 从 JSON 文件导入歌单 */
  ipcMain.handle('library:import-playlists', async () => {
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '导入歌单',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      const raw = await fsp.readFile(r.filePaths[0], 'utf8');
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        return { ok: false, error: '文件不是合法的 JSON' };
      }
      const res = library.importData(obj);
      return { ok: true, ...res };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // --- 跨设备同步 ---
  /**
   * 这套通道和安卓端是同一套协议：交换的是一整份 SyncDoc 二进制载荷，
   * 两端各自 merge 之后自然收敛。没有服务器，也没有「谁说了算」。
   */
  ipcMain.handle('sync:info', async () => {
    const info = sync.info();
    return { ...info, qr: sync.pairingPayload(), qrDataUrl: await qrDataUrlOf(sync.pairingPayload()) };
  });

  ipcMain.handle('sync:start', async () => {
    try {
      const info = await sync.startServer();
      const payload = sync.pairingPayload();
      return { ok: true, ...info, qr: payload, qrDataUrl: await qrDataUrlOf(payload) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('sync:stop', async () => {
    sync.stopServer();
    return { ok: true, ...sync.info() };
  });

  /** 主动连对方（同一 Wi-Fi 下点一下设备名就走这里） */
  ipcMain.handle('sync:now', async (_e, { host, port, token }) => {
    try {
      const res = await sync.syncNow(host, Number(port), token);
      notifyLibraryChanged();
      return { ok: true, ...res };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * 文本同步码：把整份状态压成一段 base64url，微信/剪贴板都能传。
   * 没有同一 Wi-Fi 也能用，代价是超过几百首之后码会很长。
   */
  ipcMain.handle('sync:export-code', async () => {
    try {
      const code = sync.exportCode();
      return { ok: true, code, length: code.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('sync:import-code', async (_e, { code } = {}) => {
    try {
      if (!code || !String(code).trim()) return { ok: false, error: '同步码是空的' };
      const res = sync.importCode(String(code).trim());
      notifyLibraryChanged();
      return { ok: true, ...res };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 手动填对端地址（对方没被发现、或跨网段时用） */
  ipcMain.handle('sync:pair', async (_e, { text } = {}) => {
    try {
      const m = /^bilimusic:\/\/pair\?(.+)$/.exec(String(text || '').trim());
      if (!m) return { ok: false, error: '配对串格式不对' };
      const q = new URLSearchParams(m[1]);
      const host = q.get('ip');
      const port = Number(q.get('port'));
      const token = q.get('token');
      if (!host || !port || !token) return { ok: false, error: '配对串缺少字段' };
      const res = await sync.syncNow(host, port, token);
      notifyLibraryChanged();
      return { ok: true, ...res };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('player:state', async (_e, s) => {
    state.playing = !!s.playing;
    state.title = s.title || '';
    state.artist = s.artist || '';
    updatePowerBlocker(state.playing);
    updateTray();
    if (win && !win.isDestroyed()) win.setTitle(state.title ? `${state.title} - Bili Music` : 'Bili Music');
    return { ok: true };
  });

  // --- 设置 ---
  ipcMain.handle('store:all', async () => {
    const all = store.all();
    all.autoLaunch = getAutoLaunch();
    return all;
  });

  ipcMain.handle('store:set', async (_e, { key, value }) => {
    store.set(key, value);
    return { ok: true };
  });

  ipcMain.handle('store:patch', async (_e, obj) => {
    store.patch(obj);
    return { ok: true };
  });

  // --- 手动音乐标记 ---
  ipcMain.handle('music-override:all', async () => store.allMusicOverrides());

  ipcMain.handle('music-override:set', async (_e, { bvid, value }) => {
    const map = store.setMusicOverride(bvid, value);
    return { ok: true, map };
  });

  ipcMain.handle('music-override:merge', async (_e, obj) => {
    const map = store.mergeMusicOverrides(obj);
    return { ok: true, map };
  });

  ipcMain.handle('app:auto-launch', async (_e, enabled) => setAutoLaunch(enabled));

  // --- 窗口控制 ---
  ipcMain.handle('win:minimize', async () => {
    if (store.get('minimizeToTray')) hideToTray();
    else win?.minimize();
  });
  ipcMain.handle('win:maximize', async () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win:hide-to-tray', async () => hideToTray());
  ipcMain.handle('win:quit', async () => {
    quitting = true;
    app.quit();
  });
  ipcMain.handle('win:close', async () => {
    const action = store.get('closeAction');
    if (action === 'tray') {
      hideToTray();
    } else if (action === 'quit') {
      quitting = true;
      app.quit();
    } else {
      // ask：交给渲染进程弹窗
      if (win && !win.isDestroyed()) win.webContents.send('win:ask-close');
    }
  });
  ipcMain.handle('win:is-maximized', async () => !!win && win.isMaximized());

  ipcMain.handle('app:open-external', async (_e, url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dataDir: DATA_DIR,
    proxyPort: proxy.port,
  }));

  ipcMain.handle('app:clear-cache', async () => {
    proxy.invalidate();
    proxy.coverCache.clear();
    bili.videoMeta = {};
    try {
      fs.rmSync(path.join(DATA_DIR, 'video-meta.json'), { force: true });
    } catch {
      /* ignore */
    }
    return { ok: true };
  });
}

// ---------------------------------------------------------------- 生命周期

app.on('before-quit', () => {
  quitting = true;
  unregisterMediaKeys();
  updatePowerBlocker(false);
  if (sync) sync.stopServer();
  if (proxy) proxy.stop();
});

app.whenReady().then(async () => {
  store = new Store(path.join(DATA_DIR, 'settings.json'));
  library = new Library(path.join(DATA_DIR, 'library.json'));
  bili = new Bili(DATA_DIR);
  proxy = new AudioProxy(bili);
  // 本地曲目 id → 绝对路径，渲染进程永远看不到真实路径
  proxy.setLocalResolver((id) => {
    const t = library.getLocal(id);
    return t && t.path ? t.path : '';
  });
  await proxy.start();
  console.log('[main] audio proxy on', proxy.baseUrl);

  // 同步服务：不占固定端口（找系统要一个空闲口），设备名给对端做展示用
  sync = new SyncService({
    library,
    file: path.join(DATA_DIR, 'sync-state.json'),
    deviceId: getDeviceId(),
    deviceName: os.hostname() || 'Windows',
  });

  registerIpc();
  createWindow();
  createTray();
  registerMediaKeys();

  const hidden = process.argv.includes('--hidden');
  if (hidden && win) {
    win.once('ready-to-show', () => {
      win.hide();
      state.floor = 'tray';
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('window-all-closed', () => {
  // 托盘常驻，不自动退出
});

process.on('uncaughtException', (e) => {
  console.error('[main] uncaught', e);
  try {
    dialog.showErrorBox('Bili Music 发生错误', String(e && e.stack ? e.stack : e));
  } catch {
    /* ignore */
  }
});
