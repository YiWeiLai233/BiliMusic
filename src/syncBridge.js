'use strict';

/**
 * 桌面端「同步桥」：把 library.json 的存储结构 ↔ [SyncDoc] 互转，
 * 并提供局域网同步服务端 + UDP 自动发现。
 *
 * ## 为什么需要这一层
 *
 * library.json 是给人用的结构：歌单曲目是一个数组，顺序就是下标。
 * SyncDoc 是给合并用的结构：顺序是「分数位置键」，每条曲目还带墓碑和 HLC 时间戳。
 * 两者不能混为一谈，所以这里做双向投影：
 *
 *   library.data --captureLocal--> SyncDoc --Merger.merge--> SyncDoc --applyDoc--> library.data
 *
 * 关键设计：**captureLocal 是差量写**。只有当 library 里的内容与 doc 里投影出来的
 * 内容不一致时才写入并推进 HLC。否则每次捕获都会产生一批新时间戳，
 * 把对方刚合并进来的修改又顶回去（这就是「同步来回打架」的根源）。
 *
 * 只同步 tracks / playlists / marks 三张表；收藏夹镜像、本机目录、隐藏记录
 * 这些都是「这台机器的偏好」，不该跟着账号跑。
 */

const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const dgram = require('node:dgram');

const { Hlc, Merger, Pos, Codec, maxTsOf, emptyDoc } = require('./sync');

const DISCOVERY_PORT = 41789;
const DISCOVERY_MAGIC = 'BILIMUSIC1';
const MAX_BODY = 8 * 1024 * 1024;

// ------------------------------------------------------------ library ↔ doc

function coreOfBili(t) {
  const id = String(t.id || t.bvid || '');
  return {
    key: 'bili:' + id,
    type: 'bili',
    id,
    bvid: String(t.bvid || ''),
    cid: Number(t.cid) || 0,
    page: Number(t.page) || 1,
    title: String(t.title || ''),
    artist: String(t.artist || t.upper || ''),
    cover: String(t.cover || t.pic || ''),
    duration: Math.round(Number(t.duration) || 0),
    partCount: Number(t.partCount) || (t.multiPage ? 2 : 1),
  };
}

function coreOfLocal(t) {
  return {
    key: 'local:' + t.id,
    type: 'local',
    id: String(t.id),
    bvid: '',
    cid: 0,
    page: 1,
    title: String(t.title || t.name || ''),
    artist: String(t.artist || ''),
    // 本地文件的封面是 dataURL，同步出去能把载荷撑到几 MB，而且换台机器也用不上
    cover: '',
    duration: Math.round(Number(t.duration) || 0),
    partCount: 1,
  };
}

const CORE_FIELDS = ['key', 'type', 'id', 'bvid', 'cid', 'page', 'title', 'artist', 'cover', 'duration', 'partCount'];

function sameCore(a, b) {
  if (!a || !b) return false;
  for (const f of CORE_FIELDS) {
    if ((a[f] ?? '') !== (b[f] ?? '')) return false;
  }
  return true;
}

