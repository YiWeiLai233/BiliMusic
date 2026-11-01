'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  audio: $('audio'),
  folderList: $('folder-list'),
  folderTitle: $('folder-title'),
  folderSub: $('folder-sub'),
  songList: $('song-list'),
  search: $('search-input'),
  onlyMusic: $('chk-only-music'),
  btnPlayAll: $('btn-play-all'),
  btnPlay: $('btn-play'),
  iconPlay: $('icon-play'),
  btnPrev: $('btn-prev'),
  btnNext: $('btn-next'),
  btnMode: $('btn-mode'),
  iconMode: $('icon-mode'),
  btnQuality: $('btn-quality'),
  qLabel: $('q-label'),
  btnMute: $('btn-mute'),
  iconVolume: $('icon-volume'),
  barProgress: $('bar-progress'),
  progFill: $('prog-fill'),
  progKnob: $('prog-knob'),
  timeCur: $('time-cur'),
  timeTotal: $('time-total'),
  barVolume: $('bar-volume'),
  volFill: $('vol-fill'),
  pbCover: $('pb-cover'),
  pbTitle: $('pb-title'),
  pbArtist: $('pb-artist'),
  userCard: $('user-card'),
  userAvatar: $('user-avatar'),
  userName: $('user-name'),
  userSub: $('user-sub'),
  btnLogin: $('btn-login'),
  loginMask: $('login-mask'),
  qrWrap: $('qr-wrap'),
  qrStatus: $('qr-status'),
  settingsMask: $('settings-mask'),
  qualityPop: $('quality-pop'),
  toast: $('toast'),
  btnRefreshFolders: $('btn-refresh-folders'),
  btnTray: $('btn-tray'),
  // 我的库
  libraryList: $('library-list'),
  btnAddFolder: $('btn-add-folder'),
  btnAddLink: $('btn-add-link'),
  linkMask: $('link-mask'),
  linkInput: $('link-input'),
  btnLinkParse: $('btn-link-parse'),
  btnLinkClose: $('btn-link-close'),
  btnLinkConfirm: $('btn-link-confirm'),
  btnLinkAll: $('btn-link-all'),
  btnLinkNone: $('btn-link-none'),
  linkHint: $('link-hint'),
  linkResult: $('link-result'),
  linkResultCount: $('link-result-count'),
  linkList: $('link-list'),
  scanMask: $('scan-mask'),
  scanDir: $('scan-dir'),
  scanBarFill: $('scan-bar-fill'),
  scanStatus: $('scan-status'),
  ctxMenu: $('ctx-menu'),
  btnNewPlaylist: $('btn-new-playlist'),
  btnLibMenu: $('btn-lib-menu'),
  plMask: $('pl-mask'),
  plTitle: $('pl-title'),
  plName: $('pl-name'),
  plHint: $('pl-hint'),
  btnPlOk: $('btn-pl-ok'),
  btnPlCancel: $('btn-pl-cancel'),
  btnPlClose: $('btn-pl-close'),
};

const ICON_PLAY = '<path d="M8 5v14l11-7z"/>';
const ICON_PAUSE = '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>';

const MODES = ['loop-all', 'loop-one', 'shuffle'];
const MODE_ICON = {
  'loop-all': '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>',
  'loop-one':
    '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="15.5" font-size="8" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif" font-weight="700">1</text>',
  shuffle:
    '<path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>',
};
const MODE_LABEL = { 'loop-all': '列表循环', 'loop-one': '单曲循环', shuffle: '随机播放' };

/** 音质 id → 播放条上的短标签 */
const Q_SHORT = { 30280: '192K', 30232: '132K', 30216: '64K', 30250: '杜比', 30251: 'HiRes' };
const qShort = (id) => Q_SHORT[Number(id)] || '自动';

const state = {
  user: null,
  folders: [],
  folder: null,
  /** @type {Array<any>} 已解析元信息的原始条目 */
  rawItems: [],
  /** @type {Array<any>} 过滤后当前列表 */
  list: [],
  index: -1,
  /** @type {string} 当前正在播放的 bvid（列表会因过滤重建，靠它保持身份） */
  currentBvid: '',
  /** @type {any} 当前正在播放的条目对象（列表过滤时依然有效） */
  currentItem: null,
  playing: false,
  mode: 'loop-all',
  quality: 0,
  volume: 0.8,
  muted: false,
  onlyMusic: true,
  /** @type {Object<string, boolean>} bvid → true=手动音乐 false=手动非音乐 */
  overrides: {},
  keyword: '',
  currentUrl: '',
  mediaBase: '',
  loading: false,
  resolving: 0,
  resolveTotal: 0,
  settings: {},
  rowEls: new Map(),
  playSeq: 0,
  /** 当前视图来源：'folder'（B 站收藏夹） | 'local'（本地全部） | 'bili-lib'（链接导入的） | 'loved'（我喜欢的歌） | 'playlist' */
  source: 'folder',
  /** @type {Array<{dir:string,count:number}>} */
  libFolders: [],
  /** @type {Array<any>} 链接导入的 B 站曲目 */
  libBili: [],
  /** @type {Array<any>} 「我喜欢的歌」的曲目缓存 */
  lovedTracks: [],
  /** @type {number} 「我喜欢的歌」曲目数（侧边栏角标用） */
  lovedCount: 0,
  /** @type {number} 从「我喜欢的歌」里手动移除的数量 */
  lovedExcluded: 0,
  /** @type {Set<string>} 「我喜欢的歌」里已有曲目的键（`${type}:${id}`），用于点亮列表爱心 */
  lovedKeys: new Set(),
  /** @type {Set<string>} 当前收藏夹里被隐藏掉的条目键（只在本应用不显示，B 站收藏夹不变） */
  hiddenKeys: new Set(),
  /** @type {Array<any>} 正在跟随的收藏夹 [{id,title,count,syncedAt}] */
  favSources: [],
  /** @type {Array<any>} 一次性批量导入过的收藏夹 [{id,title,count}]（不跟随变化） */
  favOnce: [],
  /** @type {Array<any>} 解析出来待确认的链接曲目 */
  pendingTracks: [],
  /** 链接弹层里当前勾选的条目下标（Set<number>） */
  linkPicked: new Set(),
  /** @type {string} 正在查看的歌单 id */
  playlistId: '',
  /** @type {string} 歌单标题（媒体浮层用） */
  playlistTitle: '',
  /** @type {Array<any>} 歌单列表 */
  playlists: [],
  /** @type {number} 歌单拖拽时的源下标，-1=没在拖 */
  dragFrom: -1,
};

// ═════════════════════════════════ 工具 ═════════════════════════════════

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

let toastTimer = null;
/** ms <= 0 表示常驻，直到下一次 toast 覆盖 */
function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  if (!(ms > 0)) return;
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, ms);
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function setCover(node, url) {
  if (!url) {
    node.style.backgroundImage = '';
    node.classList.remove('has-img');
    return;
  }
  node.style.backgroundImage = `url("${url}")`;
  node.classList.add('has-img');
}

// ═════════════════════════════════ 登录 ═════════════════════════════════

async function refreshNav() {
  try {
    const nav = await window.api.bili.nav();
    if (nav && nav.isLogin) {
      state.user = nav;
      el.userName.textContent = nav.uname || '已登录';
      el.userSub.textContent = `UID ${nav.mid}${nav.vip ? ' · 大会员' : ''}`;
      el.btnLogin.textContent = '退出';
      el.btnLogin.classList.add('ghost');
      if (nav.face) el.userAvatar.style.backgroundImage = `url("${nav.face}")`;
      el.userAvatar.textContent = nav.face ? '' : (nav.uname || '?').slice(0, 1);
      return true;
    }
  } catch (e) {
    console.warn('nav 失败', e);
  }
  state.user = null;
  el.userName.textContent = '未登录';
  el.userSub.textContent = '扫码登录 B 站';
  el.btnLogin.textContent = '登录';
  el.btnLogin.classList.remove('ghost');
  el.userAvatar.style.backgroundImage = '';
  el.userAvatar.textContent = '?';
  return false;
}

let qrTimer = null;
let qrToken = 0;

async function openLogin() {
  el.loginMask.hidden = false;
  el.qrWrap.innerHTML = '<div class="qr-skeleton">加载中…</div>';
  el.qrStatus.textContent = '正在获取二维码…';
  el.qrStatus.className = 'qr-status';

  const my = ++qrToken;
  let data;
  try {
    data = await window.api.bili.qrGenerate();
  } catch (e) {
    el.qrStatus.textContent = `二维码获取失败：${e.message}`;
    el.qrStatus.className = 'qr-status err';
    return;
  }
  if (my !== qrToken) return;

  el.qrWrap.innerHTML = `<img alt="登录二维码" src="${data.dataUrl}" />`;
  el.qrStatus.textContent = '请使用哔哩哔哩手机客户端扫码';

  clearInterval(qrTimer);
  qrTimer = setInterval(async () => {
    if (my !== qrToken) {
      clearInterval(qrTimer);
      return;
    }
    let r;
    try {
      r = await window.api.bili.qrPoll(data.key);
    } catch (e) {
      el.qrStatus.textContent = `轮询失败：${e.message}`;
      el.qrStatus.className = 'qr-status err';
      return;
    }
    if (my !== qrToken) return;
    el.qrStatus.textContent = r.message;
    el.qrStatus.className = 'qr-status' + (r.state === 'ok' ? ' ok' : r.state === 'expired' ? ' err' : '');

    if (r.state === 'ok') {
      clearInterval(qrTimer);
      closeLogin();
      toast('登录成功');
      const ok = await refreshNav();
      if (ok) loadFolders();
    } else if (r.state === 'expired') {
      clearInterval(qrTimer);
      el.qrStatus.textContent = '二维码已失效，点击刷新';
      el.qrStatus.className = 'qr-status err';
      el.qrWrap.style.cursor = 'pointer';
      el.qrWrap.onclick = () => {
        el.qrWrap.onclick = null;
        el.qrWrap.style.cursor = '';
        openLogin();
      };
    }
  }, 1600);
}

function closeLogin() {
  qrToken++;
  clearInterval(qrTimer);
  el.loginMask.hidden = true;
}

// ═════════════════════════════════ 收藏夹 ═════════════════════════════════

async function loadFolders() {
  if (!state.user) {
    el.folderList.innerHTML = '<div class="empty-hint">登录后自动加载</div>';
    return;
  }
  el.folderList.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const folders = await window.api.bili.folders(state.user.mid);
    state.folders = folders;
    renderFolders();
    const last = state.settings.lastFolderId;
    const pick = folders.find((f) => f.id === last) || folders[0];
    if (pick) selectFolder(pick.id);
  } catch (e) {
    el.folderList.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderFolders() {
  if (!state.folders.length) {
    el.folderList.innerHTML = '<div class="empty-hint">还没有收藏夹</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const f of state.folders) {
    const following = state.favSources.some((s) => String(s.id) === String(f.id));
    const once = (state.favOnce || []).some((s) => String(s.id) === String(f.id));
    const loved = following || once;
    const node = document.createElement('div');
    node.className = 'folder-item' + (state.folder && state.folder.id === f.id ? ' active' : '');
    node.dataset.id = String(f.id);
    node.innerHTML = `
      <button class="fav-heart${loved ? ' on' : ''}${following ? ' follow' : ''}" title="${
        following
          ? '已持续跟随到「我喜欢的歌」，点击取消'
          : once
            ? '已批量加入「我喜欢的歌」（不跟随更新），点击移除'
            : '加入「我喜欢的歌」并持续跟随'
      }">${HEART_SVG}</button>
      <svg class="folder-icon" viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>
      <span class="folder-name">${esc(f.title)}</span>
      ${following ? '<span class="fav-following" title="持续跟随中">★</span>' : ''}
      <span class="folder-count">${f.mediaCount || ''}</span>`;
    node.onclick = () => selectFolder(f.id);
    // 爱心：单击=持续跟随（网易云那种），右键或加号给一次性批量导入
    const heart = node.querySelector('.fav-heart');
    heart.onclick = (e) => {
      e.stopPropagation();
      if (following) unfollowFolder(f);
      else if (once) removeFolderOnce(f);
      else followFolder(f);
    };
    heart.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openFolderMenu(e, f, { following, once });
    };
    node.oncontextmenu = (e) => {
      e.preventDefault();
      // 必须拦住冒泡，否则 document 上的「点别处关菜单」会立刻把刚弹出的菜单关掉
      e.stopPropagation();
      openFolderMenu(e, f, { following, once });
    };
    frag.appendChild(node);
  }
  el.folderList.innerHTML = '';
  el.folderList.appendChild(frag);
}

