'use strict';
/**
 * 「我的库」持久化：本地曲目索引 + 通过 B 站链接导入的曲目 + 歌单顺序。
 * 与 store.js（设置）分开存，库可能很大，改动频率也不同。
 */
const fs = require('node:fs');
const path = require('node:path');

const EMPTY = {
  version: 2,
  /** 扫描过的文件夹 */
  folders: [], // [{ dir, addedAt, count }]
  /** 本地曲目： id → track */
  local: {},
  /** 通过链接加入的 B 站曲目： id → { id, bvid, cid, title, ... }，多 P 的分 P 用 `bvid:pN` */
  bili: {},
  /** 歌单： id → { id, title, items: [ {type:'local'|'bili', id} ], createdAt } */
  playlists: {},
  /**
   * 收藏夹来源映射： folderId → { id, title, addedAt }。
   * 「我喜欢的歌」会持续跟随这些收藏夹的内容变化。
   */
  favSources: {},
  /**
   * 跟随的收藏夹最近一次抓到的曲目： folderId → { key → track }。
   * 收藏夹里删掉的歌也会跟着消失，所以每次同步整份替换。
   */
  favTracks: {},
  /**
   * 「我喜欢的歌」里被用户手动移除的曲目：`${type}:${id}` → true。
   * 全自动同步会把库里的歌都收进来，这个排除表保证移除掉的不会又被加回。
   */
  loveExcluded: {},
  /**
   * 一次性（不跟随）导入过来的收藏夹：folderId → { id, title, addedAt, count }。
   * 和 favSources 的区别是内容不再跟随收藏夹变化，只保留导入那一刻的快照。
   */
  favOnce: {},
  /**
   * 用户逐首手动点爱心加进「我喜欢的歌」的曲目：`${type}:${id}` → { type, track, addedAt }。
   * 收藏夹里还没入库的歌也能靠这个进「我喜欢的歌」。
   */
  lovedManual: {},
  /**
   * 在本应用里隐藏掉的收藏夹条目：`${folderId}:${key}` → { folderId, key, bvid, page, title, hiddenAt }。
   * 只影响本应用的显示，**不会**去 B 站取消收藏。
   */
  favHidden: {},
};

/** 「我喜欢的歌」这个特殊歌单的固定 id（不参与普通歌单的增删改） */
const LOVE_ID = '__loved__';
const LOVE_TITLE = '我喜欢的歌';