function itemOrder(a, b) {
  const c = Pos.compare(Pos.decode(a.pos.v), Pos.decode(b.pos.v));
  if (c !== 0) return c;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function liveItems(p) {
  return Object.values((p && p.items) || {})
    .filter((i) => i.present.v)
    .sort(itemOrder);
}

function liveItemKeys(p) {
  return liveItems(p).map((i) => i.key);
}

function sameSeq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isSubsetSeq(sub, sup) {
  // sub 是不是 sup 删掉若干个元素后的结果
  let i = 0;
  for (const k of sup) {
    if (i < sub.length && sub[i] === k) i++;
  }
  return i === sub.length;
}

class SyncBridge {
  /**
   * @param {object} opts
   * @param {object} opts.library  Library 实例（读 .data 写 .save）
   * @param {string} [opts.file] 同步状态文件，默认与 library.json 同目录的 sync-state.json
   * @param {string} [opts.deviceId]
   * @param {string} [opts.deviceName]
   */
  constructor(opts) {
    const o = opts || {};
    this.library = o.library;
    this.file = o.file || null;
    this.deviceId = o.deviceId || 'desktop';
    this.deviceName = o.deviceName || os.hostname() || 'Desktop';
    this.clock = Hlc.zero;
    this.doc = null;
    /**
     * 「上一次同步之后，library 应该长什么样」的规范化快照。
     *
     * 没有它的话，captureLocal 只能拿 library 和 doc 现有内容对比，于是
     * **每一次捕获都会把本地状态重新断言一遍**——对方刚删掉的歌单会被本地
     * 这份「还活在 library 里」的旧状态以更新的时间戳顶回去，删除就永远传播不了。
     *
     * 有了基线，captureLocal 只写「相对于基线发生了变化的部分」，也就是用户
     * 真正做过的操作；远端合并进来的结果会先落到 library 并刷新基线，
     * 下一轮捕获自然认为它没被改过。
     */
    this.baseline = null;
    this.load();
  }

  // ---------------------------------------------------------------- 存取

  load() {
    let doc = null;
    try {
      if (this.file && fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && raw.tracks && raw.playlists && raw.marks) doc = raw;
      }
    } catch (_) {
      // 文件坏了就当空文档，别让它炸掉启动流程
      try {
        if (this.file && fs.existsSync(this.file)) {
          fs.renameSync(this.file, this.file + '.broken.' + Date.now());
        }
      } catch (_) {}
    }
    if (!doc) doc = emptyDoc(this.deviceId, this.deviceName);
    doc.version = doc.version || 1;
    doc.deviceId = this.deviceId;
    doc.deviceName = this.deviceName;
    this.doc = doc;
    const t = maxTsOf(doc);
    this.clock = new Hlc(t.wall, t.counter);
  }

  save() {
    if (!this.file) return;
    try {
      const dir = require('node:path').dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      this.doc.deviceId = this.deviceId;
      this.doc.deviceName = this.deviceName;
      this.doc.at = Date.now();
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.doc));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[sync] 保存同步状态失败:', e.message);
    }
  }

  tick() {
    return this.clock.tick();
  }

  reg(value) {
    const ts = this.tick();
    return { v: value, ts: ts.toJson(), by: this.deviceId };
  }

  // ------------------------------------------------------ library → doc

  /**
   * 把 library.data 的当前样子差量写进 doc。
   * @returns {boolean} 是否产生了修改
   */
  captureLocal() {
    const cur = this.snapshotLocal();
    const base = this.baseline || {
      tracks: {},
      playlists: {},
      excluded: new Set(),
      loved: new Set(),
    };
    let changed = false;

    // ---------- 曲目 ----------
    // 只断言「相对基线发生了变化」的部分。基线里已经在、且内容没变的曲目一律不碰，
    // 否则远端刚删掉的歌会被本地这份「还活着」的旧状态以更新的时间戳顶回来。
    const baseTracks = base.tracks || {};
    for (const [k, core] of Object.entries(cur.tracks)) {
      const b = baseTracks[k];
      if (b && sameCore(b, core)) continue; // 用户没动过它
      const e = this.doc.tracks[k];
      if (e && e.present.v && sameCore(e.core.v, core)) continue; // doc 已是目标状态
      const ts = this.tick().toJson();
      this.doc.tracks[k] = {
        core: { v: core, ts, by: this.deviceId },
        present: { v: true, ts, by: this.deviceId },
      };
      changed = true;
    }
    for (const k of Object.keys(baseTracks)) {
      if (cur.tracks[k]) continue; // 还在库里
      const e = this.doc.tracks[k];
      if (!e || !e.present.v) continue; // 已经是墓碑
      const ts = this.tick().toJson();
      e.present = { v: false, ts, by: this.deviceId };
      changed = true;
    }

    // ---------- 歌单 ----------
    const basePl = base.playlists || {};
    for (const [id, sp] of Object.entries(cur.playlists)) {
      // __loved__ 是虚拟歌单，不参与同步
      if (id === '__loved__') continue;
      const bp = basePl[id];
      let entry = this.doc.playlists[id];
      if (!entry) {
        const ts = this.tick().toJson();
        entry = {
          id,
          title: { v: sp.title, ts, by: this.deviceId },
          createdAt: sp.createdAt || Date.now(),
          present: { v: true, ts, by: this.deviceId },
          items: {},
        };
        this.doc.playlists[id] = entry;
        changed = true;
      } else {
        if (!entry.present.v) {
          const ts = this.tick().toJson();
          entry.present = { v: true, ts, by: this.deviceId };
          changed = true;
        }
        // 标题同样只看「相对基线改过没有」
        if (bp && sp.title !== bp.title) {
          entry.title = this.reg(sp.title);
          changed = true;
        }
      }

      const baseKeys = bp ? bp.keys : [];
      const baseSet = new Set(baseKeys);
      const wantSet = new Set(sp.keys);

      // 删除项：基线里有过、现在没了 —— 这才是用户真的删了
      for (const k of baseKeys) {
        if (wantSet.has(k)) continue;
        const it = entry.items[k];
        if (!it || !it.present.v) continue;
        const ts = this.tick().toJson();
        it.present = { v: false, ts, by: this.deviceId };
        changed = true;
      }

      // 新增项：现在有、基线里没有 —— 分配位置键
      const adds = sp.keys.filter((k) => !baseSet.has(k));
      if (adds.length && this._assignPositions(entry, sp.keys)) changed = true;

      // 顺序：只比较「两边都有的键」的相对次序，否则远端新加的项会被当成乱序
      const commonBase = baseKeys.filter((k) => wantSet.has(k));
      const commonSnap = sp.keys.filter((k) => baseSet.has(k));
      if (commonBase.length >= 2 && !sameSeq(commonBase, commonSnap)) {
        // 用户拖动过顺序，按新顺序整体重排位置键（末次写入胜，天然收敛）
        if (this._assignPositions(entry, sp.keys)) changed = true;
      }
    }

    // 基线里有、现在没了的歌单 → 墓碑（只对本机删掉的负责）
    for (const [id, p] of Object.entries(this.doc.playlists)) {
      if (!p.present.v) continue;
      if (cur.playlists[id]) continue;
      if (!basePl[id]) continue;
      const ts = this.tick().toJson();
      p.present = { v: false, ts, by: this.deviceId };
      changed = true;
    }

    // ---------- 我喜欢的歌 ----------
    // 桌面端是「派生 + 排除表」，不是显式集合，所以只同步相对基线的变化
    const baseLoved = base.loved || new Set();
    const baseExcluded = base.excluded || new Set();
    for (const k of cur.loved) {
      if (baseLoved.has(k)) continue;
      const m = this.doc.marks[k];
      if (m && m.loved.v === true) continue;
      this.doc.marks[k] = { key: k, loved: this.reg(true), at: Date.now() };
      changed = true;
    }
    for (const k of cur.excluded) {
      if (baseExcluded.has(k)) continue;
      const m = this.doc.marks[k];
      if (m && m.loved.v === false) continue;
      this.doc.marks[k] = { key: k, loved: this.reg(false), at: Date.now() };
      changed = true;
    }

    this.baseline = cur;
    if (changed) this.save();
    return changed;
  }

  /**
   * 把 library.data 压成一份可比较的规范化快照。
   * 这样 captureLocal 就能判断「用户到底改了什么」，而不用靠猜。
   */
  snapshotLocal() {
    const lib = (this.library && this.library.data) || {};
    const tracks = {};
    for (const t of Object.values(lib.bili || {})) {
      if (!t || !(t.id || t.bvid)) continue;
      const c = coreOfBili(t);
      tracks[c.key] = c;
    }
    for (const t of Object.values(lib.local || {})) {
      if (!t || !t.id) continue;
      const c = coreOfLocal(t);
      tracks[c.key] = c;
    }
    const playlists = {};
    for (const [id, p] of Object.entries(lib.playlists || {})) {
      if (id === '__loved__') continue;
      playlists[id] = {
        title: p.title || '新建歌单',
        createdAt: p.createdAt || 0,
        keys: (p.items || []).map((it) => `${it.type}:${it.id}`),
      };
    }
    const excluded = new Set(Object.keys(lib.loveExcluded || {}));
    const loved = new Set();
    for (const k of this._derivedLovedKeys()) if (!excluded.has(k)) loved.add(k);
    return { tracks, playlists, excluded, loved };
  }

  /**
   * 按 libKeys 的顺序给曲目分配位置键。
   * 已经在正确相对顺序上的项保留原位置，只给新项算中值；顺序乱了才整体重排。
   */
  _assignPositions(playlist, orderedKeys) {
    let changed = false;
    // 现有的、活着的位置
    const have = new Map();
    for (const it of Object.values(playlist.items)) {
      if (it.present.v) have.set(it.key, Pos.decode(it.pos.v));
    }
    const kept = orderedKeys.filter((k) => have.has(k));
    const keptSorted = kept.slice().sort((a, b) => Pos.compare(have.get(a), have.get(b)));
    const orderOk = sameSeq(kept, keptSorted);

    if (!orderOk) {
      // 整体重排：从头往后按 38 的步长排，压得太紧时 Pos.between 会自动细分
      let prev = null;
      for (const k of orderedKeys) {
        const pos = Pos.encode(Pos.between(prev, null));
        prev = Pos.decode(pos);
        changed = this._setPos(playlist, k, pos) || changed;
      }
      return changed;
    }

    // 顺序正确：只给缺位置的项补
    for (let i = 0; i < orderedKeys.length; i++) {
      const k = orderedKeys[i];
      const cur = playlist.items[k];
      if (cur && cur.present.v && cur.pos.v) continue;
      let prevPos = null;
      for (let j = i - 1; j >= 0; j--) {
        const nk = orderedKeys[j];
        const nb = playlist.items[nk];
        if (nb && nb.present.v && nb.pos.v) {
          prevPos = Pos.decode(nb.pos.v);
          break;
        }
      }
      let nextPos = null;
      for (let j = i + 1; j < orderedKeys.length; j++) {
        const nb = playlist.items[orderedKeys[j]];
        if (nb && nb.present.v && nb.pos.v) {
          nextPos = Pos.decode(nb.pos.v);
          break;
        }
      }
      const pos = Pos.encode(Pos.between(prevPos, nextPos));
      changed = this._setPos(playlist, k, pos) || changed;
    }
    return changed;
  }

  _setPos(playlist, key, pos) {
    const cur = playlist.items[key];
    if (cur && cur.present.v && cur.pos.v === pos) return false;
    const ts = this.tick().toJson();
    const base = cur || { key, present: { v: true, ts, by: this.deviceId }, addedAt: Date.now() };
    playlist.items[key] = {
      key,
      pos: { v: pos, ts, by: this.deviceId },
      present: { v: true, ts: base.present && base.present.ts ? base.present.ts : ts, by: this.deviceId },
      addedAt: base.addedAt || Date.now(),
    };
    // 重新加入的项也要把一个活着的 present 写上去
    if (!cur || !cur.present.v) {
      playlist.items[key].present = { v: true, ts, by: this.deviceId };
    }
    return true;
  }

  /** library 推导出的「我喜欢的歌」键集合（与 Library.lovedTracks 同语义） */
  _derivedLovedKeys() {
    try {
      return this.library.lovedKeys();
    } catch (_) {
      return [];
    }
  }

  // ------------------------------------------------------ doc → library

  /** 把 doc（活着的那部分）写回 library.data */
  applyDoc() {
    const lib = (this.library && this.library.data) || {};
    let changed = false;

    // ---------- 曲目 ----------
    // 先处理墓碑：doc 里被删掉的曲目，本地也要跟着消失，否则「删除」永远传不过来
    for (const [key, e] of Object.entries(this.doc.tracks)) {
      if (e.present.v) continue;
      const i = key.indexOf(':');
      const type = key.slice(0, i);
      const id = key.slice(i + 1);
      if (type === 'bili') {
        if (lib.bili && lib.bili[id]) {
          delete lib.bili[id];
          changed = true;
        }
      } else if (type === 'local') {
        if (lib.local && lib.local[id]) {
          delete lib.local[id];
          changed = true;
        }
      }
      // 歌单里引用它的项也一并摘掉，避免留下指向不存在曲目的空行
      for (const p of Object.values(lib.playlists || {})) {
        if (!Array.isArray(p.items)) continue;
        const before = p.items.length;
        p.items = p.items.filter((it) => `${it.type}:${it.id}` !== key);
        if (p.items.length !== before) changed = true;
      }
    }

    for (const e of Object.values(this.doc.tracks)) {
      if (!e.present.v) continue;
      const c = e.core.v;
      if (c.type === 'bili') {
        const id = c.id || c.bvid;
        const prev = lib.bili[id];
        const next = {
          ...(prev || {}),
          id,
          bvid: c.bvid || prev && prev.bvid || id.split(':')[0],
          cid: c.cid || (prev && prev.cid) || 0,
          page: c.page || 1,
          title: c.title || (prev && prev.title) || id,
          artist: c.artist || (prev && prev.artist) || '',
          cover: c.cover || (prev && prev.cover) || '',
          duration: c.duration || (prev && prev.duration) || 0,
          multiPage: (c.partCount || 1) > 1,
          addedAt: (prev && prev.addedAt) || Date.now(),
        };
        if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) {
          lib.bili[id] = next;
          changed = true;
        }
      } else if (c.type === 'local') {
        const prev = lib.local[c.id];
        if (!prev) {
          // 对方机器上的本地文件，这边没有实际路径，只能留一条「缺文件」占位，
          // 让歌单里不会出现空行，同时告诉用户这首得在原来那台机器上听
          lib.local[c.id] = {
            id: c.id,
            kind: 'local',
            bvid: '',
            path: '',
            name: c.title,
            title: c.title,
            artist: c.artist,
            album: '',
            duration: c.duration,
            cover: '',
            tagged: false,
            missing: true,
            addedAt: Date.now(),
          };
          changed = true;
        } else if (prev.title !== c.title || prev.artist !== c.artist) {
          prev.title = c.title || prev.title;
          prev.artist = c.artist || prev.artist;
          changed = true;
        }
      }
    }

    // ---------- 歌单 ----------
    for (const p of Object.values(this.doc.playlists)) {
      if (!p.present.v) {
        if (lib.playlists[p.id]) {
          delete lib.playlists[p.id];
          changed = true;
        }
        continue;
      }
      const items = liveItems(p).map((it) => {
        const i = it.key.indexOf(':');
        return { type: it.key.slice(0, i), id: it.key.slice(i + 1) };
      });
      const prev = lib.playlists[p.id];
      if (!prev) {
        lib.playlists[p.id] = {
          id: p.id,
          title: p.title.v,
          items,
          createdAt: p.createdAt || Date.now(),
        };
        changed = true;
      } else {
        if (prev.title !== p.title.v) {
          prev.title = p.title.v;
          changed = true;
        }
        const prevSeq = (prev.items || []).map((it) => `${it.type}:${it.id}`);
        const nextSeq = items.map((it) => `${it.type}:${it.id}`);
        if (!sameSeq(prevSeq, nextSeq)) {
          prev.items = items;
          changed = true;
        }
      }
    }

    // ---------- 我喜欢的歌 ----------
    for (const m of Object.values(this.doc.marks)) {
      const loved = m.loved.v === true;
      if (loved) {
        if (lib.loveExcluded && lib.loveExcluded[m.key]) {
          delete lib.loveExcluded[m.key];
          changed = true;
        }
        // 本地压根没有这首歌（比如对方收藏夹里的），补一条手动收藏，否则列表里看不到
        if (!this._hasTrack(m.key) && !(lib.lovedManual && lib.lovedManual[m.key])) {
          const c = this.doc.tracks[m.key] && this.doc.tracks[m.key].core.v;
          if (c) {
            const i = m.key.indexOf(':');
            lib.lovedManual[m.key] = {
              type: m.key.slice(0, i),
              track: { ...c, id: c.id || c.bvid, addedAt: m.at || Date.now() },
              addedAt: m.at || Date.now(),
            };
            changed = true;
          }
        }
      } else {
        if (lib.lovedManual && lib.lovedManual[m.key]) {
          delete lib.lovedManual[m.key];
          changed = true;
        }
        if (!(lib.loveExcluded && lib.loveExcluded[m.key])) {
          lib.loveExcluded[m.key] = true;
          changed = true;
        }
      }
    }

    if (changed && this.library && typeof this.library.save === 'function') {
      this.library.save();
    }
    // 远端合并进来的结果现在已经是「本地状态」了。刷新基线，下一轮 captureLocal
    // 就会认为这些内容用户没动过，不会拿新时间戳把它们再断言一遍。
    this.baseline = this.snapshotLocal();
    return changed;
  }

  _hasTrack(key) {
    const lib = (this.library && this.library.data) || {};
    const i = key.indexOf(':');
    const type = key.slice(0, i);
    const id = key.slice(i + 1);
    if (type === 'bili') {
      if (lib.bili && lib.bili[id]) return true;
      for (const tracks of Object.values(lib.favTracks || {})) {
        if (tracks && tracks[id]) return true;
      }
      return false;
    }
    if (type === 'local') return !!(lib.local && lib.local[id]);
    return false;
  }

  // ---------------------------------------------------------------- 合并

  /** 一次完整的本地捕获 + 合并 + 回写 */
  mergeRemote(remoteDoc) {
    this.captureLocal();
    const t = maxTsOf(remoteDoc);
    this.clock.observe(t);
    const before = this.doc;
    const merged = Merger.merge(this.doc, remoteDoc);
    merged.deviceId = this.deviceId;
    merged.deviceName = this.deviceName;
    this.doc = merged;
    this.applyDoc();
    this.save();
    return this.diff(before, merged);
  }

  diff(before, after) {
    let newTracks = 0;
    for (const [k, v] of Object.entries(after.tracks)) {
      const old = before.tracks[k];
      if (v.present.v && (!old || !old.present.v)) newTracks++;
    }
    let newPlaylists = 0;
    for (const [k, v] of Object.entries(after.playlists)) {
      const old = before.playlists[k];
      if (v.present.v && (!old || !old.present.v)) newPlaylists++;
    }
    let addedItems = 0;
    for (const [pid, p] of Object.entries(after.playlists)) {
      const old = before.playlists[pid];
      for (const [ik, iv] of Object.entries(p.items)) {
        if (!iv.present.v) continue;
        const ov = old && old.items && old.items[ik];
        if (!ov || !ov.present.v) addedItems++;
      }
    }
    return { newTracks, newPlaylists, addedItems, changed: before !== after };
  }

  /**
   * 导出一份文档，供二维码/文本同步码/HTTP 交换使用。
   *
   * 注意：**必须带上墓碑**。删除本身也是一次「写入」，只有把 present=false 的那条
   * 记录发出去，对端才知道这首被删了；如果把墓碑过滤掉，对端只会看见「没有这条」，
   * 于是它本地那份还活着的拷贝永远删不掉——删除就永远传播不了。
   * 墓碑的大小由 vacuum() 按天数回收，不靠导出时剥离。
   */
  exportCompact() {
    this.captureLocal();
    const out = {
      version: 1,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      at: Date.now(),
      tracks: { ...this.doc.tracks },
      playlists: {},
      marks: { ...this.doc.marks },
    };
    for (const [k, v] of Object.entries(this.doc.playlists)) {
      // 歌单里的项同理：删掉的项也要带上，否则对端删不掉
      out.playlists[k] = { ...v, items: { ...v.items } };
    }
    return out;
  }

  exportCode() {
    return Codec.encode(this.exportCompact());
  }

  importCode(text) {
    return this.mergeRemote(Codec.decode(text));
  }

  stats() {
    let tombstones = 0;
    for (const v of Object.values(this.doc.tracks)) if (!v.present.v) tombstones++;
    for (const v of Object.values(this.doc.playlists)) if (!v.present.v) tombstones++;
    return {
      tracks: Object.values(this.doc.tracks).filter((v) => v.present.v).length,
      playlists: Object.values(this.doc.playlists).filter((v) => v.present.v).length,
      loved: Object.values(this.doc.marks).filter((v) => v.loved.v).length,
      tombstones,
      device: this.deviceId,
      deviceName: this.deviceName,
      bytes: Codec.pack(this.exportCompact()).length,
    };
  }
}