/** 收藏夹行的右键/爱心右键菜单：批量导入「我喜欢的歌」的几种方式 */
function openFolderMenu(ev, f, { following, once }) {
  const items = [];
  if (!following) {
    items.push({
      label: '加入「我喜欢的歌」（持续跟随）',
      onClick: () => followFolder(f),
    });
  } else {
    items.push({
      label: '取消跟随「我喜欢的歌」',
      onClick: () => unfollowFolder(f),
    });
  }
  if (!once && !following) {
    items.push({
      label: '一次性全量加入「我喜欢的歌」',
      onClick: () => importFolderOnce(f),
    });
  }
  if (once) {
    items.push({
      label: '从「我喜欢的歌」移出这个收藏夹',
      danger: true,
      onClick: () => removeFolderOnce(f),
    });
  }
  showContextMenu(ev, items);
}

async function selectFolder(id) {
  const folder = state.folders.find((f) => f.id === id);
  if (!folder) return;
  state.source = 'folder';
  state.playlistId = '';
  state.playlistTitle = '';
  state.folder = folder;
  state.settings.lastFolderId = id;
  window.api.store.set('lastFolderId', id);
  renderFolders();
  renderLibrary();

  el.folderTitle.textContent = folder.title;
  el.folderSub.textContent = '正在加载…';
  el.songList.innerHTML =
    '<div class="list-empty"><div class="list-empty-icon">⏳</div><p>正在加载</p><span>请稍候</span></div>';

  try {
    const { items, total } = await window.api.bili.items(folder.id, 600);
    // 本应用里隐藏过的条目：加载时就滤掉，界面上不出现
    try {
      const h = await window.api.library.hiddenKeys(folder.id);
      state.hiddenKeys = new Set((h && h.keys) || []);
    } catch {
      state.hiddenKeys = new Set();
    }
    // 先把多 P 展开成独立条目，再按精确的条目键过滤（分 P 可以单独隐藏）
    state.rawItems = expandPages(items).filter((it) => !state.hiddenKeys.has(keyOf(it)));
    state.resolving = 0;
    state.resolveTotal = state.rawItems.length;
    const hiddenN = state.hiddenKeys.size;
    el.folderSub.textContent =
      `共 ${total || items.length} 个条目` + (hiddenN ? ` · 已隐藏 ${hiddenN} 个` : '');
    applyFilter();
    resolveMissing();
    // 跟着走的收藏夹：每次打开就静默同步一次，新增的歌自动进「我喜欢的歌」
    if (state.favSources.some((s) => String(s.id) === String(folder.id))) {
      syncFollowedFolder(folder);
    }
  } catch (e) {
    el.folderSub.textContent = '加载失败';
    el.songList.innerHTML = `<div class="list-empty"><div class="list-empty-icon">!</div><p>加载失败</p><span>${esc(e.message)}</span></div>`;
  }
}

// ═════════════════════════════════ 我的库 ═════════════════════════════════

const LIB_ICON_LOCAL = '<path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>';
const LIB_ICON_LINK =
  '<path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 0-10z"/>';
const LIB_ICON_LIST =
  '<path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/>';
const LIB_ICON_LOVE =
  '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>';

/** 收藏夹行前面的爱心图标（和网易云一样，点了就收进「我喜欢的歌」） */
const HEART_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;

/** 「我喜欢的歌」的标题（固定，不可改名） */
const LOVE_TITLE = '我喜欢的歌';

/** 渲染侧边栏「我的库」：我喜欢的歌 / 本地曲目 / 链接导入 / 歌单 */
function renderLibrary() {
  const frag = document.createDocumentFragment();

  const mkItem = (icon, title, count, active, onClick, onDelete) => {
    const node = document.createElement('div');
    node.className = 'folder-item kind-lib' + (active ? ' active' : '');
    node.innerHTML = `
      <svg class="folder-icon" viewBox="0 0 24 24">${icon}</svg>
      <span class="folder-name">${esc(title)}</span>
      <span class="folder-count lib-count">${count || ''}</span>
      ${onDelete ? '<button class="lib-del" title="移除">✕</button>' : ''}`;
    node.onclick = onClick;
    if (onDelete) {
      const del = node.querySelector('.lib-del');
      del.onclick = (e) => {
        e.stopPropagation();
        onDelete();
      };
    }
    return node;
  };

  // 我喜欢的歌：本地 + 链接收藏 + 跟随的收藏夹，自动汇总，永远排最前
  frag.appendChild(
    mkItem(
      LIB_ICON_LOVE,
      LOVE_TITLE,
      state.lovedCount || '',
      state.source === 'loved',
      () => showLoved(),
      null,
    ),
  );

  // 本地音乐（合并成一个入口）
  const localCount = state.libFolders.reduce((n, f) => n + (f.count || 0), 0);
  frag.appendChild(
    mkItem(
      LIB_ICON_LOCAL,
      '本地音乐',
      localCount || '',
      state.source === 'local',
      () => showLocal(),
      localCount ? () => removeAllFolders() : null,
    ),
  );

  // 通过链接导入的 B 站曲目
  if (state.libBili.length) {
    frag.appendChild(
      mkItem(
        LIB_ICON_LINK,
        '链接收藏',
        state.libBili.length,
        state.source === 'bili-lib',
        () => showBiliLib(),
        null,
      ),
    );
  }

  // 歌单
  for (const pl of state.playlists) {
    const node = mkItem(
      LIB_ICON_LIST,
      pl.title,
      pl.items.length,
      state.source === 'playlist' && state.playlistId === pl.id,
      () => showPlaylist(pl.id),
      () => deletePlaylist(pl.id),
    );
    // 双击名字直接改名
    node.querySelector('.folder-name').ondblclick = (e) => {
      e.stopPropagation();
      renamePlaylistInline(pl, node.querySelector('.folder-name'));
    };
    frag.appendChild(node);
  }

  el.libraryList.innerHTML = '';
  if (!frag.childNodes.length) {
    el.libraryList.innerHTML = '<div class="empty-hint">还没有本地音乐</div>';
    return;
  }
  el.libraryList.appendChild(frag);
}

/** 侧边栏里原地重命名歌单（双击名字触发） */
function renamePlaylistInline(pl, nameNode) {
  const input = document.createElement('input');
  input.className = 'folder-rename';
  input.value = pl.title;
  input.maxLength = 60;
  nameNode.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    if (!commit || !next || next === pl.title) {
      await refreshLibraryData();
      return;
    }
    try {
      await window.api.library.renamePlaylist(pl.id, next);
      if (state.playlistId === pl.id) {
        state.playlistTitle = next;
        el.folderTitle.textContent = next;
      }
      toast('歌单已重命名', 1600);
    } catch (e) {
      toast(`重命名失败：${e.message}`, 2800);
    }
    await refreshLibraryData();
  };

  input.onblur = () => finish(true);
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  // 点输入框时不要触发歌单跳转
  input.onclick = (e) => e.stopPropagation();
}

/** 显示「我喜欢的歌」：本地 + 链接收藏 + 跟随收藏夹的自动汇总 */
async function showLoved() {
  state.source = 'loved';
  state.folder = null;
  state.playlistId = '';
  state.playlistTitle = LOVE_TITLE;
  renderLibrary();
  renderFolders();

  el.folderTitle.textContent = LOVE_TITLE;
  el.folderSub.textContent = '正在读取…';
  try {
    const r = await window.api.library.lovedTracks();
    if (!r.ok) throw new Error(r.error || '读取失败');
    const tracks = r.tracks || [];
    state.lovedTracks = tracks;
    state.lovedCount = tracks.length;
    state.lovedExcluded = r.excluded || 0;
    // 收藏夹来源优先显示分 P 拆分后的标题，和收藏夹里看到的一致
    state.rawItems = tracks.map((t) => (t._type === 'local' ? localToItem(t) : libBiliToItem(t)));
    state.lovedKeys = new Set(tracks.map((t) => t._key).filter(Boolean));
    const follow = state.favSources.length;
    el.folderSub.textContent =
      `共 ${state.rawItems.length} 首` +
      (follow ? ` · 跟随 ${follow} 个收藏夹` : '') +
      (state.lovedExcluded ? ` · 已移除 ${state.lovedExcluded} 首` : '');
    applyFilter();
    renderLibrary();
  } catch (e) {
    el.folderSub.textContent = '读取失败';
    el.songList.innerHTML = `<div class="list-empty"><div class="list-empty-icon">!</div><p>读取失败</p><span>${esc(e.message)}</span></div>`;
  }
}

/** 静默同步一个已跟随的收藏夹（打开收藏夹时触发） */
async function syncFollowedFolder(f) {
  try {
    const r = await window.api.library.followFolder(f.id);
    if (!r.ok) return;
    await refreshLibraryData();
    renderFolders();
    if (r.added > 0) toast(`「${f.title}」有 ${r.added} 首新歌已进入我喜欢的歌`, 3000);
    if (state.source === 'loved') await showLoved();
  } catch {
    /* 同步失败不打扰用户，下次打开再试 */
  }
}

/** 把整个收藏夹导入「我喜欢的歌」并持续跟随 */
async function followFolder(f) {
  const t = toast(`正在导入「${f.title}」…`, 0);
  try {
    const r = await window.api.library.followFolder(f.id);
    if (!r.ok) throw new Error(r.error || '导入失败');
    await refreshLibraryData();
    renderFolders();
    toast(`「${f.title}」已导入我喜欢的歌：${r.total} 首`, 2600);
    if (state.source === 'loved') await showLoved();
  } catch (e) {
    toast(`导入失败：${e.message}`, 3200);
  }
}

/** 取消跟随某个收藏夹 */
async function unfollowFolder(f) {
  const ok = await confirmDialog(
    '取消跟随',
    `不再跟随「${f.title}」？\n已收进「我喜欢的歌」的歌会留在库里，只是以后收藏夹新增的歌不会再自动同步。`,
  );
  if (!ok) return;
  try {
    await window.api.library.unfollowFolder(f.id);
    await refreshLibraryData();
    renderFolders();
    toast(`已取消跟随「${f.title}」`, 2200);
    if (state.source === 'loved') await showLoved();
  } catch (e) {
    toast(`取消失败：${e.message}`, 3000);
  }
}

/** 一次性把整个收藏夹批量加进「我喜欢的歌」（不跟随以后的变化） */
async function importFolderOnce(f) {
  const t = toast(`正在把「${f.title}」加入我喜欢的歌…`, 0);
  try {
    const r = await window.api.library.importFolderOnce(f.id);
    if (!r.ok) throw new Error(r.error || '导入失败');
    await refreshLibraryData();
    renderFolders();
    toast(
      r.added > 0
        ? `已加入我喜欢的歌：新增 ${r.added} 首（不跟随更新）`
        : `「${f.title}」里的歌都已经在了`,
      2800,
    );
    if (state.source === 'loved') await showLoved();
  } catch (e) {
    toast(`加入失败：${e.message}`, 3200);
  }
}

/** 把一次性导入的收藏夹整个从「我喜欢的歌」里摘掉 */
async function removeFolderOnce(f) {
  const ok = await confirmDialog(
    '移出我喜欢的歌',
    `把「${f.title}」批量加入的歌从「我喜欢的歌」里移除？\n本地文件和链接收藏不受影响。`,
  );
  if (!ok) return;
  try {
    await window.api.library.removeFolderOnce(f.id);
    await refreshLibraryData();
    renderFolders();
    toast(`已移出「${f.title}」`, 2200);
    if (state.source === 'loved') await showLoved();
  } catch (e) {
    toast(`移出失败：${e.message}`, 3000);
  }
}

