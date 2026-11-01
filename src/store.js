'use strict';
/** 极简 JSON 设置存储（写临时文件再 rename，避免损坏） */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  quality: 0, // 0 = 自动最高
  volume: 0.8,
  muted: false,
  playMode: 'loop-all', // loop-all | loop-one | shuffle
  /** 点关闭按钮时的行为：ask=每次询问 | tray=最小化到托盘 | quit=退出程序 */
  closeAction: 'ask',
  closeToTray: true, // 旧版遗留字段，仅用于迁移，不再读取
  minimizeToTray: false,
  autoLaunch: false,
  onlyMusic: true,
  /** 手动标记的音乐判断：{ [bvid]: true = 手动标为音乐, false = 手动标为非音乐 } */
  musicOverrides: {},
  lastFolderId: null,
  windowBounds: null,
  showLyricPanel: false,
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.data = { ...DEFAULTS, ...raw };
        // 旧版 closeToTray（布尔）→ 新版 closeAction
        if (!raw.closeAction && typeof raw.closeToTray === 'boolean') {
          this.data.closeAction = raw.closeToTray ? 'tray' : 'quit';
          this.save();
        }
      }
    } catch {
      /* 首次运行 */
    }
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return { ...this.data };
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  patch(obj) {
    Object.assign(this.data, obj);
    this.save();
  }

  // ---- 手动音乐标记 ----

  /** 取手动标记：true=手动音乐，false=手动非音乐，undefined=没标过（用自动判断） */
  musicOverride(bvid) {
    const m = this.data.musicOverrides;
    if (!m || typeof m !== 'object') return undefined;
    const v = m[bvid];
    return v === true || v === false ? v : undefined;
  }

  /** 全部手动标记的浅拷贝 */
  allMusicOverrides() {
    const m = this.data.musicOverrides;
    return m && typeof m === 'object' ? { ...m } : {};
  }

  /** 设置/清除一条手动标记（传 undefined 或 null 表示清除） */
  setMusicOverride(bvid, value) {
    if (!bvid) return this.allMusicOverrides();
    const m = { ...this.allMusicOverrides() };
    if (value === true || value === false) m[bvid] = value;
    else delete m[bvid];
    this.data.musicOverrides = m;
    this.save();
    return { ...m };
  }

  /** 批量合并（渲染层一次改多条时用） */
  mergeMusicOverrides(obj) {
    const m = { ...this.allMusicOverrides() };
    for (const [k, v] of Object.entries(obj || {})) {
      if (!k) continue;
      if (v === true || v === false) m[k] = v;
      else if (v === null) delete m[k];
    }
    this.data.musicOverrides = m;
    this.save();
    return { ...m };
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn('[store] 保存失败', e.message);
    }
  }
}

module.exports = { Store, DEFAULTS };