// ------------------------------------------------------------- 局域网服务端

class SyncServer {
  constructor(token, handler) {
    this.token = String(token || '');
    this.handler = handler;
    this.server = null;
    this.port = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this._onRequest(req, res));
      srv.on('error', reject);
      srv.listen(0, '0.0.0.0', () => {
        this.server = srv;
        this.port = srv.address().port;
        resolve(this.port);
      });
    });
  }

  _onRequest(req, res) {
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/sync') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers['x-sync-token'] !== this.token) {
      res.writeHead(403);
      res.end();
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let out;
      try {
        out = this.handler(Buffer.concat(chunks));
      } catch (e) {
        console.error('[sync] 处理同步请求失败:', e.message);
        out = Buffer.alloc(0);
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': out.length,
        Connection: 'close',
      });
      res.end(out);
    });
  }

  stop() {
    if (this.server) {
      try {
        this.server.close();
      } catch (_) {}
      this.server = null;
    }
    this.port = 0;
  }
}

function localAddress() {
  const ifaces = os.networkInterfaces();
  const cands = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      cands.push({ name: name.toLowerCase(), addr: a.address });
    }
  }
  const score = (c) => {
    let s = 0;
    if (/wlan|wi-?fi|wlp|en0/.test(c.name)) s -= 100;
    if (/ethernet|eth|enp|eno/.test(c.name)) s -= 50;
    if (c.addr.startsWith('192.168.')) s -= 30;
    else if (c.addr.startsWith('10.')) s -= 20;
    else if (c.addr.startsWith('172.')) s -= 10;
    return s;
  };
  cands.sort((a, b) => score(a) - score(b));
  return cands.length ? cands[0].addr : null;
}