/** 从「我喜欢的歌」里移除一首（只移出歌单，库里还在） */
async function removeFromLoved(item) {
  const type = item.kind === 'local' ? 'local' : 'bili';
  const id = item.kind === 'local' ? item.localId : item.libId || item.bvid;
  try {
    const r = await window.api.library.excludeFromLoved(type, id);
    state.lovedKeys.delete(`${type}:${id}`);
    state.lovedExcluded = r?.total != null ? state.lovedExcluded + 1 : state.lovedExcluded;
    toast(`已移出我喜欢的歌：${item.title}`, 2200);
    await refreshLibraryData();
    if (state.source === 'loved') await showLoved();
  } catch (e) {
    toast(`移除失败：${e.message}`, 3000);
  }
}

/** 显示所有本地音乐 */
async function showLocal() {
  state.source = 'local';
  state.folder = null;
  state.playlistId = '';
  state.playlistTitle = '';
  renderLibrary();
  renderFolders();

  el.folderTitle.textContent = '本地音乐';
  el.folderSub.textContent = '正在读取…';
  try {
    const tracks = await window.api.library.localTracks();
    state.rawItems = tracks.map(localToItem).sort((a, b) => {
      const ua = (a.upper || '').toLowerCase();
      const ub = (b.upper || '').toLowerCase();
      if (ua !== ub) return ua < ub ? -1 : 1;
      const aa = (a.album || '').toLowerCase();
      const ab = (b.album || '').toLowerCase();
      if (aa !== ab) return aa < ab ? -1 : 1;
      return String(a.title).localeCompare(String(b.title), 'zh');
    });
    const missing = state.rawItems.filter((x) => x.missing).length;
    el.folderSub.textContent = `共 ${state.rawItems.length} 首${missing ? ` · ${missing} 首文件丢失` : ''}`;
    applyFilter();
  } catch (e) {
    el.folderSub.textContent = '读取失败';
    el.songList.innerHTML = `<div class="list-empty"><div class="list-empty-icon">!</div><p>读取失败</p><span>${esc(e.message)}</span></div>`;
  }
}

/** 显示通过链接导入的 B 站曲目 */
async function showBiliLib() {
  state.source = 'bili-lib';
  state.folder = null;
  state.playlistId = '';
  state.playlistTitle = '';
  renderLibrary();
  renderFolders();

  el.folderTitle.textContent = '链接收藏';
  el.folderSub.textContent = '正在读取…';
  try {
    const tracks = await window.api.library.biliTracks();
    state.libBili = tracks;
    state.rawItems = tracks.map(libBiliToItem);
    el.folderSub.textContent = `共 ${state.rawItems.length} 首`;
    applyFilter();
  } catch (e) {
    el.folderSub.textContent = '读取失败';
    el.songList.innerHTML = `<div class="list-empty"><div class="list-empty-icon">!</div><p>读取失败</p><span>${esc(e.message)}</span></div>`;
  }
}

/** 显示某个歌单 */
async function showPlaylist(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) return;
  state.source = 'playlist';
  state.folder = null;
  state.playlistId = id;
  state.playlistTitle = pl.title;
  renderLibrary();
  renderFolders();

  el.folderTitle.textContent = pl.title;
  el.folderSub.textContent = '正在读取…';
  try {
    const r = await window.api.library.playlistTracks(id);
    if (!r.ok) throw new Error(r.error || '读取失败');
    state.rawItems = (r.tracks || []).map((t) => (t._type === 'local' ? localToItem(t) : libBiliToItem(t)));
    el.folderSub.textContent = `共 ${state.rawItems.length} 首`;
    applyFilter();
  } catch (e) {
    el.folderSub.textContent = '读取失败';
    el.songList.innerHTML = `<div class="list-empty"><div class="list-empty-icon">!</div><p>读取失败</p><span>${esc(e.message)}</span></div>`;
  }
}

// ═════════════════════════════════ 库操作 ═════════════════════════════════

/** 刷新侧边栏「我的库」的数据 */
async function refreshLibraryData() {
  try {
    const [folders, biliTracks, playlists, favSources, favOnce, loved, lovedKeys] = await Promise.all([
      window.api.library.folders(),
      window.api.library.biliTracks(),
      window.api.library.playlists(),
      window.api.library.favSources(),
      window.api.library.favOnce(),
      window.api.library.lovedTracks(),
      window.api.library.lovedKeys(),
    ]);
    state.libFolders = folders || [];
    state.libBili = biliTracks || [];
    state.playlists = playlists || [];
    state.favSources = favSources || [];
    state.favOnce = favOnce || [];
    state.lovedCount = (loved && loved.tracks && loved.tracks.length) || 0;
    state.lovedExcluded = (loved && loved.excluded) || 0;
    state.lovedKeys = new Set((lovedKeys && lovedKeys.keys) || []);
  } catch {
    state.libFolders = [];
    state.libBili = [];
    state.playlists = [];
    state.favSources = [];
    state.favOnce = [];
    state.lovedCount = 0;
    state.lovedExcluded = 0;
    state.lovedKeys = new Set();
  }
  renderLibrary();
}

/** 添加本地音乐文件夹：选目录 → 扫描（带进度）→ 入库 */
async function addLocalFolder() {
  let pick;
  try {
    pick = await window.api.library.pickFolder();
  } catch (e) {
    toast(`选择文件夹失败：${e.message}`, 3000);
    return;
  }
  if (!pick || pick.canceled) return;

  // 先数一下文件，让进度条有分母
  el.scanMask.hidden = false;
  el.scanDir.textContent = pick.dir;
  el.scanBarFill.style.width = '0%';
  el.scanStatus.textContent = '正在统计文件…';

  const off = window.api.on('library:scan-progress', (p) => {
    if (p.phase === 'listing' || p.phase === 'list') {
      el.scanStatus.textContent = `已找到 ${p.files} 个音频文件`;
      return;
    }
    if (p.phase === 'tags') {
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      el.scanBarFill.style.width = `${pct}%`;
      el.scanStatus.textContent = `正在读取标签 ${p.done} / ${p.total}`;
      return;
    }
    if (p.phase === 'done') {
      el.scanBarFill.style.width = '100%';
      el.scanStatus.textContent = `完成，共 ${p.files} 首`;
    }
  });

  try {
    const r = await window.api.library.scan(pick.dir);
    if (!r.ok) throw new Error(r.error || '扫描失败');
    toast(`已扫描 ${r.scanned} 个文件，新增 ${r.added} 首`, 2600);
    await refreshLibraryData();
    await showLocal();
  } catch (e) {
    toast(`扫描失败：${e.message}`, 3200);
  } finally {
    off();
    setTimeout(() => {
      el.scanMask.hidden = true;
    }, 400);
  }
}

/** 移除所有本地音乐文件夹（连同曲目） */
async function removeAllFolders() {
  if (!state.libFolders.length) return;
  const ok = await confirmDialog(
    '移除所有本地音乐？',
    `会从库里移除 ${state.libFolders.length} 个文件夹的索引，不会删除磁盘上的文件。`,
  );
  if (!ok) return;
  for (const f of state.libFolders) {
    try {
      await window.api.library.removeFolder(f.dir);
    } catch {
      /* 继续删下一个 */
    }
  }
  toast('已移除本地音乐索引', 2200);
  await refreshLibraryData();
  if (state.source === 'local') {
    if (state.libFolders.length) await showLocal();
    else {
      state.source = 'folder';
      state.rawItems = [];
      state.list = [];
      el.folderTitle.textContent = '选择一个收藏夹';
      el.folderSub.textContent = '登录 B 站后，这里会列出你的收藏夹';
      renderSongs();
    }
  }
}

/** 删除歌单 */
async function deletePlaylist(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) return;
  const ok = await confirmDialog('删除歌单？', `「${pl.title}」会被删除，里面的歌不会从库里移除。`);
  if (!ok) return;
  await window.api.library.deletePlaylist(id);
  toast('歌单已删除', 1800);
  await refreshLibraryData();
  if (state.playlistId === id) {
    state.playlistId = '';
    state.source = 'folder';
    state.rawItems = [];
    state.list = [];
    el.folderTitle.textContent = '选择一个收藏夹';
    el.folderSub.textContent = '登录 B 站后，这里会列出你的收藏夹';
    renderSongs();
  }
}

/** ── 新建 / 重命名歌单的输入弹层 ── */
function promptPlaylistTitle({ title = '新建歌单', value = '' } = {}) {
  return new Promise((resolve) => {
    el.plTitle.textContent = title;
    el.plName.value = value;
    el.plHint.textContent = '';
    el.plHint.className = 'pl-hint';
    el.plMask.hidden = false;
    el.plName.focus();
    el.plName.select();

    const done = (result) => {
      el.plMask.hidden = true;
      el.btnPlOk.onclick = null;
      el.btnPlCancel.onclick = null;
      el.btnPlClose.onclick = null;
      el.plName.onkeydown = null;
      resolve(result);
    };

    const submit = () => {
      const name = el.plName.value.trim();
      if (!name) {
        el.plHint.textContent = '名字不能为空';
        el.plHint.className = 'pl-hint err';
        return;
      }
      done(name);
    };

    el.btnPlOk.onclick = submit;
    el.btnPlCancel.onclick = () => done(null);
    el.btnPlClose.onclick = () => done(null);
    el.plName.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') done(null);
    };
  });
}

/** 新建歌单并刷新侧栏 */
async function newPlaylist() {
  const name = await promptPlaylistTitle();
  if (!name) return null;
  try {
    const r = await window.api.library.createPlaylist(name);
    toast(`歌单「${name}」已创建`, 2000);
    await refreshLibraryData();
    if (r?.playlist?.id) await showPlaylist(r.playlist.id);
    return r?.playlist || null;
  } catch (e) {
    toast(`创建失败：${e.message}`, 3000);
    return null;
  }
}

/** 「我的库」右上角的导出/导入菜单 */
function openLibraryMenu(ev) {
  closeContextMenu();

  const rows = [];
  const add = (label, fn, cls = '') => rows.push({ label, fn, cls });
  const hasPlaylists = state.playlists.length > 0;

  if (hasPlaylists) {
    add(`导出全部歌单（${state.playlists.length} 个）`, async () => {
      const r = await window.api.library.exportPlaylists();
      if (r.canceled) return;
      if (!r.ok) throw new Error(r.error || '导出失败');
      toast(`已导出 ${r.count} 个歌单`, 2400);
    });
  }
  if (state.source === 'playlist' && state.playlistId) {
    const cur = state.playlists.find((p) => p.id === state.playlistId);
    if (cur) {
      add(`只导出「${cur.title}」`, async () => {
        const r = await window.api.library.exportPlaylists([cur.id]);
        if (r.canceled) return;
        if (!r.ok) throw new Error(r.error || '导出失败');
        toast('已导出', 2000);
      });
    }
  }
  add('从 JSON 导入歌单…', async () => {
    const r = await window.api.library.importPlaylists();
    if (r.canceled) return;
    if (!r.ok) throw new Error(r.error || '导入失败');
    await refreshLibraryData();
    toast(`导入完成：${r.playlists} 个歌单，${r.tracks} 首曲目${r.merged ? `，合并 ${r.merged} 首` : ''}`, 3200);
  });

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const node = document.createElement('div');
    node.className = 'ctx-item' + (r.cls ? ' ' + r.cls : '');
    node.textContent = r.label;
    node.onclick = () => {
      closeContextMenu();
      Promise.resolve(r.fn()).catch((err) => toast(`操作失败：${err.message}`, 3000));
    };
    frag.appendChild(node);
  }
  el.ctxMenu.innerHTML = '';
  el.ctxMenu.appendChild(frag);
  el.ctxMenu.hidden = false;

  const rect = el.ctxMenu.getBoundingClientRect();
  const x = Math.min(ev.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(ev.clientY + 6, window.innerHeight - rect.height - 8);
  el.ctxMenu.style.left = `${Math.max(8, x)}px`;
  el.ctxMenu.style.top = `${Math.max(8, y)}px`;
}

