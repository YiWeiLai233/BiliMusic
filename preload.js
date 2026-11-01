'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

/** 订阅主进程事件，返回取消订阅函数 */
function on(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  bili: {
    qrGenerate: () => invoke('bili:qr-generate'),
    qrPoll: (key) => invoke('bili:qr-poll', key),
    nav: () => invoke('bili:nav'),
    logout: () => invoke('bili:logout'),
    folders: (mid) => invoke('bili:folders', mid),
    items: (mediaId, max) => invoke('bili:items', { mediaId, max }),
    resolve: (bvids) => invoke('bili:resolve', bvids),
  },
  player: {
    audioUrl: (bvid, cid, quality) => invoke('player:audio-url', { bvid, cid, quality }),
    localUrl: (id) => invoke('player:local-url', { id }),
    coverUrl: (url) => invoke('player:cover-url', url),
    reportState: (s) => invoke('player:state', s),
  },
  library: {
    stats: () => invoke('library:stats'),
    pickFolder: () => invoke('library:pick-folder'),
    countFiles: (dir) => invoke('library:count-files', { dir }),
    scan: (dir) => invoke('library:scan', { dir }),
    folders: () => invoke('library:folders'),
    removeFolder: (dir) => invoke('library:remove-folder', { dir }),
    localTracks: () => invoke('library:local-tracks'),
    removeLocal: (ids) => invoke('library:remove-local', ids),
    resolveLinks: (text) => invoke('library:resolve-links', { text }),
    addBili: (tracks, folderId) => invoke('library:add-bili', { tracks, folderId }),
    biliTracks: () => invoke('library:bili-tracks'),
    removeBili: (bvids) => invoke('library:remove-bili', bvids),
    playlists: () => invoke('library:playlists'),
    createPlaylist: (title) => invoke('library:create-playlist', { title }),
    renamePlaylist: (id, title) => invoke('library:rename-playlist', { id, title }),
    deletePlaylist: (id) => invoke('library:delete-playlist', { id }),
    addToPlaylist: (id, type, ids) => invoke('library:add-to-playlist', { id, type, ids }),
    removeFromPlaylist: (id, index) => invoke('library:remove-from-playlist', { id, index }),
    playlistTracks: (id) => invoke('library:playlist-tracks', { id }),
    moveInPlaylist: (id, from, to) => invoke('library:move-in-playlist', { id, from, to }),
    exportPlaylists: (ids) => invoke('library:export-playlists', { playlists: ids }),
    importPlaylists: () => invoke('library:import-playlists'),
    // 我喜欢的歌
    lovedTracks: () => invoke('library:loved-tracks'),
    excludeFromLoved: (type, id) => invoke('library:exclude-loved', { type, id }),
    includeInLoved: (type, id) => invoke('library:include-loved', { type, id }),
    addToLoved: (type, track) => invoke('library:add-loved', { type, track }),
    removeFromLoved: (type, track) => invoke('library:remove-loved', { type, track }),
    lovedKeys: () => invoke('library:loved-keys'),
    hideFavItem: (folderId, item) => invoke('library:hide-fav-item', { folderId, item }),
    unhideFavItem: (folderId, key) => invoke('library:unhide-fav-item', { folderId, key }),
    hiddenKeys: (folderId) => invoke('library:hidden-keys', { folderId }),
    hiddenItems: (folderId) => invoke('library:hidden-items', { folderId }),
    clearHidden: (folderId) => invoke('library:clear-hidden', { folderId }),
    favSources: () => invoke('library:fav-sources'),
    followFolder: (folderId) => invoke('library:follow-folder', { folderId }),
    unfollowFolder: (folderId) => invoke('library:unfollow-folder', { folderId }),
    // 一次性批量导入（不跟随）
    importFolderOnce: (folderId) => invoke('library:import-folder-once', { folderId }),
    favOnce: () => invoke('library:fav-once'),
    removeFolderOnce: (folderId) => invoke('library:remove-folder-once', { folderId }),
  },
  store: {
    all: () => invoke('store:all'),
    set: (key, value) => invoke('store:set', { key, value }),
    patch: (obj) => invoke('store:patch', obj),
  },
  music: {
    all: () => invoke('music-override:all'),
    set: (bvid, value) => invoke('music-override:set', { bvid, value }),
    merge: (obj) => invoke('music-override:merge', obj),
  },
  app: {
    autoLaunch: (v) => invoke('app:auto-launch', v),
    info: () => invoke('app:info'),
    openExternal: (url) => invoke('app:open-external', url),
    clearCache: () => invoke('app:clear-cache'),
  },
  win: {
    minimize: () => invoke('win:minimize'),
    maximize: () => invoke('win:maximize'),
    hideToTray: () => invoke('win:hide-to-tray'),
    close: () => invoke('win:close'),
    quit: () => invoke('win:quit'),
    isMaximized: () => invoke('win:is-maximized'),
  },
  on,
});