class Library {
  constructor(file) {
    this.file = file;
    this.data = JSON.parse(JSON.stringify(EMPTY));
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      this.data = {
        version: 2,
        folders: Array.isArray(raw.folders) ? raw.folders : [],
        local: raw.local && typeof raw.local === 'object' ? raw.local : {},
        bili: raw.bili && typeof raw.bili === 'object' ? raw.bili : {},
        playlists: raw.playlists && typeof raw.playlists === 'object' ? raw.playlists : {},
        favSources: raw.favSources && typeof raw.favSources === 'object' ? raw.favSources : {},
        favTracks: raw.favTracks && typeof raw.favTracks === 'object' ? raw.favTracks : {},
        loveExcluded: raw.loveExcluded && typeof raw.loveExcluded === 'object' ? raw.loveExcluded : {},
        favOnce: raw.favOnce && typeof raw.favOnce === 'object' ? raw.favOnce : {},
        lovedManual: raw.lovedManual && typeof raw.lovedManual === 'object' ? raw.lovedManual : {},
        favHidden: raw.favHidden && typeof raw.favHidden === 'object' ? raw.favHidden : {},
      };
      // v1 → v2 迁移：老库没有「我喜欢的歌」，第一次起来把所有已有曲目收进去
      if ((raw.version || 1) < 2) {
        this.save();
      }
    } catch {
      /* 首次运行或坏文件：用空库 */
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn('[library] 保存失败', e.message);
    }
  }

  // ---------- 文件夹 ----------

  addFolder(dir, count) {
    const norm = path.resolve(dir);
    const hit = this.data.folders.find((f) => path.resolve(f.dir) === norm);
    if (hit) {
      hit.count = count;
    } else {
      this.data.folders.push({ dir: norm, addedAt: Date.now(), count });
    }
    this.save();
    return this.data.folders.slice();
  }

  removeFolder(dir) {
    const norm = path.resolve(dir);
    this.data.folders = this.data.folders.filter((f) => path.resolve(f.dir) !== norm);
    // 一并删掉该文件夹下的本地曲目
    for (const [id, t] of Object.entries(this.data.local)) {
      if (t.path && path.resolve(path.dirname(t.path)).startsWith(norm)) {
        delete this.data.local[id];
      }
    }
    this.save();
    return this.data.folders.slice();
  }

  folders() {
    return this.data.folders.slice();
  }

  // ---------- 本地曲目 ----------

  /** 合并扫描结果：新增/更新，保留已有手改字段 */
  upsertLocal(tracks) {
    let added = 0;
    let updated = 0;
    for (const t of tracks) {
      if (!t || !t.id) continue;
      const old = this.data.local[t.id];
      if (old) {
        // 保留用户可能改过的 title/artist？目前不提供编辑，直接更新
        this.data.local[t.id] = { ...old, ...t, missing: false };
        updated++;
      } else {
        this.data.local[t.id] = t;
        added++;
      }
    }
    this.save();
    return { added, updated, total: Object.keys(this.data.local).length };
  }

  localTracks() {
    return Object.values(this.data.local);
  }

  removeLocal(ids) {
    let n = 0;
    for (const id of ids || []) {
      if (this.data.local[id]) {
        delete this.data.local[id];
        n++;
      }
    }
    // 同时从歌单里剔除
    for (const pl of Object.values(this.data.playlists)) {
      pl.items = pl.items.filter((it) => !(it.type === 'local' && ids.includes(it.id)));
    }
    this.save();
    return n;
  }

  /** 标记丢失的文件（扫描时发现文件没了） */
  markMissing(existingIds) {
    const set = new Set(existingIds);
    let n = 0;
    for (const [id, t] of Object.entries(this.data.local)) {
      const missing = !set.has(id);
      if (t.missing !== missing) {
        t.missing = missing;
        n++;
      }
    }
    if (n) this.save();
    return n;
  }

  getLocal(id) {
    return this.data.local[id] || null;
  }

  // ---------- B 站导入 ----------

  addBili(tracks, folderId = '') {
    let added = 0;
    for (const t of tracks || []) {
      if (!t || !t.bvid) continue;
      // 多 P 视频按分 P 存成独立条目，用 `bvid:pN` 做键；单 P 仍用 bvid
      const key = t.id || t.bvid;
      if (!this.data.bili[key]) added++;
      this.data.bili[key] = {
        ...(this.data.bili[key] || {}),
        ...t,
        id: key,
        folderId: folderId || t.folderId || '',
        addedAt: this.data.bili[key]?.addedAt || Date.now(),
      };
    }
    this.save();
    return { added, total: Object.keys(this.data.bili).length };
  }

  biliTracks() {
    return Object.values(this.data.bili);
  }

  getBili(id) {
    return this.data.bili[id] || null;
  }

  removeBili(ids) {
    let n = 0;
    for (const b of ids || []) {
      if (this.data.bili[b]) {
        delete this.data.bili[b];
        n++;
      }
    }
    for (const pl of Object.values(this.data.playlists)) {
      pl.items = pl.items.filter((it) => !(it.type === 'bili' && ids.includes(it.id)));
    }
    this.save();
    return n;
  }

  // ---------- 歌单 ----------

  createPlaylist(title) {
    const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.data.playlists[id] = {
      id,
      title: title || '新建歌单',
      items: [],
      createdAt: Date.now(),
    };
    this.save();
    return this.data.playlists[id];
  }

  playlists() {
    return Object.values(this.data.playlists);
  }

  getPlaylist(id) {
    return this.data.playlists[id] || null;
  }

  renamePlaylist(id, title) {
    const p = this.data.playlists[id];
    if (!p) return null;
    p.title = title || p.title;
    this.save();
    return p;
  }

  deletePlaylist(id) {
    delete this.data.playlists[id];
    this.save();
    return true;
  }

  /** type: 'local' | 'bili'；把 id 列表追加进歌单（去重） */
  addToPlaylist(plId, type, ids) {
    const p = this.data.playlists[plId];
    if (!p) return null;
    const have = new Set(p.items.filter((i) => i.type === type).map((i) => i.id));
    let added = 0;
    for (const id of ids || []) {
      if (!id || have.has(id)) continue;
      p.items.push({ type, id });
      have.add(id);
      added++;
    }
    if (added) this.save();
    return { added, total: p.items.length };
  }

  removeFromPlaylist(plId, index) {
    const p = this.data.playlists[plId];
    if (!p) return null;
    if (index >= 0 && index < p.items.length) p.items.splice(index, 1);
    this.save();
    return p;
  }

  /**
   * 把歌单里的一项从 from 挪到 to（拖拽排序用）。
   * 越界自动夹到合法范围。
   */
  moveInPlaylist(plId, from, to) {
    const p = this.data.playlists[plId];
    if (!p) return null;
    const n = p.items.length;
    if (!n) return p;
    const a = Math.max(0, Math.min(n - 1, Number(from)));
    const b = Math.max(0, Math.min(n - 1, Number(to)));
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return p;
    const [item] = p.items.splice(a, 1);
    p.items.splice(b, 0, item);
    this.save();
    return p;
  }

  /**
   * 导出成可以带走的 JSON。
   * 本地曲目只存元信息（路径），换机器需要重新扫；B 站曲目存 bvid 可直接复用。
   * @param {string[]} [plIds] 只导出指定歌单，不传=全部
   */
  exportData(plIds) {
    const ids = Array.isArray(plIds) && plIds.length ? plIds : Object.keys(this.data.playlists);
    const picked = {};
    for (const id of ids) {
      if (this.data.playlists[id]) picked[id] = this.data.playlists[id];
    }
    // 找出歌单引用到的曲目
    const localIds = new Set();
    const biliIds = new Set();
    for (const p of Object.values(picked)) {
      for (const it of p.items) {
        if (it.type === 'local') localIds.add(it.id);
        else biliIds.add(it.id);
      }
    }
    const local = {};
    for (const id of localIds) {
      const t = this.data.local[id];
      if (t) local[id] = t;
    }
    const bili = {};
    for (const id of biliIds) {
      const t = this.data.bili[id];
      if (t) bili[id] = t;
    }
    return {
      kind: 'bili-music-playlists',
      version: 1,
      exportedAt: new Date().toISOString(),
      playlists: picked,
      local,
      bili,
    };
  }

  /**
   * 导入之前导出的 JSON。
   * 同名歌单会合并（曲目去重），曲目按 id 覆盖写入。
   * @returns {{playlists:number, tracks:number, merged:number}}
   */
  importData(obj, { rename = true } = {}) {
    if (!obj || obj.kind !== 'bili-music-playlists') {
      throw new Error('不是本应用导出的歌单文件');
    }
    let tracks = 0;
    for (const [id, t] of Object.entries(obj.local || {})) {
      if (!t || !id) continue;
      this.data.local[id] = { ...this.data.local[id], ...t };
      tracks++;
    }
    for (const [id, t] of Object.entries(obj.bili || {})) {
      if (!t || !id) continue;
      this.data.bili[id] = { ...this.data.bili[id], ...t };
      tracks++;
    }

    let playlists = 0;
    let merged = 0;
    // 按名字找已存在的歌单，避免重复导入出现一堆同名
    const byTitle = new Map(Object.values(this.data.playlists).map((p) => [p.title, p]));
    for (const [id, src] of Object.entries(obj.playlists || {})) {
      const exist = byTitle.get(src.title);
      if (exist) {
        const r = this.addToPlaylistUnsafe(exist, src.items || []);
        merged += r;
        playlists++;
        continue;
      }
      let nid = id;
      if (this.data.playlists[nid] || !nid) nid = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const title = rename && this.data.playlists[nid] ? `${src.title} (导入)` : src.title;
      this.data.playlists[nid] = {
        id: nid,
        title: title || '导入的歌单',
        items: (src.items || []).filter((i) => i && i.type && i.id).map((i) => ({ type: i.type, id: i.id })),
        createdAt: Date.now(),
      };
      byTitle.set(this.data.playlists[nid].title, this.data.playlists[nid]);
      playlists++;
    }
    this.save();
    return { playlists, tracks, merged };
  }

  /** 内部用：往已有歌单塞条目，返回新增数量（不单独 save） */
  addToPlaylistUnsafe(p, items) {
    const have = new Set(p.items.map((i) => `${i.type}:${i.id}`));
    let added = 0;
    for (const it of items) {
      if (!it || !it.type || !it.id) continue;
      const k = `${it.type}:${it.id}`;
      if (have.has(k)) continue;
      p.items.push({ type: it.type, id: it.id });
      have.add(k);
      added++;
    }
    return added;
  }

  // ---------- 我喜欢的歌（自动汇总，不落静态条目） ----------

  /**
   * 收藏夹跟着走：记下来源，并把当时抓到的曲目存一份。
   * 之后收藏夹新增的歌，下次同步时自动补进来。
   */
  followFolder(folderId, title, tracks) {
    const fid = String(folderId);
    const prev = this.data.favTracks[fid] || {};
    const next = {};
    let added = 0;
    for (const t of tracks || []) {
      if (!t) continue;
      const key = t.id || t.bvid;
      if (!key) continue;
      next[key] = { ...t, id: key, favFolderId: fid };
      if (!prev[key]) added++;
    }
    const removed = Object.keys(prev).filter((k) => !next[k]).length;
    this.data.favTracks[fid] = next;
    // 从「一次性导入」升级成「持续跟随」，两种来源互斥
    delete this.data.favOnce[fid];
    this.data.favSources[fid] = {
      id: fid,
      title: title || this.data.favSources[fid]?.title || '收藏夹',
      addedAt: this.data.favSources[fid]?.addedAt || Date.now(),
      syncedAt: Date.now(),
      count: Object.keys(next).length,
    };
    this.save();
    return { added, removed, total: Object.keys(next).length };
  }

  unfollowFolder(folderId) {
    const fid = String(folderId);
    delete this.data.favTracks[fid];
    delete this.data.favSources[fid];
    delete this.data.favOnce[fid];
    this.save();
    return this.favSources();
  }

  /**
   * 一次性把整个收藏夹导入「我喜欢的歌」：保留导入那一刻的快照，不跟随后续变化。
   * 曲目同样存在 favTracks 里（lovedTracks 只认这份数据），靠 favOnce 标记它不是跟随来源。
   */
  importFolderOnce(folderId, title, tracks) {
    const fid = String(folderId);
    const prev = this.data.favTracks[fid] || {};
    // 一次性导入是「合并」语义：已经在喜欢的歌里的不重复收，也不删掉之前导入过的
    const next = { ...prev };
    let added = 0;
    for (const t of tracks || []) {
      if (!t) continue;
      const key = t.id || t.bvid;
      if (!key) continue;
      if (!next[key]) added++;
      next[key] = { ...t, id: key, favFolderId: fid };
    }
    this.data.favTracks[fid] = next;
    delete this.data.favSources[fid];
    this.data.favOnce[fid] = {
      id: fid,
      title: title || this.data.favOnce[fid]?.title || '收藏夹',
      addedAt: Date.now(),
      count: Object.keys(next).length,
    };
    this.save();
    return { added, total: Object.keys(next).length };
  }

  /** 一次性导入来源列表 */
  favOnceSources() {
    return Object.values(this.data.favOnce || {});
  }

  /** 这个收藏夹是不是「一次性导入」进来的（不是持续跟随） */
  isImportedOnce(folderId) {
    return !!this.data.favOnce[String(folderId)];
  }

  /** 把一次性导入的内容从「我喜欢的歌」里整个摘掉 */
  removeFolderOnce(folderId) {
    const fid = String(folderId);
    delete this.data.favTracks[fid];
    delete this.data.favOnce[fid];
    this.save();
    return { sources: this.favSources(), once: this.favOnceSources() };
  }

  favSources() {
    return Object.values(this.data.favSources);
  }

  isFollowing(folderId) {
    return !!this.data.favSources[String(folderId)];
  }

  /**
   * 「我喜欢的歌」的全部曲目：本地音乐 + 链接收藏 + 跟随的收藏夹，按加入时间倒序。
   * 排除表里的（用户手动移除过的）不出现。
   */
  lovedTracks() {
    const out = [];
    const seen = new Set();
    const push = (type, t) => {
      if (!t) return;
      const id = t.id || t.bvid;
      if (!id) return;
      const k = `${type}:${id}`;
      if (this.data.loveExcluded[k] || seen.has(k)) return;
      seen.add(k);
      out.push({ ...t, _type: type, _key: k });
    };

    for (const t of Object.values(this.data.local)) push('local', t);
    for (const t of Object.values(this.data.bili)) push('bili', t);
    for (const tracks of Object.values(this.data.favTracks || {})) {
      for (const t of Object.values(tracks)) push('bili', t);
    }
    // 逐首点爱心进来的（收藏夹里没入库的歌也能有）
    for (const rec of Object.values(this.data.lovedManual || {})) {
      if (!rec || !rec.track) continue;
      push(rec.type, rec.track);
    }

    out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return out;
  }

  /**
   * 「我喜欢的歌」里所有曲目的键集合：`${type}:${id}`。
   * 列表里每行靠它决定爱心是亮的还是灰的。
   */
  lovedKeys() {
    return this.lovedTracks().map((t) => t._key);
  }

  /** 某首歌是否已经在「我喜欢的歌」里 */
  isLoved(type, id) {
    if (!type || !id) return false;
    return this.lovedTracks().some((t) => t._key === `${type}:${id}`);
  }

  /**
   * 逐首加入「我喜欢的歌」。track 是完整的曲目对象（收藏夹里没入库的也能收）。
   * 已存在则只更新 addedAt 之外的字段，不重复。
   */
  addToLoved(type, track) {
    if (!type || !track) return null;
    const id = track.id || track.localId || track.bvid;
    if (!id) return null;
    const k = `${type}:${id}`;
    // addedAt 取现在：列表按加入时间倒序，刚点爱心的应该排最前面
    const now = Date.now();
    this.data.lovedManual[k] = { type, track: { ...track, id, addedAt: now }, addedAt: now };
    // 手动加回来的，把排除记录撤掉，否则 lovedTracks 会一直过滤它
    delete this.data.loveExcluded[k];
    this.save();
    return { ok: true, key: k, total: this.lovedTracks().length };
  }

  /** 逐首移出「我喜欢的歌」（删手动记录 + 记排除，防止被收藏夹同步或库同步带回来） */
  removeFromLoved(type, track) {
    if (!type || !track) return null;
    const id = track.id || track.localId || track.bvid;
    if (!id) return null;
    const k = `${type}:${id}`;
    delete this.data.lovedManual[k];
    this.data.loveExcluded[k] = true;
    this.save();
    return { ok: true, key: k, total: this.lovedTracks().length };
  }

  /** 从「我喜欢的歌」里移除（只记排除，不删库里的曲目） */
  excludeFromLoved(type, id) {
    if (!type || !id) return null;
    const k = `${type}:${id}`;
    delete this.data.lovedManual[k];
    this.data.loveExcluded[k] = true;
    this.save();
    return { total: this.lovedTracks().length };
  }

  // ---------- 收藏夹条目在本应用内隐藏 ----------

  /**
   * 在本应用里隐藏一个收藏夹条目（不动 B 站）。
   * key 是渲染层算出来的条目标识：单 P 是 bvid，多 P 分 P 是 `bvid:pN`。
   */
  hideFavItem(folderId, item) {
    if (folderId == null || !item) return null;
    const key = item.key || item.bvid;
    if (!key) return null;
    const fid = String(folderId);
    this.data.favHidden[`${fid}:${key}`] = {
      folderId: fid,
      key,
      bvid: item.bvid || '',
      page: Number(item.page) || 1,
      title: item.title || '',
      hiddenAt: Date.now(),
    };
    this.save();
    return { ok: true, total: this.hiddenCount() };
  }

  /** 取消隐藏 */
  unhideFavItem(folderId, key) {
    if (folderId == null || !key) return null;
    delete this.data.favHidden[`${folderId}:${key}`];
    this.save();
    return { ok: true, total: this.hiddenCount() };
  }

  /** 某个收藏夹里被隐藏的条目键集合（渲染层过滤用） */
  hiddenKeys(folderId) {
    const fid = String(folderId);
    return Object.values(this.data.favHidden || {})
      .filter((h) => String(h.folderId) === fid)
      .map((h) => h.key);
  }

  /** 全部隐藏记录（设置页里可以一次性看清/清空） */
  hiddenItems(folderId) {
    const all = Object.values(this.data.favHidden || {});
    if (folderId == null) return all;
    const fid = String(folderId);
    return all.filter((h) => String(h.folderId) === fid);
  }

  hiddenCount() {
    return Object.keys(this.data.favHidden || {}).length;
  }

  /** 清空隐藏记录；给了 folderId 就只清那个收藏夹的 */
  clearHidden(folderId) {
    if (folderId == null) {
      this.data.favHidden = {};
    } else {
      const fid = String(folderId);
      for (const [k, h] of Object.entries(this.data.favHidden || {})) {
        if (String(h.folderId) === fid) delete this.data.favHidden[k];
      }
    }
    this.save();
    return { ok: true, total: this.hiddenCount() };
  }

  /** 撤销移除 */
  includeInLoved(type, id) {
    if (!type || !id) return null;
    delete this.data.loveExcluded[`${type}:${id}`];
    this.save();
    return { total: this.lovedTracks().length };
  }

  excludedCount() {
    return Object.keys(this.data.loveExcluded || {}).length;
  }

  /** 把歌单条目解析成完整曲目对象（跳过的记 null） */
  resolvePlaylist(plId) {
    if (plId === LOVE_ID) {
      return { id: LOVE_ID, title: LOVE_TITLE, special: true, items: [], tracks: this.lovedTracks() };
    }
    const p = this.data.playlists[plId];
    if (!p) return null;
    const out = [];
    for (const it of p.items) {
      const t = it.type === 'local' ? this.data.local[it.id] : this.data.bili[it.id];
      if (t) out.push({ ...t, _type: it.type });
    }
    return { ...p, tracks: out };
  }

  stats() {
    return {
      folders: this.data.folders.length,
      local: Object.keys(this.data.local).length,
      localMissing: Object.values(this.data.local).filter((t) => t.missing).length,
      bili: Object.keys(this.data.bili).length,
      playlists: Object.keys(this.data.playlists).length,
      loved: this.lovedTracks().length,
      followed: Object.keys(this.data.favSources || {}).length,
      importedOnce: Object.keys(this.data.favOnce || {}).length,
      hidden: this.hiddenCount(),
    };
  }
}

module.exports = { Library, LOVE_ID, LOVE_TITLE };