/**
 * 通用右键菜单渲染：把 [{label,onClick,danger}|{sep}|{label,static}] 贴在鼠标位置。
 * 曲目行和收藏夹行共用。
 */
function showContextMenu(ev, rows) {
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const node = document.createElement('div');
    if (r.sep) {
      node.className = 'ctx-sep';
    } else if (r.static) {
      node.className = 'ctx-label';
      node.textContent = r.label;
    } else {
      const cls = r.danger || r.cls === 'danger' ? ' danger' : '';
      node.className = 'ctx-item' + cls;
      node.textContent = r.label;
      node.onclick = () => {
        closeContextMenu();
        Promise.resolve(r.onClick ? r.onClick() : r.fn()).catch((e) =>
          toast(`操作失败：${e.message}`, 2800),
        );
      };
    }
    frag.appendChild(node);
  }
  el.ctxMenu.innerHTML = '';
  el.ctxMenu.appendChild(frag);
  el.ctxMenu.hidden = false;

  // 贴住鼠标但不溢出窗口
  const rect = el.ctxMenu.getBoundingClientRect();
  const x = Math.min(ev.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(ev.clientY, window.innerHeight - rect.height - 8);
  el.ctxMenu.style.left = `${Math.max(8, x)}px`;
  el.ctxMenu.style.top = `${Math.max(8, y)}px`;
}

/** ── 曲目右键菜单 ── */
function closeContextMenu() {
  el.ctxMenu.hidden = true;
  el.ctxMenu.innerHTML = '';
}

/**
 * 在鼠标位置弹出菜单。
 * @param {MouseEvent} ev
 * @param {any} item 当前行对应的条目
 * @param {number} index 当前行在 state.list 里的下标
 */
function openContextMenu(ev, item, index) {
  ev.preventDefault();
  ev.stopPropagation();
  closeContextMenu();

  const rows = [];
  const add = (label, fn, cls = '') => rows.push({ label, fn, cls });
  const sep = () => rows.push({ sep: true });
  const label = (text) => rows.push({ label: text, static: true });

  // 播放相关
  add('播放', () => playIndex(index));
  add('下一首播放', () => {
    const rest = state.list.filter((_, i) => i !== index);
    const cur = current();
    state.list = cur ? [cur, item, ...rest.filter((x) => x !== item && x !== cur)] : [item, ...rest];
    toast('已插入下一首', 1600);
    renderSongs();
  });
  sep();

  // 我喜欢的歌：没收藏就给「添加」，已收藏就给「删除」（和行尾爱心等价）。
  // 在「我喜欢的歌」视图里不重复加，那边已经有专门的删除项。
  if (state.source !== 'loved') {
    if (isLovedItem(item)) {
      add('从我喜欢的歌删除', () => toggleLoved(item), 'danger');
    } else {
      add('添加到「我喜欢的歌」', () => toggleLoved(item));
    }
  }

  // 恢复自动判断（仅当这首被手动标过时出现）
  if (!isLocal(item) && overrideOf(item) !== undefined) {
    sep();
    add('恢复自动判断', async () => {
      const k = overrideKeyOf(item);
      delete state.overrides[k];
      applyFilter();
      try {
        await window.api.music.set(k, null);
        toast('已恢复自动判断', 1800);
      } catch (e) {
        toast(`保存失败：${e.message}`, 2600);
      }
    });
  }

  // 歌单
  if (state.playlists.length) {
    label('加入歌单');
    for (const pl of state.playlists) {
      add(pl.title, async () => {
        const type = isLocal(item) ? 'local' : 'bili';
        const id = isLocal(item) ? item.localId : keyOf(item);
        const r = await window.api.library.addToPlaylist(pl.id, type, [id]);
        if (r && r.added === 0) toast('这首歌已在歌单里', 1800);
        else toast(`已加入「${pl.title}」`, 1800);
        await refreshLibraryData();
      });
    }
  }
  add('新建歌单并加入…', async () => {
    const pl = await newPlaylist();
    if (!pl) return;
    const type = isLocal(item) ? 'local' : 'bili';
    const id = isLocal(item) ? item.localId : keyOf(item);
    await window.api.library.addToPlaylist(pl.id, type, [id]);
    toast(`已加入「${pl.title}」`, 1800);
    await refreshLibraryData();
  });

  // 从当前歌单里移除
  if (state.source === 'playlist' && state.playlistId) {
    sep();
    add(
      '从本歌单移除',
      async () => {
        await window.api.library.removeFromPlaylist(state.playlistId, index);
        toast('已移出歌单', 1600);
        await refreshLibraryData();
        await showPlaylist(state.playlistId);
      },
      'danger',
    );
  }

  // 从「我喜欢的歌」里删掉（只记排除，库里的歌还在，收藏夹也不动）。
  // 这个视图下**只**提供这一种删除方式：同一首歌如果同时出现「从链接收藏移除」，
  // 两个删法容易点错，所以下面所有库里删除项在 loved 视图里一律不出现。
  if (state.source === 'loved') {
    sep();
    add('从我喜欢的歌删除', () => removeFromLoved(item), 'danger');
  } else {
    // 库里删掉
    sep();
    if (isLocal(item)) {
      add(
        '从库中移除（不删文件）',
        async () => {
          const ok = await confirmDialog('从库中移除？', `「${item.title}」只会从列表里消失，硬盘上的文件不会被删除。`);
          if (!ok) return;
          await window.api.library.removeLocal([item.localId]);
          toast('已从库中移除', 1800);
          await refreshLibraryData();
          await showLocal();
        },
        'danger',
      );
    } else if (item.fromLib) {
      add(
        '从「链接收藏」移除',
        async () => {
          await window.api.library.removeBili([item.libId || item.bvid]);
          toast('已移除', 1600);
          await refreshLibraryData();
          await showBiliLib();
        },
        'danger',
      );
    } else if (item.bvid) {
      add('复制 B 站链接', async () => {
        try {
          await navigator.clipboard.writeText(`https://www.bilibili.com/video/${item.bvid}`);
          toast('链接已复制', 1600);
        } catch {
          toast('复制失败', 1600);
        }
      });
      // 收藏夹里的条目：可以只在本地隐藏掉（B 站收藏夹不动）
      if (state.source === 'folder' && state.folder) {
        sep();
        add('在本应用隐藏（不影响 B 站）', () => hideFavItem(item), 'danger');
        if (state.hiddenKeys.size) {
          add(`恢复全部隐藏（${state.hiddenKeys.size} 个）`, () => unhideAllInFolder());
        }
      }
    }
  }

  // 渲染菜单
  showContextMenu(ev, rows.map((r) => ({ ...r, onClick: r.fn })));
}

/** 简单的确认弹层（用浏览器原生 confirm 会阻塞且样式不统一） */function confirmDialog(title, message) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="width:340px">
        <div class="modal-head"><h2>${esc(title)}</h2></div>
        <p style="font-size:12.5px;color:var(--text-2);line-height:1.7;margin-bottom:16px">${esc(message)}</p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="ghost-btn" data-act="no">取消</button>
          <button class="ghost-btn primary" data-act="yes">确定</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const done = (v) => {
      mask.remove();
      resolve(v);
    };
    mask.querySelector('[data-act="no"]').onclick = () => done(false);
    mask.querySelector('[data-act="yes"]').onclick = () => done(true);
    mask.onclick = (e) => {
      if (e.target === mask) done(false);
    };
  });
}