// --------------------------------------------------------------- UDP 发现

class SyncDiscovery {
  constructor() {
    this.sock = null;
    this.timer = null;
    this.peers = new Map();
    this.onPeers = null;
    this.self = { name: 'Desktop', port: 0, token: '' };
  }

  start(deviceName, port, token, onPeers) {
    this.self = { name: deviceName || 'Desktop', port, token };
    this.onPeers = onPeers;
    if (this.sock) return;
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', () => {
      try {
        s.close();
      } catch (_) {}
      this.sock = null;
    });
    s.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
    s.bind(DISCOVERY_PORT, () => {
      try {
        s.setBroadcast(true);
      } catch (_) {}
      this.sock = s;
      this.timer = setInterval(() => this._broadcast(), 2000);
      this._broadcast();
    });
  }

  updateSelf(port, token) {
    this.self.port = port;
    this.self.token = token;
  }

  _broadcast() {
    if (!this.sock || !this.self.port) return;
    const msg = Buffer.from(`${DISCOVERY_MAGIC}|${this.self.port}|${this.self.token}|${this.self.name}`, 'utf8');
    const targets = ['255.255.255.255'];
    const local = localAddress();
    if (local) {
      const p = local.split('.');
      if (p.length === 4) targets.push(`${p[0]}.${p[1]}.${p[2]}.255`);
    }
    for (const t of targets) {
      this.sock.send(msg, DISCOVERY_PORT, t, () => {});
    }
  }

  _onMessage(buf, rinfo) {
    const parts = buf.toString('utf8').split('|');
    if (parts.length < 4 || parts[0] !== DISCOVERY_MAGIC) return;
    const port = Number(parts[1]) || 0;
    const token = parts[2];
    const name = parts.slice(3).join('|');
    if (!port) return;
    if (localAddress() === rinfo.address && port === this.self.port) return;
    const key = `${rinfo.address}:${port}`;
    this.peers.set(key, { name, host: rinfo.address, port, token, seenAt: Date.now() });
    this._prune();
  }

  _prune() {
    const cutoff = Date.now() - 10000;
    let changed = false;
    for (const [k, v] of this.peers) {
      if (v.seenAt < cutoff) {
        this.peers.delete(k);
        changed = true;
      }
    }
    if (this.onPeers) this.onPeers(this.list());
    return changed;
  }

  list() {
    this._pruneQuiet();
    return Array.from(this.peers.values()).sort((a, b) => b.seenAt - a.seenAt);
  }

  _pruneQuiet() {
    const cutoff = Date.now() - 10000;
    for (const [k, v] of this.peers) if (v.seenAt < cutoff) this.peers.delete(k);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.sock) {
      try {
        this.sock.close();
      } catch (_) {}
      this.sock = null;
    }
    this.peers.clear();
    if (this.onPeers) this.onPeers([]);
  }
}

