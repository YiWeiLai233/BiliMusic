'use strict';
/**
 * UI 自检用的假 preload：把 window.api 换成可控的桩，
 * 让 renderer/app.js 在离线假数据下跑完整流程。
 */
const { contextBridge } = require('electron');

const HOME = process.env.SMOKE_HOME || '';
// 主进程通过 ipc 提供真实的 playurl 代理地址
const { ipcRenderer } = require('electron');

/** 手动音乐标记（测试里可变） */
const OVERRIDES = {};

/** 本地库 / 链接导入的假数据（测试里可变） */
const LIB_FOLDERS = [];
const LIB_LOCAL = {};
const LIB_BILI = {};
const LIB_PLAYLISTS = {};
/** 「我喜欢的歌」相关假数据 */
const LOVE_EXCLUDED = {};
const LOVED_MANUAL = {};
/** 收藏夹条目隐藏表：`${folderId}:${key}` → 记录 */
const FAV_HIDDEN = {};
const FAV_SOURCES = {};
const FAV_TRACKS = {};
const FAV_ONCE = {};

const CALLLIB = (s) => CALLS.push(s);

/** 合并三个来源 + 手动收藏，算出「我喜欢的歌」当前内容（测试桩和主进程逻辑保持一致） */
function buildLoved() {
  const out = [];
  const seen = new Set();
  const push = (type, t) => {
    if (!t) return;
    const id = t.id || t.bvid;
    if (!id) return;
    const k = `${type}:${id}`;
    if (LOVE_EXCLUDED[k] || seen.has(k)) return;
    seen.add(k);
    out.push({ ...t, _type: type, _key: k });
  };
  for (const t of Object.values(LIB_LOCAL)) push('local', t);
  for (const t of Object.values(LIB_BILI)) push('bili', t);
  for (const tracks of Object.values(FAV_TRACKS)) {
    for (const t of Object.values(tracks)) push('bili', t);
  }
  for (const rec of Object.values(LOVED_MANUAL)) {
    if (rec && rec.track) push(rec.type, rec.track);
  }
  out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  return out;
}

/** 造一条本地曲目假数据 */
function makeLocalTrack(id, title, artist) {
  return {
    id,
    kind: 'local',
    bvid: '',
    path: `C:\\Fake\\Music\\${title}.wav`,
    name: `${title}.wav`,
    size: 88244,
    mtime: Date.now(),
    title,
    artist,
    album: '假专辑',
    duration: 2,
    cover: '',
    tagged: true,
    missing: false,
  };
}

const FAKE_FOLDERS = [
  { id: 1001, title: '我的音乐收藏', mediaCount: 3 },
  { id: 1002, title: '纯音乐 / 轻音乐', mediaCount: 2 },
  // 放在最后，避免打乱既有场景按下标点收藏夹的顺序
  { id: 1003, title: '多P 合集收藏', mediaCount: 1 },
];

const RAW = {
  1001: [
    {
      bvid: 'BV1GJ411x7h7',
      aid: 1,
      title: '【官方 MV】Never Gonna Give You Up - Rick Astley',
      cover: '',
      duration: 213,
      upper: 'Rick Astley',
      resolved: false,
    },
    {
      bvid: 'BV2GJ411x7h7',
      aid: 2,
      title: '一首被过滤掉的非音乐视频',
      cover: '',
      duration: 300,
      upper: '某 UP 主',
      resolved: false,
    },
    {
      bvid: 'BV3GJ411x7h7',
      aid: 3,
      title: '测试曲目三号',
      cover: '',
      duration: 128,
      upper: '测试 UP',
      resolved: false,
    },
  ],
  1002: [
    {
      bvid: 'BV3GJ411x7h7',
      aid: 3,
      title: '测试曲目三号',
      cover: '',
      duration: 128,
      upper: '测试 UP',
      resolved: false,
    },
    {
      bvid: 'BV1GJ411x7h7',
      aid: 1,
      title: '夜跑 BGM',
      cover: '',
      duration: 213,
      upper: 'Rick Astley',
      resolved: false,
    },
  ],
  // 多 P 视频：一条收藏应被拆成 3 条曲目
  1003: [
    {
      bvid: 'BV4GJ411x7h7',
      aid: 4,
      title: '多P音乐合集',
      cover: '',
      duration: 310,
      upper: '合集 UP',
      resolved: false,
    },
  ],
};