/** 关闭时的三选一：收进托盘 / 直接退出 / 取消；可勾选「记住我的选择」 */
function askClose() {
  if (document.querySelector('[data-close-ask]')) return; // 防重复弹
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.setAttribute('data-close-ask', '1');
    mask.innerHTML = `
      <div class="modal" style="width:360px">
        <div class="modal-head"><h2>要关闭还是后台运行？</h2></div>
        <p style="font-size:12.5px;color:var(--text-2);line-height:1.7;margin-bottom:14px">
          <b style="color:var(--text-1)">收进托盘</b>：窗口隐藏，音乐继续播放，右键托盘图标可控制。<br>
          <b style="color:var(--text-1)">退出程序</b>：完全关闭，音乐停止。
        </p>
        <label class="row" style="margin-bottom:14px;font-size:12px;color:var(--text-3)">
          <span>记住我的选择（以后不再询问）</span>
          <input type="checkbox" data-act="remember" />
        </label>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="ghost-btn" data-act="cancel">取消</button>
          <button class="ghost-btn" data-act="quit">退出程序</button>
          <button class="ghost-btn primary" data-act="tray">收进托盘</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const done = (v) => {
      mask.remove();
      resolve(v);
    };
    mask.querySelector('[data-act="cancel"]').onclick = () => done(false);
    mask.querySelector('[data-act="tray"]').onclick = async () => {
      const remember = mask.querySelector('[data-act="remember"]').checked;
      done(true);
      if (remember) await window.api.store.set('closeAction', 'tray');
      window.api.win.hideToTray();
    };
    mask.querySelector('[data-act="quit"]').onclick = async () => {
      const remember = mask.querySelector('[data-act="remember"]').checked;
      done(true);
      if (remember) await window.api.store.set('closeAction', 'quit');
      window.api.win.quit();
    };
    mask.onclick = (e) => {
      if (e.target === mask) done(false);
    };
  });
}

// ── 通过 B 站链接添加 ──

function openLinkDialog() {
  el.linkMask.hidden = false;
  el.linkInput.value = '';
  el.linkHint.textContent = '';
  el.linkHint.className = 'link-hint';
  el.linkResult.hidden = true;
  el.linkList.innerHTML = '';
  el.btnLinkConfirm.disabled = true;
  state.pendingTracks = [];
  state.linkPicked = new Set();
  setTimeout(() => el.linkInput.focus(), 60);
}

function closeLinkDialog() {
  el.linkMask.hidden = true;
  state.pendingTracks = [];
  state.linkPicked = new Set();
}

async function parseLinks() {
  const text = el.linkInput.value.trim();
  if (!text) {
    el.linkHint.textContent = '先粘贴链接';
    el.linkHint.className = 'link-hint err';
    return;
  }
  el.btnLinkParse.disabled = true;
  el.linkHint.textContent = '正在解析…';
  el.linkHint.className = 'link-hint';
  el.linkResult.hidden = true;
  state.pendingTracks = [];
  state.linkPicked = new Set();

  try {
    const r = await window.api.library.resolveLinks(text);
    if (!r.ok) throw new Error(r.error || '解析失败');
    const tracks = r.tracks || [];
    state.pendingTracks = tracks;

    const failedCount = (r.failed || []).length;
    el.linkHint.textContent = tracks.length
      ? `解析到 ${tracks.length} 首${failedCount ? `，${failedCount} 个链接失败` : ''}`
      : '没有解析到可导入的曲目';
    el.linkHint.className = failedCount && !tracks.length ? 'link-hint err' : 'link-hint';

    if (!tracks.length) {
      el.linkResult.hidden = true;
      el.btnLinkConfirm.disabled = true;
      return;
    }

    // 已有的不重复勾：库里已同 id 的曲目显示为「已导入」且默认不选
    const existing = new Set(state.libBili.map((t) => t.id || t.bvid));
    tracks.forEach((t, i) => {
      const key = t.id || t.bvid;
      if (!existing.has(key)) state.linkPicked.add(i);
    });

    el.linkResult.hidden = false;
    renderLinkList();
  } catch (e) {
    el.linkHint.textContent = `解析失败：${e.message}`;
    el.linkHint.className = 'link-hint err';
    el.btnLinkConfirm.disabled = true;
  } finally {
    el.btnLinkParse.disabled = false;
  }
}

/** 按视频分组渲染待导入列表（多 P 的分 P 归到同一个组头下面） */
function renderLinkList() {
  const tracks = state.pendingTracks;
  const existing = new Set(state.libBili.map((t) => t.id || t.bvid));
  const failedCount = 0;

  const frag = document.createDocumentFragment();

  // 按 bvid 分组，保持解析顺序
  const groups = [];
  const byBvid = new Map();
  tracks.forEach((t, i) => {
    const key = t.bvid || `_${i}`;
    let g = byBvid.get(key);
    if (!g) {
      g = { key, first: t, rows: [] };
      byBvid.set(key, g);
      groups.push(g);
    }
    g.rows.push({ t, i });
  });

  for (const g of groups) {
    const multi = g.rows.length > 1;
    if (multi) {
      const head = document.createElement('div');
      head.className = 'link-group';
      head.innerHTML = `
        <span class="lg-toggle">全选</span>
        <span class="lg-name">${esc(g.first.title.split(' · ')[0] || g.first.title)}</span>
        <span>· ${g.rows.length}P</span>`;
      head.querySelector('.lg-toggle').onclick = () => {
        const selectable = g.rows.filter(({ t }) => !existing.has(t.id || t.bvid));
        const allOn = selectable.every(({ i }) => state.linkPicked.has(i));
        for (const { i } of selectable) {
          if (allOn) state.linkPicked.delete(i);
          else state.linkPicked.add(i);
        }
        renderLinkList();
      };
      frag.appendChild(head);
    }

    for (const { t, i } of g.rows) {
      const key = t.id || t.bvid;
      const isDone = existing.has(key);
      const row = document.createElement('div');
      row.className = `link-row${isDone ? ' done' : ''}`;
      const badge = t.multiPage ? `P${t.page || t.part || 1}` : '单P';
      row.innerHTML = `
        <input class="lr-check" type="checkbox" data-i="${i}"
               ${state.linkPicked.has(i) ? 'checked' : ''}
               ${isDone ? 'disabled' : ''} />
        <img class="lr-cover" alt="" />
        <div>
          <div class="lr-title">${esc(t.title)}</div>
          <div class="lr-artist">${esc(t.artist || '')}</div>
        </div>
        <div class="lr-dur">${t.duration ? fmtTime(t.duration) : '—'}</div>
        <div class="lr-badge${isDone ? ' warn' : ''}">${isDone ? '已导入' : badge}</div>`;
      const img = row.querySelector('.lr-cover');
      if (t.cover) {
        window.api.player
          .coverUrl(t.cover)
          .then((u) => {
            if (u) img.src = u;
          })
          .catch(() => {});
      }
      const box = row.querySelector('.lr-check');
      box.onchange = () => {
        if (box.checked) state.linkPicked.add(i);
        else state.linkPicked.delete(i);
        updateLinkPickState();
      };
      frag.appendChild(row);
    }
  }

  el.linkList.innerHTML = '';
  el.linkList.appendChild(frag);
  updateLinkPickState(failedCount);
}

/** 刷新「已选 N 首」与确认按钮的可用状态 */
function updateLinkPickState(failedCount = 0) {
  const n = state.linkPicked.size;
  const total = state.pendingTracks.length;
  el.linkResultCount.textContent =
    `共 ${total} 首 · 已选 ${n} 首` + (failedCount ? ` · ${failedCount} 个失败` : '');
  el.btnLinkConfirm.disabled = n === 0;
  el.btnLinkConfirm.textContent = n ? `加入我的库（${n}）` : '加入我的库';
}

async function confirmAddLinks() {
  const tracks = [...state.linkPicked]
    .sort((a, b) => a - b)
    .map((i) => state.pendingTracks[i])
    .filter(Boolean);
  if (!tracks.length) return;
  el.btnLinkConfirm.disabled = true;
  try {
    // 落库时补上 cid / 标题等，供以后直接播放
    const r = await window.api.library.addBili(
      tracks.map((t) => ({
        // 多 P 视频每个分 P 用独立 id（`bvid:pN`），否则入库会互相覆盖
        id: t.id || t.bvid,
        bvid: t.bvid,
        cid: t.cid,
        page: t.page || t.part || 1,
        multiPage: !!t.multiPage,
        title: t.title,
        artist: t.artist,
        cover: t.cover,
        duration: t.duration,
        tname: t.tname,
        part: t.part,
      })),
    );
    toast(`已加入我的库：新增 ${r.added} 首`, 2600);
    closeLinkDialog();
    await refreshLibraryData();
    await showBiliLib();
  } catch (e) {
    toast(`加入失败：${e.message}`, 3200);
    el.btnLinkConfirm.disabled = false;
  }
}

/** 后台分批补全 cid / 分区，边解析边更新列表 */
async function resolveMissing() {
  const pending = state.rawItems.filter((it) => !it.resolved && it.bvid && !isLocal(it));
  if (!pending.length) return;
  const folderId = state.folder?.id;
  state.resolveTotal = pending.length;

  const BATCH = 12;
  for (let i = 0; i < pending.length; i += BATCH) {
    // 用户切了收藏夹就放弃本轮
    if (state.folder?.id !== folderId) return;
    const chunk = pending.slice(i, i + BATCH);
    let res;
    try {
      res = await window.api.bili.resolve(chunk.map((x) => x.bvid));
    } catch {
      continue;
    }
    const map = new Map(res.map((r) => [r.bvid, r]));
    for (const it of chunk) {
      const r = map.get(it.bvid);
      if (!r || !r.ok) {
        it.resolved = false;
        it.broken = true;
        continue;
      }
      it.resolved = true;
      it.tid = r.tid;
      it.tname = r.tname;
      it.isMusic = r.isMusic;
      if (!it.cover && r.cover) it.cover = r.cover;

      // 多 P 视频：一条记录就地展开成多条，每个分 P 独立成曲
      const pages = Array.isArray(r.pages) ? r.pages : [];
      if (pages.length > 1) {
        const baseTitle = r.title || it.title;
        const expanded = pages.map((p) => {
          const cleaned = cleanPartName(p.part, baseTitle);
          const partName = cleaned ? `P${p.page} ${cleaned}` : `P${p.page}`;
          return {
            ...it,
            resolved: true,
            splitPart: true,
            page: p.page,
            cid: p.cid,
            title: `${baseTitle} · ${partName}`,
            duration: p.duration || it.duration,
          };
        });
        const at = state.rawItems.indexOf(it);
        if (at >= 0) state.rawItems.splice(at, 1, ...expanded);
        continue;
      }

      it.cid = r.cid;
      if (r.duration) it.duration = r.duration;
    }
    state.resolving = Math.min(state.resolveTotal, i + chunk.length);
    applyFilter();
    updateResolveHint();
  }
  updateResolveHint();
}

function updateResolveHint() {
  if (!state.folder) return;
  const total = state.rawItems.length;
  const done = state.rawItems.filter((x) => x.resolved).length;
  // 被隐藏的条目不算进「可播放」，但要让人知道它们存在（否则会以为歌丢了）
  const hiddenN = state.hiddenKeys.size;
  const hiddenPart = hiddenN ? ` · 已隐藏 ${hiddenN} 个` : '';
  if (done < total) {
    el.folderSub.textContent = `共 ${total} 个条目 · 正在识别 ${done}/${total}${hiddenPart}`;
  } else {
    const shown = state.list.length;
    el.folderSub.textContent = `共 ${total} 个条目 · 可播放 ${shown} 个${hiddenPart}`;
  }
}

// ═════════════════════════════════ 统一曲目模型 ═════════════════════════════════

/**
 * 列表里每一条的唯一键。
 * 本地条目用 localId；B 站条目用 bvid，多 P 视频拆出来的分 P 用 `bvid:p{page}`。
 * 这样同一个视频的不同分 P 能各自播放、各自标记、各自排进歌单。
 */
function keyOf(it) {
  if (!it) return '';
  if (it.kind === 'local') return it.localId || '';
  // 库里导入的多 P 曲目已有唯一 id（`bvid:pN`），优先用它
  if (it.libId) return it.libId;
  const bvid = it.bvid || '';
  // 收藏夹里拆分出来的分 P：`bvid:pN`
  if (bvid && it.splitPart && it.page) return `${bvid}:p${it.page}`;
  return bvid;
}

/** 是不是本地文件条目 */
const isLocal = (it) => !!it && it.kind === 'local';

/**
 * 从分 P 名里把重复的视频标题剥掉。
 * B 站很多多 P 投稿的分 P 名形如「日-《某某EP | 歌名》」，而视频标题是「《某某EP | 歌名》」，
 * 直接拼会得到「X · P2 日-X」这种废话。只在分 P 名包含标题时才清洗。
 * @param {string} part 分 P 名
 * @param {string} title 视频标题
 * @returns {string} 清洗后的分 P 名
 */
function cleanPartName(part, title) {
  const p = String(part || '').trim();
  const t = String(title || '').trim();
  if (!p) return '';
  if (!t) return p;
  if (!p.includes(t)) return p;
  let out = p.split(t).join(' ').replace(/\s+/g, ' ').trim();
  out = out.replace(/^[-–—·:：|｜/\s]+/, '').replace(/[-–—·:：|｜/\s]+$/, '');
  return out;
}

/**
 * 把一个收藏夹条目按分 P 展开成多条曲目。
 * 单 P 视频原样返回；多 P 视频每个分 P 一条，标题用「视频标题 · P序号 分P名」。
 * @param {object} it 收藏夹条目
 * @returns {object[]}
 */
function splitByPages(it) {
  const pages = Array.isArray(it.pages) ? it.pages : [];
  if (pages.length <= 1) return [it];

  const multi = pages.length > 1;
  return pages.map((p) => {
    const cleaned = cleanPartName(p.part, it.title);
    const partName = cleaned ? `P${p.page} ${cleaned}` : `P${p.page}`;
    return {
      ...it,
      cid: p.cid,
      page: p.page,
      splitPart: multi,
      title: `${it.title} · ${partName}`,
      duration: p.duration || it.duration || 0,
      baseTitle: it.title,
      partName: p.part || '',
    };
  });
}

/**
 * 对整份原始条目做分 P 展开。已经展开过的不会重复展开。
 */
function expandPages(items) {
  const out = [];
  for (const it of items || []) {
    if (it.splitPart) {
      out.push(it); // 已经拆过
      continue;
    }
    out.push(...splitByPages(it));
  }
  return out;
}

/**
 * 把库里的本地曲目转成列表条目（跟收藏夹条目共用一套渲染 / 播放逻辑）。
 */
function localToItem(t) {
  return {
    kind: 'local',
    localId: t.id,
    bvid: '',
    cid: 0,
    title: t.title || t.name || '未知曲目',
    upper: t.artist || '',
    album: t.album || '',
    duration: t.duration || 0,
    cover: t.cover || '',
    tname: t.tagged ? '本地' : '本地 · 未读标签',
    tagged: t.tagged !== false,
    isMusic: true,
    resolved: true,
    broken: false,
    missing: !!t.missing,
    size: t.size || 0,
  };
}

/** 把链接导入的 B 站曲目转成列表条目 */
function libBiliToItem(t) {
  const page = Number(t.page) || 1;
  const multi = !!t.multiPage || page > 1;
  return {
    kind: 'bili',
    bvid: t.bvid,
    // 库里多 P 的分 P 用 `bvid:pN` 做键，列表也要用同一个键
    libId: t.id || t.bvid,
    page,
    splitPart: multi,
    cid: t.cid || 0,
    title: t.title || '未命名',
    upper: t.artist || '',
    duration: t.duration || 0,
    cover: t.cover || '',
    tname: t.tname || '',
    isMusic: true,
    resolved: !!t.cid,
    broken: false,
    fromLib: true,
  };
}

// ═════════════════════════════════ 单曲爱心 ═════════════════════════════════

/** 「我喜欢的歌」用的类型前缀：本地文件是 local，其余都是 bili */
const lovedTypeOf = (it) => (isLocal(it) ? 'local' : 'bili');

/** 某条曲目在「我喜欢的歌」里的键，和主进程 `${type}:${id}` 保持一致 */
function lovedKeyOf(it) {
  if (!it) return '';
  const id = isLocal(it) ? it.localId || '' : it.libId || keyOf(it);
  if (!id) return '';
  return `${lovedTypeOf(it)}:${id}`;
}

/** 这首歌是不是已经在我喜欢的歌里（决定爱心亮还是灰） */
function isLovedItem(it) {
  const k = lovedKeyOf(it);
  return !!k && state.lovedKeys.has(k);
}

/**
 * 列表条目 → 入库时保存的 track 形状。
 * 收藏夹里的歌还没入库，靠这份快照也能进「我喜欢的歌」。
 */
function itemToTrack(it) {
  if (isLocal(it)) {
    return {
      id: it.localId,
      kind: 'local',
      name: it.title,
      title: it.title,
      artist: it.upper || '',
      album: it.album || '',
      duration: it.duration || 0,
      cover: it.cover || '',
      tagged: it.tagged !== false,
      missing: !!it.missing,
    };
  }
  const id = it.libId || keyOf(it);
  return {
    id,
    bvid: it.bvid || '',
    cid: it.cid || 0,
    title: it.title || '',
    artist: it.upper || '',
    duration: it.duration || 0,
    cover: it.cover || '',
    tname: it.tname || '',
    page: it.page || 1,
    multiPage: !!it.splitPart || (it.page || 1) > 1,
    isMusic: isMusicOf(it) !== false,
    source: 'link',
  };
}

/** 点爱心：已收藏就移出，没收藏就加入。先改本地集合让界面立刻响应。 */
async function toggleLoved(it) {
  const key = lovedKeyOf(it);
  if (!key) return;
  const wasLoved = state.lovedKeys.has(key);
  const type = lovedTypeOf(it);
  const track = itemToTrack(it);
  try {
    if (wasLoved) {
      await window.api.library.removeFromLoved(type, track);
      state.lovedKeys.delete(key);
    } else {
      await window.api.library.addToLoved(type, track);
      state.lovedKeys.add(key);
    }
    state.lovedCount = state.lovedKeys.size;
  } catch (e) {
    toast(`操作失败：${e.message}`, 3000);
    return;
  }
  toast(wasLoved ? `已移出我喜欢的歌：${it.title}` : `已加入我喜欢的歌：${it.title}`, 1800);
  // 只改这一行的爱心状态，不重建整个列表（否则正在播放的高亮会闪）
  const idx = state.list.indexOf(it);
  const row = idx >= 0 ? state.rowEls.get(idx) : null;
  const btn = row ? row.querySelector('.s-heart') : null;
  if (btn) {
    const now = state.lovedKeys.has(key);
    btn.classList.toggle('on', now);
    btn.title = now ? '已在我喜欢的歌里（点击移出）' : '加入我喜欢的歌';
  }
  renderLibrary();
  if (state.source === 'loved') await showLoved();
}

/** 这条曲目在当前收藏夹里是否被隐藏了（只在本应用不显示） */
function isHiddenItem(it) {
  if (state.source !== 'folder' || !state.folder) return false;
  return state.hiddenKeys.has(keyOf(it));
}

/** 把一条曲目在本应用里隐藏掉（不会去 B 站取消收藏） */
async function hideFavItem(it) {
  if (!state.folder) return;
  const key = keyOf(it);
  if (!key) return;
  try {
    await window.api.library.hideFavItem(state.folder.id, {
      key,
      bvid: it.bvid || '',
      page: it.page || 1,
      title: it.title || '',
    });
    state.hiddenKeys.add(key);
    // 从当前视图里摘掉（同时清掉播放列表里的引用）
    state.rawItems = state.rawItems.filter((x) => keyOf(x) !== key);
    applyFilter();
    toast(`已从本应用隐藏：${it.title}（B 站收藏夹没有变化）`, 2600);
  } catch (e) {
    toast(`隐藏失败：${e.message}`, 3000);
  }
}

/** 把当前收藏夹里隐藏过的全部恢复显示 */
async function unhideAllInFolder() {
  if (!state.folder) return;
  const n = state.hiddenKeys.size;
  if (!n) {
    toast('当前收藏夹没有隐藏的条目', 1800);
    return;
  }
  const ok = await confirmDialog('恢复全部隐藏？', `将把当前收藏夹里隐藏过的 ${n} 个条目重新显示出来。`);
  if (!ok) return;
  try {
    await window.api.library.clearHidden(state.folder.id);
    state.hiddenKeys = new Set();
    await selectFolder(state.folder.id);
    toast(`已恢复 ${n} 个隐藏条目`, 2000);
  } catch (e) {
    toast(`恢复失败：${e.message}`, 3000);
  }
}

// ═════════════════════════════════ 音乐判定 ═════════════════════════════════

/**
 * 查某条曲目的手动标记值。
 * 分 P 独立标记优先；没单独标过就继承整个视频的标记
 * （用户在别处把整个视频标过音乐/非音乐，拆出来的分 P 应当跟着走）。
 * @returns {boolean|undefined}
 */
function overrideOf(it) {
  if (!it) return undefined;
  const own = state.overrides[keyOf(it)];
  if (own !== undefined) return own;
  // 分 P 没单独标 → 看整个视频的标记
  if (it.splitPart && it.bvid) return state.overrides[it.bvid];
  return undefined;
}

/**
 * 标记实际存在哪个键上。
 * 分 P 自己没标过、只是继承了整个视频的标记时，要清的是视频那个键。
 */
function overrideKeyOf(it) {
  if (!it) return '';
  if (state.overrides[keyOf(it)] !== undefined) return keyOf(it);
  if (it.splitPart && it.bvid && state.overrides[it.bvid] !== undefined) return it.bvid;
  return keyOf(it);
}

/**
 * 一条记录最终算不算音乐。
 * 手动标记优先于自动判断（分区 tid / 分区名）。本地文件永远算音乐。
 * @returns {boolean}
 */
function isMusicOf(it) {
  if (!it) return false;
  if (isLocal(it)) return true;
  const ov = overrideOf(it);
  if (ov === true) return true;
  if (ov === false) return false;
  return !!it.isMusic;
}

/** 手动标记状态：'on' | 'off' | ''（没手动标过） */
function markStateOf(it) {
  if (!it || isLocal(it)) return '';
  const ov = overrideOf(it);
  if (ov === true) return 'on';
  if (ov === false) return 'off';
  return '';
}

/**
 * 点击行尾的 ♪ 切换手动标记，循环三态：
 *   没标过 → 标为音乐 → 标为非音乐 → 清除回到自动
 */
async function cycleMark(key) {
  if (!key) return;
  // 分 P 可能没单独标过、只是继承了整个视频的标记，循环要从继承值开始
  const it0 = state.rawItems.find((x) => keyOf(x) === key);
  const cur = state.overrides[key] !== undefined ? state.overrides[key] : overrideOf(it0);
  let next;
  if (cur === undefined) next = true;
  else if (cur === true) next = false;
  else next = null; // 清除

  // 先本地生效，界面立刻响应
  if (next === null) delete state.overrides[key];
  else state.overrides[key] = next;

  applyFilter();

  try {
    await window.api.music.set(key, next === null ? null : next);
  } catch (e) {
    toast(`保存标记失败：${e.message}`, 3000);
  }

  const it = it0;
  const title = it?.title || key;
  if (next === true) toast(`已标记为音乐：${title}`, 1800);
  else if (next === false) toast(`已标记为非音乐：${title}`, 1800);
  else toast(`已恢复自动判断：${title}`, 1800);
}

// ═════════════════════════════════ 列表渲染 ═════════════════════════════════

function applyFilter() {
  const keepKey = state.currentBvid;

  const kw = state.keyword.trim().toLowerCase();
  const skipMusicFilter = state.source === 'loved'; // 我喜欢的歌本身就是精选，不再按分区筛
  let list = state.rawItems.filter((it) => {
    // 当前收藏夹里被隐藏的条目不显示（只在本应用隐藏，B 站原样）
    if (isHiddenItem(it)) return false;
    if (it.missing) return !state.onlyMusic; // 文件丢了的默认藏起来
    if (skipMusicFilter) {
      if (it.broken) return false;
      return !it.missing;
    }
    // 本地文件永远算音乐，不受「仅音乐」影响
    if (isLocal(it)) return true;
    const ov = overrideOf(it);
    // 手动标记优先于自动判断
    if (ov === true) return !it.broken; // 手动标为音乐 → 始终显示
    if (ov === false) return !state.onlyMusic && !it.broken; // 手动标为非音乐 → 仅在不筛选时显示
    if (state.onlyMusic) {
      // 已解析的按分区判断；未解析的先保留（解析完会再过滤一次）
      if (it.resolved && !it.isMusic) return false;
      if (it.broken) return false;
    }
    return true;
  });
  if (kw) {
    list = list.filter(
      (it) =>
        String(it.title).toLowerCase().includes(kw) ||
        String(it.upper || '').toLowerCase().includes(kw) ||
        String(it.album || '').toLowerCase().includes(kw),
    );
  }
  state.list = list;

  // 当前播放的条目若还在列表里，下标跟着它走；被过滤掉则置 -1，绝不指向别人
  const found = keepKey ? list.findIndex((x) => keyOf(x) === keepKey) : -1;
  state.index = found >= 0 ? found : -1;
  if (found < 0 && keepKey) {
    // 保留播放身份，但列表里确实没有它了
    state.currentItem = state.currentItem || state.rawItems.find((x) => keyOf(x) === keepKey) || null;
  }

  renderSongs();
  updateResolveHint();
}

function renderSongs() {
  state.rowEls.clear();
  if (!state.list.length) {
    el.songList.innerHTML = `<div class="list-empty">
      <div class="list-empty-icon">♪</div>
      <p>没有可播放的条目</p>
      <span>${state.onlyMusic ? '试着关掉「仅音乐」看看' : '换个收藏夹或清空搜索'}</span>
    </div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  state.list.forEach((it, i) => {
    const row = document.createElement('div');
    const local = isLocal(it);
    row.className = 'song-row' + (local ? ' s-row-local' : '');
    if (i === state.index) row.classList.add('playing');
    if (it.missing) row.classList.add('missing');
    row.dataset.i = String(i);
    const manual = markStateOf(it);
    const autoMusic = !!it.isMusic;
    const effMusic = isMusicOf(it);
    // 多 P 视频拆出来的分 P 加个小角标，一眼能看出这是合集里的一集
    const partBadge = it.splitPart && it.page ? `<span class="s-badge part">P${it.page}</span>` : '';
    const badge = local
      ? it.tagged === false
        ? '<span class="s-badge">未读标签</span>'
        : ''
      : (effMusic
          ? `<span class="s-badge music">音乐${manual === 'on' ? ' · 手动' : ''}</span>`
          : manual === 'off'
            ? '<span class="s-badge">非音乐 · 手动</span>'
            : it.tname
              ? `<span class="s-badge">${esc(it.tname)}</span>`
              : '') + partBadge;

    // ♪ 标记按钮的三态外观（本地文件不需要标记）
    const markCls = manual === 'on' ? 'on' : manual === 'off' ? 'off' : autoMusic ? 'auto' : '';
    const markTitle =
      manual === 'on'
        ? '已手动标记为音乐（点击改为非音乐）'
        : manual === 'off'
          ? '已手动标记为非音乐（点击恢复自动）'
          : autoMusic
            ? '自动判定为音乐（点击手动标记）'
            : '自动判定为非音乐（点击标记为音乐）';

    const sub = local
      ? [it.upper, it.album, it.duration ? fmtTime(it.duration) : ''].filter(Boolean).join(' · ')
      : `${esc(it.upper || '')}${it.duration ? ' · ' + fmtTime(it.duration) : ''}`;
    const upperCol = local ? esc(it.album || it.upper || '本地') : esc(it.upper || '');

    // 单曲爱心：已收藏常亮粉色，未收藏灰色、悬停整行才浮现
    const lovedOn = isLovedItem(it);
    const heartCls = lovedOn ? 's-heart on' : 's-heart';
    const heartTitle = lovedOn ? '已在我喜欢的歌里（点击移出）' : '加入我喜欢的歌';

    row.innerHTML = `
      <div class="s-idx">
        <span class="idx-num">${i + 1}</span>
        <svg class="idx-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </div>
      <div class="s-main">
        <div class="s-cover"></div>
        <div class="s-text">
          <div class="s-title">${esc(it.title)}${badge}</div>
          <div class="s-sub">${sub}</div>
        </div>
      </div>
      <div class="s-upper">${upperCol}</div>
      <div class="s-dur">${fmtTime(it.duration)}</div>
      <button class="${heartCls}" title="${heartTitle}" aria-label="${heartTitle}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
      </button>
      ${
        local
          ? '<button class="s-mark" title="从库中移除" disabled style="opacity:0;pointer-events:none">♪</button>'
          : `<button class="s-mark ${markCls}" title="${markTitle}">♪</button>`
      }`;
    row.querySelector('.s-cover').dataset.cover = it.cover || '';
    if (it.missing) {
      row.onclick = () => toast('这个文件已经不在原位置了', 2600);
    } else {
      row.onclick = () => playIndex(i);
      row.ondblclick = () => playIndex(i);
    }

    const markBtn = row.querySelector('.s-mark');
    if (!local) {
      markBtn.onclick = (e) => {
        e.stopPropagation(); // 别触发整行的播放
        cycleMark(keyOf(it));
      };
      markBtn.ondblclick = (e) => e.stopPropagation();
    }

    const heartBtn = row.querySelector('.s-heart');
    heartBtn.onclick = (e) => {
      e.stopPropagation(); // 别触发整行的播放
      toggleLoved(it);
    };
    heartBtn.ondblclick = (e) => e.stopPropagation();

    // 右键菜单
    row.oncontextmenu = (e) => openContextMenu(e, it, i);

    // 歌单内拖拽排序
    if (state.source === 'playlist' && state.playlistId) {
      row.draggable = true;
      row.dataset.dragIdx = String(i);
      row.ondragstart = (e) => {
        state.dragFrom = i;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox/Chromium 都要求设点数据
        try {
          e.dataTransfer.setData('text/plain', String(i));
        } catch {}
      };
      row.ondragend = () => {
        row.classList.remove('dragging');
        state.dragFrom = -1;
        for (const r of state.rowEls.values()) r.classList.remove('drag-over');
      };
      row.ondragover = (e) => {
        if (state.dragFrom < 0 || state.dragFrom === i) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      };
      row.ondragleave = () => row.classList.remove('drag-over');
      row.ondrop = async (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const from = state.dragFrom;
        state.dragFrom = -1;
        if (from < 0 || from === i) return;
        // 先本地挪，界面立刻响应
        const arr = state.list;
        const [moved] = arr.splice(from, 1);
        arr.splice(i, 0, moved);
        if (state.index === from) state.index = i;
        else if (from < state.index && i >= state.index) state.index--;
        else if (from > state.index && i <= state.index) state.index++;
        renderSongs();
        try {
          await window.api.library.moveInPlaylist(state.playlistId, from, i);
        } catch (err) {
          toast(`排序没保存：${err.message}`, 2600);
          await showPlaylist(state.playlistId);
        }
      };
    }

    state.rowEls.set(i, row);
    frag.appendChild(row);
  });
  el.songList.innerHTML = '';
  el.songList.appendChild(frag);
  hydrateCovers();

  // 恢复当前播放高亮
  const active = state.rowEls.get(state.index);
  if (active) active.scrollIntoView({ block: 'nearest' });
}