// --------------------------------------------------------------- HTTP 客户端

function exchange(host, port, token, doc, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = Codec.pack(doc);
    const req = http.request(
      {
        host,
        port,
        method: 'POST',
        path: '/sync',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
          'X-Sync-Token': token,
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`对方拒绝了同步请求（HTTP ${res.statusCode}）`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          try {
            resolve({ remote: Codec.unpack(buf), bytesIn: buf.length, bytesOut: body.length });
          } catch (e) {
            reject(new Error('对方的响应无法解析：' + e.message));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('连接超时，检查两台设备是否在同一个 Wi-Fi'));
    });
    req.on('error', (e) => reject(e));
    req.end(body);
  });
}

// ------------------------------------------------------------------ 门面

class SyncService {
  constructor({ library, file, deviceId, deviceName }) {
    this.bridge = new SyncBridge({ library, file, deviceId, deviceName });
    this.discovery = new SyncDiscovery();
    this.server = null;
    this.token = '';
    this.status = { state: 'idle', message: '' };
  }

  get doc() {
    return this.bridge.doc;
  }

  info() {
    return {
      running: !!this.server,
      ip: localAddress(),
      port: this.server ? this.server.port : 0,
      token: this.token,
      device: this.bridge.deviceId,
      deviceName: this.bridge.deviceName,
      peers: this.discovery.list(),
      stats: this.bridge.stats(),
      status: this.status,
    };
  }