const CALLS = [];
const LISTENERS = {};

/** 鍏嬮殕鐨勫悓姝ョ姸鎬侊紙鐢卞墽鏈殑鍚屾闈㈡澘鍐冲畾锛?*/
const FAKE_SYNC = {
  running: false,
  ip: '',
  port: 0,
  token: '',
  peers: [],
  stats: { tracks: 3, playlists: 2, loved: 1, tombstones: 0, device: 'd0000000009' },
  status: { kind: 'idle', message: '' },
};

function syncState() {
  return {
    running: FAKE_SYNC.running,
    ip: FAKE_SYNC.ip,
    port: FAKE_SYNC.port,
    token: FAKE_SYNC.token,
    device: FAKE_SYNC.stats.device,
    deviceName: 'SMOKE-PC',
    peers: FAKE_SYNC.peers.slice(),
    stats: { ...FAKE_SYNC.stats },
    status: { ...FAKE_SYNC.status },
    qr: FAKE_SYNC.running ? 'bilimusic://pair?ip=192.168.1.23&port=47821&token=abc123def456' : '',
    qrDataUrl: '',
  };
}

contextBridge.exposeInMainWorld('api', {
  bili: {
    qrGenerate: async () => ({ url: 'https://example.com/qr', key: 'k', dataUrl: '' }),
    qrPoll: async () => ({ state: 'waiting', message: '等待扫码' }),
    nav: async () => {
      CALLS.push('nav');
      return { isLogin: true, mid: 12345, uname: '测试用户', face: '', vip: false, level: 6 };
    },
    logout: async () => ({ ok: true }),
    folders: async (mid) => {
      CALLS.push(`folders:${mid}`);
      return FAKE_FOLDERS;
    },
    items: async (mediaId) => {
      CALLS.push(`items:${mediaId}`);
      const items = RAW[mediaId] || [];
      return { items: JSON.parse(JSON.stringify(items)), total: items.length };
    },
    resolve: async (bvids) => {
      CALLS.push(`resolve:${bvids.length}`);
      return bvids.map((bvid) => ({
        bvid,
        ok: true,
        cid: bvid === 'BV4GJ411x7h7' ? 400001 : 137649199,
        tid: bvid === 'BV2GJ411x7h7' ? 17 : 193,
        tname: bvid === 'BV2GJ411x7h7' ? '单机游戏' : '音乐',
        isMusic: bvid !== 'BV2GJ411x7h7',
        title: bvid === 'BV4GJ411x7h7' ? '多P音乐合集' : '',
        cover: '',
        duration: 0,
        owner: '',
        // BV4GJ411x7h7 是多 P 视频：三个分 P 应被拆成三条独立曲目
        pages:
          bvid === 'BV4GJ411x7h7'
            ? [
                { page: 1, cid: 400001, part: '第一曲', duration: 100 },
                { page: 2, cid: 400002, part: '第二曲', duration: 120 },
                { page: 3, cid: 400003, part: '', duration: 90 },
              ]
            : [],
      }));
    },
  },
  player: {
    audioUrl: async (bvid, cid, quality) => {
      CALLS.push(`audioUrl:${bvid}:${cid}:${quality}`);
      const real = await ipcRenderer.invoke('test:audio-url', { bvid, cid, quality });
      return real;
    },
    coverUrl: async (url) => {
      CALLS.push(`coverUrl`);
      return url || '';
    },
    localUrl: async (id) => {
      CALLS.push(`localUrl:${id}`);
      // 用主进程的真实代理地址服务一个 WAV，验证本地走代理这条链路
      const url = await ipcRenderer.invoke('test:local-url', { id });
      return { url, title: '', artist: '', cover: '' };
    },
    reportState: async (s) => {
      CALLS.push(`state:${s.playing ? 'play' : 'pause'}`);
      return { ok: true };
    },
  },
  store: {
    all: async () => ({
      quality: 0,
      volume: 0.8,
      muted: false,
      playMode: 'loop-all',
      closeAction: 'ask',
      minimizeToTray: false,
      autoLaunch: false,
      onlyMusic: true,
      lastFolderId: 1001,
      windowBounds: null,
    }),
    set: async () => ({ ok: true }),
    patch: async () => ({ ok: true }),
  },
  music: {
    all: async () => ({ ...OVERRIDES }),
    set: async (bvid, value) => {
      CALLS.push(`music-override:${bvid}:${value === null ? 'null' : value}`);
      if (value === null) delete OVERRIDES[bvid];
      else OVERRIDES[bvid] = value;
      return { ok: true, map: { ...OVERRIDES } };
    },
    merge: async (obj) => ({ ok: true, map: { ...OVERRIDES, ...obj } }),
  },
  library: {
    stats: async () => ({
      folders: LIB_FOLDERS.length,
      local: Object.keys(LIB_LOCAL).length,
      bili: Object.keys(LIB_BILI).length,
      playlists: Object.keys(LIB_PLAYLISTS).length,
    }),
    pickFolder: async () => {
      CALLLIB('lib:pickFolder');
      return { canceled: false, dir: 'C:\\Fake\\Music' };
    },
    countFiles: async () => ({ ok: true, count: 2 }),
    scan: async () => {
      CALLLIB('lib:scan');
      // 模拟扫描入库两首本地音乐
      const t1 = makeLocalTrack('Ltest1', '晨光', '测试歌手');
      const t2 = makeLocalTrack('Ltest2', '夜航', '测试歌手');
      LIB_LOCAL[t1.id] = t1;
      LIB_LOCAL[t2.id] = t2;
      LIB_FOLDERS.push({ dir: 'C:\\Fake\\Music', addedAt: Date.now(), count: 2 });
      return { ok: true, scanned: 2, added: 2, updated: 0, total: 2 };
    },
    folders: async () => JSON.parse(JSON.stringify(LIB_FOLDERS)),
    removeFolder: async (dir) => {
      CALLLIB(`lib:removeFolder:${dir}`);
      const i = LIB_FOLDERS.findIndex((f) => f.dir === dir);
      if (i >= 0) LIB_FOLDERS.splice(i, 1);
      return { ok: true };
    },
    localTracks: async () => Object.values(LIB_LOCAL).map((t) => ({ ...t })),
    removeLocal: async (ids) => {
      CALLLIB(`lib:removeLocal:${ids.length}`);
      for (const id of ids) delete LIB_LOCAL[id];
      return { ok: true };
    },
    resolveLinks: async (text) => {
      CALLLIB(`lib:resolveLinks:${String(text).length}`);
      // 假解析：单 P 两条 + 多 P 三条，覆盖「只导入指定分 P」的勾选场景
      return {
        ok: true,
        tracks: [
          {
            id: 'BV9GJ411x7h7',
            bvid: 'BV9GJ411x7h7',
            cid: 900001,
            title: '链接导入的曲目一',
            artist: '链接 UP',
            duration: 180,
            cover: '',
            page: 1,
            multiPage: false,
            isMusic: true,
            source: 'link',
          },
          {
            id: 'BV8GJ411x7h7',
            bvid: 'BV8GJ411x7h7',
            cid: 900002,
            title: '链接导入的曲目二',
            artist: '链接 UP',
            duration: 200,
            cover: '',
            page: 1,
            multiPage: false,
            isMusic: true,
            source: 'link',
          },
          {
            id: 'BV7GJ411x7h7:p1',
            bvid: 'BV7GJ411x7h7',
            cid: 900011,
            title: '多P链接合集 · P1 开场',
            artist: '多P UP',
            duration: 100,
            cover: '',
            page: 1,
            part: '开场',
            multiPage: true,
            isMusic: true,
            source: 'link',
          },
          {
            id: 'BV7GJ411x7h7:p2',
            bvid: 'BV7GJ411x7h7',
            cid: 900012,
            title: '多P链接合集 · P2 高潮',
            artist: '多P UP',
            duration: 120,
            cover: '',
            page: 2,
            part: '高潮',
            multiPage: true,
            isMusic: true,
            source: 'link',
          },
          {
            id: 'BV7GJ411x7h7:p3',
            bvid: 'BV7GJ411x7h7',
            cid: 900013,
            title: '多P链接合集 · P3 尾声',
            artist: '多P UP',
            duration: 90,
            cover: '',
            page: 3,
            part: '尾声',
            multiPage: true,
            isMusic: true,
            source: 'link',
          },
        ],
        failed: [],
      };
    },
    addBili: async (tracks) => {
      CALLLIB(`lib:addBili:${tracks.length}`);
      for (const t of tracks) LIB_BILI[t.id || t.bvid] = t;
      return { ok: true, added: tracks.length, total: Object.keys(LIB_BILI).length };
    },
    biliTracks: async () => Object.values(LIB_BILI).map((t) => ({ ...t })),
    removeBili: async (ids) => {
      CALLLIB(`lib:removeBili:${ids.length}`);
      for (const b of ids) delete LIB_BILI[b];
      return { ok: true };
    },
    playlists: async () => Object.values(LIB_PLAYLISTS).map((p) => ({ ...p })),
    // ── 我喜欢的歌 ──
    lovedTracks: async () => {
      const out = buildLoved();
      return { ok: true, tracks: out, total: out.length, excluded: Object.keys(LOVE_EXCLUDED).length };
    },
    lovedKeys: async () => {
      const out = buildLoved();
      return { ok: true, keys: out.map((t) => t._key), total: out.length };
    },
    addToLoved: async (type, track) => {
      CALLLIB(`lib:addLoved:${type}:${track.id}`);
      const id = track.id || track.localId || track.bvid;
      LOVED_MANUAL[`${type}:${id}`] = { type, track: { ...track, id }, addedAt: Date.now() };
      delete LOVE_EXCLUDED[`${type}:${id}`];
      return { ok: true };
    },
    removeFromLoved: async (type, track) => {
      const id = track.id || track.localId || track.bvid;
      CALLLIB(`lib:removeLoved:${type}:${id}`);
      delete LOVED_MANUAL[`${type}:${id}`];
      LOVE_EXCLUDED[`${type}:${id}`] = true;
      return { ok: true };
    },
    excludeFromLoved: async (type, id) => {
      CALLLIB(`lib:excludeLoved:${type}:${id}`);
      delete LOVED_MANUAL[`${type}:${id}`];
      LOVE_EXCLUDED[`${type}:${id}`] = true;
      return { ok: true };
    },
    // ── 收藏夹条目在本应用内隐藏 ──
    hideFavItem: async (folderId, item) => {
      const key = item.key || item.bvid;
      CALLLIB(`lib:hide:${folderId}:${key}`);
      FAV_HIDDEN[`${folderId}:${key}`] = { folderId: String(folderId), key, ...item };
      return { ok: true, total: Object.keys(FAV_HIDDEN).length };
    },
    unhideFavItem: async (folderId, key) => {
      CALLLIB(`lib:unhide:${folderId}:${key}`);
      delete FAV_HIDDEN[`${folderId}:${key}`];
      return { ok: true, total: Object.keys(FAV_HIDDEN).length };
    },
    hiddenKeys: async (folderId) => {
      const fid = String(folderId);
      const keys = Object.values(FAV_HIDDEN)
        .filter((h) => String(h.folderId) === fid)
        .map((h) => h.key);
      return { ok: true, keys };
    },
    hiddenItems: async (folderId) =>
      folderId == null
        ? { ok: true, items: Object.values(FAV_HIDDEN), total: Object.keys(FAV_HIDDEN).length }
        : {
            ok: true,
            items: Object.values(FAV_HIDDEN).filter((h) => String(h.folderId) === String(folderId)),
            total: Object.keys(FAV_HIDDEN).length,
          },
    clearHidden: async (folderId) => {
      CALLLIB(`lib:clearHidden:${folderId ?? 'all'}`);
      if (folderId == null) {
        for (const k of Object.keys(FAV_HIDDEN)) delete FAV_HIDDEN[k];
      } else {
        for (const [k, h] of Object.entries(FAV_HIDDEN)) {
          if (String(h.folderId) === String(folderId)) delete FAV_HIDDEN[k];
        }
      }
      return { ok: true, total: Object.keys(FAV_HIDDEN).length };
    },
    includeInLoved: async (type, id) => {
      CALLLIB(`lib:includeLoved:${type}:${id}`);
      delete LOVE_EXCLUDED[`${type}:${id}`];
      return { ok: true };
    },
    favSources: async () => Object.values(FAV_SOURCES).map((s) => ({ ...s })),
    followFolder: async (folderId) => {
      CALLLIB(`lib:followFolder:${folderId}`);
      const fid = String(folderId);
      const tracks = {};
      for (const b of Object.values(LIB_BILI)) {
        const key = b.id || b.bvid;
        tracks[key] = { ...b };
      }
      FAV_TRACKS[fid] = tracks;
      FAV_SOURCES[fid] = {
        id: fid,
        title: '假收藏夹',
        addedAt: Date.now(),
        syncedAt: Date.now(),
        count: Object.keys(tracks).length,
      };
      return { ok: true, added: Object.keys(tracks).length, total: Object.keys(tracks).length, sources: Object.values(FAV_SOURCES) };
    },
    unfollowFolder: async (folderId) => {
      CALLLIB(`lib:unfollowFolder:${folderId}`);
      const fid = String(folderId);
      delete FAV_TRACKS[fid];
      delete FAV_SOURCES[fid];
      delete FAV_ONCE[fid];
      return { ok: true, sources: Object.values(FAV_SOURCES), once: Object.values(FAV_ONCE) };
    },
    // 一次性批量导入：不跟随，靠 FAV_ONCE 标记来源
    importFolderOnce: async (folderId) => {
      CALLLIB(`lib:importFolderOnce:${folderId}`);
      const fid = String(folderId);
      const tracks = FAV_TRACKS[fid] || {};
      let added = 0;
      for (const b of Object.values(LIB_BILI)) {
        const key = b.id || b.bvid;
        if (!tracks[key]) added++;
        tracks[key] = { ...b };
      }
      FAV_TRACKS[fid] = tracks;
      delete FAV_SOURCES[fid];
      FAV_ONCE[fid] = { id: fid, title: '假收藏夹', addedAt: Date.now(), count: Object.keys(tracks).length };
      return {
        ok: true,
        added,
        total: Object.keys(tracks).length,
        sources: Object.values(FAV_SOURCES),
        once: Object.values(FAV_ONCE),
      };
    },
    favOnce: async () => Object.values(FAV_ONCE).map((s) => ({ ...s })),
    removeFolderOnce: async (folderId) => {
      CALLLIB(`lib:removeFolderOnce:${folderId}`);
      const fid = String(folderId);
      delete FAV_TRACKS[fid];
      delete FAV_ONCE[fid];
      return { ok: true, sources: Object.values(FAV_SOURCES), once: Object.values(FAV_ONCE) };
    },
    createPlaylist: async (title) => {
      const id = 'p' + Date.now();
      LIB_PLAYLISTS[id] = { id, title, items: [], createdAt: Date.now() };
      return { ok: true, playlist: LIB_PLAYLISTS[id] };
    },
    renamePlaylist: async (id, title) => {
      if (LIB_PLAYLISTS[id]) LIB_PLAYLISTS[id].title = title;
      return { ok: true };
    },
    deletePlaylist: async (id) => {
      delete LIB_PLAYLISTS[id];
      return { ok: true };
    },
    addToPlaylist: async (id, type, ids) => {
      CALLLIB(`lib:addToPlaylist:${type}:${ids.length}`);
      const p = LIB_PLAYLISTS[id];
      if (p) {
        for (const i of ids) {
          if (!p.items.some((x) => x.type === type && x.id === i)) p.items.push({ type, id: i });
        }
      }
      return { ok: true, added: ids.length };
    },
    removeFromPlaylist: async (id, index) => {
      CALLLIB(`lib:removeFromPlaylist:${index}`);
      const p = LIB_PLAYLISTS[id];
      if (p && index >= 0 && index < p.items.length) p.items.splice(index, 1);
      return { ok: true };
    },
    moveInPlaylist: async (id, from, to) => {
      CALLLIB(`lib:move:${from}->${to}`);
      const p = LIB_PLAYLISTS[id];
      if (p && from !== to && from >= 0 && from < p.items.length) {
        const [it] = p.items.splice(from, 1);
        p.items.splice(Math.max(0, Math.min(p.items.length, to)), 0, it);
      }
      return { ok: true, order: (p ? p.items : []).map((i) => i.id) };
    },
    exportPlaylists: async (ids) => {
      CALLLIB(`lib:export:${(ids || []).length}`);
      return { ok: true, count: (ids && ids.length) || Object.keys(LIB_PLAYLISTS).length, path: 'C:\\Fake\\out.json' };
    },
    importPlaylists: async () => {
      CALLLIB('lib:import');
      // 模拟导入一个新歌单
      const id = 'pimport';
      LIB_PLAYLISTS[id] = { id, title: '导入的歌单', items: [], createdAt: Date.now() };
      return { ok: true, playlists: 1, tracks: 0, merged: 0 };
    },
    playlistTracks: async (id) => {
      const p = LIB_PLAYLISTS[id];
      if (!p) return { ok: false, error: '歌单不存在' };
      const tracks = [];
      for (const it of p.items) {
        const t = it.type === 'local' ? LIB_LOCAL[it.id] : LIB_BILI[it.id];
        if (t) tracks.push({ ...t, _type: it.type });
      }
      return { ok: true, playlist: { id: p.id, title: p.title }, tracks };
    },
  },
  app: {
    autoLaunch: async () => ({ ok: true, enabled: false }),
    info: async () => ({ version: '0.1.0', electron: '33', chrome: '130', node: '20', dataDir: HOME, proxyPort: 0 }),
    openExternal: async () => {},
    clearCache: async () => ({ ok: true }),
  },
  sync: {
    info: async () => syncState(),
    start: async () => {
      CALLS.push('sync:start');
      FAKE_SYNC.running = true;
      FAKE_SYNC.port = 47821;
      FAKE_SYNC.ip = '192.168.1.23';
      FAKE_SYNC.token = 'abc123def456';
      return { ok: true, ...syncState() };
    },
    stop: async () => {
      CALLS.push('sync:stop');
      FAKE_SYNC.running = false;
      FAKE_SYNC.peers = [];
      return { ok: true, ...syncState() };
    },
    now: async (host, port, token) => {
      CALLS.push(`sync:now:${host}:${port}:${token}`);
      return { ok: true, message: '同步完成：新增 1 首新歌、1 个歌单' };
    },
    pair: async (text) => {
      CALLS.push(`sync:pair:${text}`);
      return { ok: true, message: '同步完成：已是最新' };
    },
    exportCode: async () => {
      CALLS.push('sync:exportCode');
      return { ok: true, code: 'BMsFAKEfakecodeEXAMPLE0123456789', length: 30 };
    },
    importCode: async (code) => {
      CALLS.push(`sync:importCode:${String(code).slice(0, 8)}`);
      return { ok: true, message: '同步完成：新增 2 首新歌' };
    },
  },
  win: {
    minimize: async () => {},
    maximize: async () => false,
    hideToTray: async () => {
      CALLS.push('win:hideToTray');
    },
    close: async () => {
      CALLS.push('win:close');
    },
    quit: async () => {
      CALLS.push('win:quit');
    },
    isMaximized: async () => false,
  },
  on: (channel, cb) => {
    const list = LISTENERS[channel] || (LISTENERS[channel] = []);
    list.push(cb);
    return () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  },
  __calls: async () => CALLS.slice(),
  __emit: (channel, payload) => {
    for (const cb of LISTENERS[channel] || []) cb(payload);
  },
});