let coverObserver = null;
function hydrateCovers() {
  if (coverObserver) coverObserver.disconnect();
  const targets = [...el.songList.querySelectorAll('.s-cover')];
  coverObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const node = en.target;
        coverObserver.unobserve(node);
        const raw = node.dataset.cover;
        if (!raw) continue;
        window.api.player.coverUrl(raw).then((u) => {
          if (u) setCover(node, u);
        }).catch(() => {});
      }
    },
    { root: el.songList, rootMargin: '200px' },
  );
  targets.forEach((t) => coverObserver.observe(t));
}

// ═════════════════════════════════ 播放 ═════════════════════════════════

function current() {
  // 优先返回正在播放的那一条：即使它被当前搜索/过滤隐藏了，播放条仍然要有内容
  return state.currentItem || state.list[state.index] || null;
}

async function playIndex(i, { autoNext = false } = {}) {
  if (i < 0 || i >= state.list.length) return;
  const item = state.list[i];
  const seq = ++state.playSeq;
  const key = keyOf(item);
  state.index = i;
  state.currentItem = item;
  state.currentBvid = key;
  markRows();

  el.pbTitle.textContent = item.title || '未知标题';
  el.pbArtist.textContent = item.upper || item.album || '—';
  setCover(el.pbCover, '');

  // 封面（异步）——拿到本地代理地址后再更新播放条与系统媒体浮层
  if (item.cover) {
    if (item.cover.startsWith('data:')) {
      setCover(el.pbCover, item.cover);
    } else {
      window.api.player
        .coverUrl(item.cover)
        .then((u) => {
          if (seq !== state.playSeq || !u) return;
          setCover(el.pbCover, u);
          updateMediaArtwork(u, item);
        })
        .catch(() => {});
    }
  }

  setMediaSession(item);
  updateTitle(item);

  // ── 本地文件：直接走本地代理读磁盘 ──
  if (isLocal(item)) {
    if (item.missing) {
      toast('文件已经不在原位置了', 2600);
      return;
    }
    try {
      const info = await window.api.player.localUrl(item.localId);
      if (seq !== state.playSeq) return;
      state.currentUrl = info.url;
      el.qLabel.textContent = '本地';
      el.qLabel.title = '本地文件';
      renderQualityPop([]);
      el.audio.src = info.url;
      el.audio.load();
      await tryPlay();
    } catch (e) {
      if (seq !== state.playSeq) return;
      toast(`播放失败：${e.message}`, 3000);
      if (autoNext) setTimeout(() => next(), 800);
    }
    return;
  }

  // ── B 站曲目 ──
  const cid = item.cid || 0;
  if (!cid) {
    toast('这首歌还没有解析完成，稍后再试');
    return;
  }

  try {
    const info = await window.api.player.audioUrl(item.bvid, cid, state.quality);
    // 取地址期间用户已经点了别的歌 → 丢弃这次结果
    if (seq !== state.playSeq) return;
    state.currentUrl = info.url;
    if (info.qualityLabel) {
      el.qLabel.textContent = qShort(info.qualityId);
      el.qLabel.title = info.qualityLabel;
    }
    renderQualityPop(info.available || []);
    el.audio.src = info.url;
    el.audio.load();
    await tryPlay();
  } catch (e) {
    if (seq !== state.playSeq) return;
    toast(`播放失败：${e.message}`, 3000);
    if (autoNext) setTimeout(() => next(), 800);
  }
}