  pairingPayload() {
    if (!this.server) return '';
    return `bilimusic://pair?ip=${localAddress()}&port=${this.server.port}&token=${this.token}`;
  }

  startServer() {
    if (this.server) return Promise.resolve(this.info());
    this.token = randomToken();
    this.server = new SyncServer(this.token, (body) => {
      try {
        const remote = Codec.unpack(body);
        this.bridge.mergeRemote(remote);
        return Codec.pack(this.bridge.exportCompact());
      } catch (e) {
        console.error('[sync] 服务端合并失败:', e.message);
        return Buffer.alloc(0);
      }
    });
    return this.server.start().then((port) => {
      try {
        this.discovery.start(this.bridge.deviceName, port, this.token, () => {});
      } catch (_) {}
      return this.info();
    });
  }

  stopServer() {
    this.discovery.stop();
    if (this.server) this.server.stop();
    this.server = null;
    this.token = '';
    return this.info();
  }

  /** 主动连对方做一次双向交换 */
  async syncNow(host, port, token) {
    this.status = { state: 'running', message: `正在连接 ${host}:${port} …` };
    try {
      const r = await exchange(host, port, token, this.bridge.exportCompact());
      const d = this.bridge.mergeRemote(r.remote);
      this.status = { state: 'ok', message: describe(d) };
      return { ok: true, message: this.status.message, ...d };
    } catch (e) {
      this.status = { state: 'failed', message: e.message };
      return { ok: false, message: e.message };
    }
  }

  exportCode() {
    return this.bridge.exportCode();
  }

  importCode(text) {
    try {
      const d = this.bridge.importCode(text);
      this.status = { state: 'ok', message: describe(d) };
      return { ok: true, message: this.status.message, ...d };
    } catch (e) {
      this.status = { state: 'failed', message: e.message };
      return { ok: false, message: e.message };
    }
  }
}

function describe(d) {
  const parts = [];
  if (d.newTracks > 0) parts.push(`${d.newTracks} 首新歌`);
  if (d.newPlaylists > 0) parts.push(`${d.newPlaylists} 个新歌单`);
  if (d.addedItems > 0) parts.push(`${d.addedItems} 条曲目`);
  return parts.length ? '同步完成：新增 ' + parts.join('、') : '已是最新';
}

function randomToken() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = require('node:crypto').randomBytes(12);
  let s = '';
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

module.exports = {
  SyncBridge,
  SyncServer,
  SyncDiscovery,
  SyncService,
  exchange,
  localAddress,
  describe,
  randomToken,
  coreOfBili,
  coreOfLocal,
  sameCore,
  liveItemKeys,
  DISCOVERY_PORT,
  DISCOVERY_MAGIC,
};