async function tryPlay() {
  try {
    await el.audio.play();
  } catch (e) {
    // 静默：用户后续点播放按钮即可
    console.warn('play 被拒绝', e.message);
  }
}

function markRows() {
  for (const [i, row] of state.rowEls) {
    row.classList.toggle('playing', i === state.index);
  }
}

function setPlayingUI(playing) {
  state.playing = playing;
  el.iconPlay.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  el.btnPlay.title = playing ? '暂停 (空格)' : '播放 (空格)';
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }
  reportState();
}

function skip(dir) {
  if (!state.list.length) return;
  // 当前曲目被搜索/过滤隐藏时，从列表边界外一步进入，避免"下一首"原地不动
  const base = state.index >= 0 ? state.index : dir > 0 ? -1 : state.list.length;
  if (state.mode === 'shuffle' && dir > 0) {
    if (state.list.length === 1) return;
    let n = state.index;
    while (n === state.index) n = Math.floor(Math.random() * state.list.length);
    playIndex(n);
    return;
  }
  let n = base + dir;
  if (n >= state.list.length) n = 0;
  if (n < 0) n = state.list.length - 1;
  playIndex(n);
}

function next() {
  skip(1);
}

function prev() {
  // 播放超过 3 秒时先回到开头
  if (el.audio.currentTime > 3) {
    el.audio.currentTime = 0;
    return;
  }
  skip(-1);
}

function togglePlay() {
  // 有正在播放的条目就继续放它（即使它被搜索隐藏）
  if (!state.currentItem && !state.list.length) {
    toast('列表是空的');
    return;
  }
  if (!state.currentItem) {
    playIndex(0);
    return;
  }
  if (el.audio.paused) tryPlay();
  else el.audio.pause();
}

function setMediaSession(item) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title || '',
      artist: item.upper || item.album || '',
      album: state.folder?.title || state.playlistTitle || 'Bili Music',
      artwork: item.cover ? [{ src: item.cover, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => tryPlay());
    navigator.mediaSession.setActionHandler('pause', () => el.audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (Number.isFinite(d.seekTime)) el.audio.currentTime = d.seekTime;
    });
  } catch {
    /* 旧版 Chromium 可能缺失部分能力 */
  }
}

/** 封面代理地址到手后补进 Windows 媒体浮层 */
function updateMediaArtwork(localUrl, item) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title || '',
      artist: item.upper || item.album || '',
      album: state.folder?.title || state.playlistTitle || 'Bili Music',
      artwork: [{ src: localUrl, sizes: '512x512', type: 'image/jpeg' }],
    });
  } catch {
    /* ignore */
  }
}

function updateTitle(item) {
  document.title = item ? `${item.title} - Bili Music` : 'Bili Music';
}

function reportState() {
  const it = current();
  window.api.player
    .reportState({
      playing: state.playing,
      title: it ? it.title : '',
      artist: it ? it.upper : '',
    })
    .catch(() => {});
}

// ═════════════════════════════════ 进度 / 音量 ═════════════════════════════════

function updateProgress() {
  const d = el.audio.duration || (current()?.duration ?? 0);
  const t = el.audio.currentTime || 0;
  const pct = d > 0 ? Math.min(100, (t / d) * 100) : 0;
  el.progFill.style.width = pct + '%';
  el.progKnob.style.left = pct + '%';
  el.timeCur.textContent = fmtTime(t);
  el.timeTotal.textContent = fmtTime(d);
  if ('mediaSession' in navigator && Number.isFinite(d) && d > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: el.audio.playbackRate || 1,
        position: Math.min(t, d),
      });
    } catch {
      /* ignore */
    }
  }
}

function bindBar(barEl, onRatio) {
  let dragging = false;
  const ratio = (ev) => {
    const r = barEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  };
  barEl.addEventListener('pointerdown', (ev) => {
    dragging = true;
    barEl.classList.add('dragging');
    barEl.setPointerCapture(ev.pointerId);
    onRatio(ratio(ev));
  });
  barEl.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    onRatio(ratio(ev));
  });
  const end = (ev) => {
    if (!dragging) return;
    dragging = false;
    barEl.classList.remove('dragging');
    try {
      barEl.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  };
  barEl.addEventListener('pointerup', end);
  barEl.addEventListener('pointercancel', end);
}

function applyVolume() {
  el.audio.volume = state.muted ? 0 : state.volume;
  el.audio.muted = state.muted;
  el.volFill.style.width = (state.muted ? 0 : state.volume) * 100 + '%';
  el.iconVolume.innerHTML = state.muted || state.volume === 0
    ? '<path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>'
    : '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12z"/>';
  window.api.store.patch({ volume: state.volume, muted: state.muted }).catch(() => {});
}

// ═════════════════════════════════ 音质气泡 ═════════════════════════════════

function renderQualityPop(available) {
  if (!available.length) {
    el.qualityPop.innerHTML = '<div class="pop-item">暂无可用音质</div>';
    return;
  }
  el.qualityPop.innerHTML =
    `<div class="pop-item${state.quality === 0 ? ' active' : ''}" data-q="0">自动<span>最高</span></div>` +
    available
      .map(
        (a) =>
          `<div class="pop-item${String(state.quality) === String(a.id) ? ' active' : ''}" data-q="${a.id}">${esc(a.label.replace(/\s.*/, ''))}<span>${esc(a.label)}</span></div>`,
      )
      .join('');
  for (const node of el.qualityPop.querySelectorAll('.pop-item[data-q]')) {
    node.onclick = () => {
      const q = Number(node.dataset.q);
      state.quality = q;
      el.qualityPop.hidden = true;
      window.api.store.set('quality', q);
      if (current()) playIndex(state.index);
      toast(q ? '已切换音质' : '已切换为自动音质');
    };
  }
}

function toggleQualityPop() {
  if (!el.qualityPop.hidden) {
    el.qualityPop.hidden = true;
    return;
  }
  const r = el.btnQuality.getBoundingClientRect();
  el.qualityPop.hidden = false;
  const pr = el.qualityPop.getBoundingClientRect();
  el.qualityPop.style.left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.left - 40)) + 'px';
  el.qualityPop.style.top = r.top - pr.height - 8 + 'px';
}

// ═════════════════════════════════ 设置 ═════════════════════════════════

async function openSettings() {
  const all = await window.api.store.all();
  state.settings = all;
  $('set-close-action').value = all.closeAction || 'ask';
  $('set-min-tray').checked = !!all.minimizeToTray;
  $('set-autolaunch').checked = !!all.autoLaunch;
  $('set-quality').value = String(all.quality || 0);
  const info = await window.api.app.info();
  $('set-datadir').textContent = info.dataDir;
  $('set-datadir').title = info.dataDir;
  $('set-version').textContent = `v${info.version} · Electron ${info.electron} · Chromium ${info.chrome}`;
  el.settingsMask.hidden = false;
}

// ═════════════════════════════════ 事件绑定 ═════════════════════════════════

function bindEvents() {
  // 窗口按钮
  $('btn-min').onclick = () => window.api.win.minimize();
  $('btn-max').onclick = async () => {
    await window.api.win.maximize();
  };
  $('btn-close').onclick = () => window.api.win.close();
  $('btn-tray').onclick = () => {
    toast('已收进托盘，右键托盘图标可控制播放');
    setTimeout(() => window.api.win.hideToTray(), 380);
  };
  $('btn-settings').onclick = openSettings;
  $('btn-settings-close').onclick = () => {
    el.settingsMask.hidden = true;
  };
  el.settingsMask.onclick = (e) => {
    if (e.target === el.settingsMask) el.settingsMask.hidden = true;
  };

  // 登录
  el.btnLogin.onclick = async () => {
    if (state.user) {
      await window.api.bili.logout();
      state.user = null;
      state.folders = [];
      state.folder = null;
      state.rawItems = [];
      state.list = [];
      state.index = -1;
      el.songList.innerHTML =
        '<div class="list-empty"><div class="list-empty-icon">♪</div><p>已退出登录</p><span>重新登录后可继续使用</span></div>';
      el.folderTitle.textContent = '选择一个收藏夹';
      el.folderSub.textContent = '登录 B 站后，这里会列出你的收藏夹';
      await refreshNav();
      loadFolders();
      return;
    }
    openLogin();
  };
  $('btn-login-close').onclick = closeLogin;
  el.loginMask.onclick = (e) => {
    if (e.target === el.loginMask) closeLogin();
  };

  // 收藏夹刷新
  el.btnRefreshFolders.onclick = () => loadFolders();

  // ── 我的库 ──
  el.btnAddFolder.onclick = () => addLocalFolder();
  el.btnAddLink.onclick = () => openLinkDialog();
  el.btnNewPlaylist.onclick = () => newPlaylist();

  // 「我的库」的导入/导出菜单
  el.btnLibMenu.onclick = (e) => {
    e.stopPropagation();
    openLibraryMenu(e);
  };

  // 右键菜单：点别处 / 滚动 / 按 Esc 都关掉
  document.addEventListener('click', (e) => {
    if (!el.ctxMenu.hidden && !el.ctxMenu.contains(e.target)) closeContextMenu();
  });
  document.addEventListener('contextmenu', (e) => {
    if (!el.ctxMenu.hidden && !el.ctxMenu.contains(e.target)) closeContextMenu();
  });
  el.songList.addEventListener('scroll', closeContextMenu, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.ctxMenu.hidden) closeContextMenu();
  });
  el.btnLinkClose.onclick = () => closeLinkDialog();
  el.linkMask.onclick = (e) => {
    if (e.target === el.linkMask) closeLinkDialog();
  };
  el.btnLinkParse.onclick = () => parseLinks();
  el.btnLinkConfirm.onclick = () => confirmAddLinks();
  // 全选：跳过库里已导入过的，避免重复入库
  el.btnLinkAll.onclick = () => {
    const existing = new Set(state.libBili.map((t) => t.id || t.bvid));
    state.pendingTracks.forEach((t, i) => {
      if (!existing.has(t.id || t.bvid)) state.linkPicked.add(i);
    });
    renderLinkList();
  };
  el.btnLinkNone.onclick = () => {
    state.linkPicked.clear();
    renderLinkList();
  };
  // Ctrl+Enter 直接解析
  el.linkInput.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      parseLinks();
    }
  };

  // 搜索
  let searchTimer = null;
  el.search.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.keyword = el.search.value || '';
      applyFilter();
    }, 180);
  };

  // 仅音乐
  el.onlyMusic.onchange = () => {
    state.onlyMusic = el.onlyMusic.checked;
    window.api.store.set('onlyMusic', state.onlyMusic);
    applyFilter();
  };

  // 全部播放
  el.btnPlayAll.onclick = () => {
    if (!state.list.length) {
      toast('没有可播放的条目');
      return;
    }
    playIndex(0);
  };

  // 播放控制
  el.btnPlay.onclick = togglePlay;
  el.btnPrev.onclick = prev;
  el.btnNext.onclick = next;

  el.btnMode.onclick = () => {
    const i = MODES.indexOf(state.mode);
    state.mode = MODES[(i + 1) % MODES.length];
    el.iconMode.innerHTML = MODE_ICON[state.mode];
    el.btnMode.title = MODE_LABEL[state.mode];
    el.btnMode.classList.toggle('active', state.mode !== 'loop-all');
    window.api.store.set('playMode', state.mode);
    toast(MODE_LABEL[state.mode], 1200);
  };

  el.btnQuality.onclick = toggleQualityPop;
  document.addEventListener('pointerdown', (e) => {
    if (!el.qualityPop.hidden && !el.qualityPop.contains(e.target) && !el.btnQuality.contains(e.target)) {
      el.qualityPop.hidden = true;
    }
  });

  el.btnMute.onclick = () => {
    state.muted = !state.muted;
    applyVolume();
  };

  // 进度条
  let seekPreview = null;
  bindBar(el.barProgress, (r) => {
    const d = el.audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    seekPreview = r * d;
    el.progFill.style.width = r * 100 + '%';
    el.progKnob.style.left = r * 100 + '%';
    el.timeCur.textContent = fmtTime(seekPreview);
  });
  el.barProgress.addEventListener('pointerup', () => {
    if (seekPreview != null && Number.isFinite(el.audio.duration)) {
      el.audio.currentTime = seekPreview;
    }
    seekPreview = null;
  });

  // 音量条
  bindBar(el.barVolume, (r) => {
    state.volume = r;
    if (r > 0 && state.muted) state.muted = false;
    applyVolume();
  });

  // audio 事件
  const a = el.audio;
  a.addEventListener('timeupdate', updateProgress);
  a.addEventListener('durationchange', updateProgress);
  a.addEventListener('loadedmetadata', updateProgress);
  a.addEventListener('play', () => setPlayingUI(true));
  a.addEventListener('pause', () => setPlayingUI(false));
  a.addEventListener('ended', () => {
    if (state.mode === 'loop-one') {
      a.currentTime = 0;
      tryPlay();
      return;
    }
    if (state.index === state.list.length - 1 && state.mode === 'loop-all') {
      playIndex(0);
      return;
    }
    next();
  });
  a.addEventListener('error', () => {
    if (!a.src) return;
    const err = a.error;
    const msg = err ? `音频错误 ${err.code}` : '音频加载失败';
    console.warn(msg, a.src);
    // 自动跳过下一首（避免卡死在坏条目）
    if (state.playing) {
      toast(`${msg}，跳到下一首`, 2000);
      setTimeout(() => next(), 700);
    }
  });
  a.addEventListener('stalled', () => console.warn('audio stalled'));

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowRight' && e.ctrlKey) {
      e.preventDefault();
      next();
    } else if (e.code === 'ArrowLeft' && e.ctrlKey) {
      e.preventDefault();
      prev();
    } else if (e.code === 'ArrowUp' && e.ctrlKey) {
      e.preventDefault();
      state.volume = Math.min(1, state.volume + 0.05);
      state.muted = false;
      applyVolume();
    } else if (e.code === 'ArrowDown' && e.ctrlKey) {
      e.preventDefault();
      state.volume = Math.max(0, state.volume - 0.05);
      applyVolume();
    } else if (e.code === 'ArrowRight') {
      el.audio.currentTime = Math.min(el.audio.duration || 0, el.audio.currentTime + 5);
    } else if (e.code === 'ArrowLeft') {
      el.audio.currentTime = Math.max(0, el.audio.currentTime - 5);
    }
  });

  // 来自托盘 / 媒体键
  window.api.on('media:toggle', () => togglePlay());
  window.api.on('media:next', () => next());
  window.api.on('media:prev', () => prev());
  window.api.on('media:stop', () => {
    el.audio.pause();
    el.audio.currentTime = 0;
  });

  // 点关闭按钮时询问（closeAction = 'ask'）
  window.api.on('win:ask-close', () => askClose());

  // 设置项
  $('set-close-action').onchange = (e) => window.api.store.set('closeAction', e.target.value);
  $('set-min-tray').onchange = (e) => window.api.store.set('minimizeToTray', e.target.checked);
  $('set-autolaunch').onchange = async (e) => {
    const r = await window.api.app.autoLaunch(e.target.checked);
    if (!r.ok) {
      e.target.checked = !!r.enabled;
      toast(`设置失败：${r.error || '未知错误'}`, 3000);
    } else {
      toast(r.enabled ? '已开启开机自启' : '已关闭开机自启');
    }
  };
  $('set-quality').onchange = (e) => {
    state.quality = Number(e.target.value) || 0;
    window.api.store.set('quality', state.quality);
    if (current()) playIndex(state.index);
  };
  $('btn-clear-cache').onclick = async () => {
    await window.api.app.clearCache();
    toast('缓存已清理');
    if (state.folder) selectFolder(state.folder.id);
  };
}

// ═════════════════════════════════ 启动 ═════════════════════════════════

async function boot() {
  bindEvents();

  const settings = await window.api.store.all();
  state.settings = settings;
  state.quality = Number(settings.quality) || 0;
  state.volume = typeof settings.volume === 'number' ? settings.volume : 0.8;
  state.muted = !!settings.muted;
  state.mode = MODES.includes(settings.playMode) ? settings.playMode : 'loop-all';
  state.onlyMusic = settings.onlyMusic !== false;

  // 手动音乐标记（bvid → boolean）
  try {
    state.overrides = (await window.api.music.all()) || {};
  } catch {
    state.overrides = {};
  }

  el.onlyMusic.checked = state.onlyMusic;
  el.iconMode.innerHTML = MODE_ICON[state.mode];
  el.btnMode.title = MODE_LABEL[state.mode];
  el.btnMode.classList.toggle('active', state.mode !== 'loop-all');
  el.qLabel.textContent = qShort(state.quality);
  applyVolume();
  setPlayingUI(false);

  // 我的库（本地 / 链接导入 / 歌单）先加载，不依赖登录
  await refreshLibraryData();

  const logged = await refreshNav();
  if (logged) await loadFolders();
  else if (!state.libFolders.length && !state.libBili.length) {
    // 既没登录也没本地音乐：空态提示
    renderSongs();
  }
}

boot().catch((e) => {
  console.error('启动失败', e);
  toast(`启动失败：${e.message}`, 5000);
});
