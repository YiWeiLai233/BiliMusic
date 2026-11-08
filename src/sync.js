'use strict';

/**
 * 无服务器同步内核（桌面端实现）。
 *
 * 这是安卓端 `android/.../sync/` 目录的逐行等价移植：HLC 时钟、分数位置键、
 * LWW 寄存器、墓碑集合、编解码。两端产出/消费的是同一份二进制载荷，
 * 所以手机和电脑之间可以任意方向交换。
 *
 * 只依赖 Node 内置模块，不引第三方库。
 */

const zlib = require('node:zlib');

// ---------------------------------------------------------------- HLC 时钟

/** 混合逻辑时钟：墙钟 + 计数器，保证「新写入」永远大于此前见过的一切时间戳 */
class Hlc {
  constructor(wall = 0, counter = 0) {
    this.wall = wall;
    this.counter = counter | 0;
  }

  static get zero() {
    return new Hlc(0, 0);
  }

  /** 本地写入前调用 */
  tick(now = Date.now()) {
    if (now > this.wall) {
      this.wall = now;
      this.counter = 0;
    } else {
      this.counter = (this.counter + 1) | 0;
    }
    return new Hlc(this.wall, this.counter);
  }

  /** 收到对方文档后调用：把自己的时钟推到不小于对方 */
  observe(remote, now = Date.now()) {
    if (!remote) return;
    if (remote.wall > this.wall) {
      this.wall = remote.wall;
      this.counter = remote.counter | 0;
    } else if (remote.wall === this.wall && (remote.counter | 0) > this.counter) {
      this.counter = remote.counter | 0;
    }
  }

  toJson() {
    return { wall: this.wall, counter: this.counter };
  }

  static fromJson(o) {
    if (!o) return Hlc.zero;
    return new Hlc(Number(o.wall) || 0, Number(o.counter) || 0);
  }

  static cmp(a, b) {
    if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
    if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
    return 0;
  }
}

/**
 * 比较两个「带作者」的时间戳。时间戳完全相同时用 deviceId 定序，
 * 保证任意两端算出的胜者一致（否则合并就不对称了）。
 */
function hlcGreater(aTs, aBy, bTs, bBy) {
  const c = Hlc.cmp(aTs, bTs);
  if (c !== 0) return c > 0;
  return String(aBy || '') > String(bBy || '');
}

/** 末次写入胜 */
function pickReg(a, b) {
  return hlcGreater(Hlc.fromJson(a.ts), a.by, Hlc.fromJson(b.ts), b.by) ? a : b;
}

/** 从一份文档里扫出最大的时间戳，用于 observeRemote */
function maxTsOf(doc) {
  let best = Hlc.zero;
  const scan = (reg) => {
    if (!reg) return;
    const t = Hlc.fromJson(reg.ts);
    if (Hlc.cmp(t, best) > 0) best = t;
  };
  for (const e of Object.values(doc.tracks || {})) {
    scan(e.core);
    scan(e.present);
  }
  for (const p of Object.values(doc.playlists || {})) {
    scan(p.title);
    scan(p.present);
    for (const it of Object.values(p.items || {})) {
      scan(it.pos);
      scan(it.present);
    }
  }
  for (const m of Object.values(doc.marks || {})) scan(m.loved);
  return best;
}

// -------------------------------------------------------------- 分数位置键

/**
 * 位置键：把「顺序」变成可无限细分的坐标，插入时取左右邻居的中点。
 * 删除一条不影响任何其它条的坐标，因此两端各自删除也能正确合并。
 *
 * 表示为整数数组，按字典序比较，短的是长的前缀时更小。
 */
const Pos = {
  compare(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    if (a.length === b.length) return 0;
    return a.length < b.length ? -1 : 1;
  },

  encode(p) {
    return p.map((v) => (v >>> 0).toString(36)).join('.');
  },

  decode(s) {
    if (!s) return [];
    return s.split('.').map((x) => {
      const v = parseInt(x, 36);
      return Number.isFinite(v) ? v : 0;
    });
  },

  /** a 为 null 表示无下界，b 为 null 表示无上界 */
  between(a, b) {
    if (!a && !b) return [38];
    if (!a) {
      if (!b.length) return [0];
      return b[0] > 0 ? [Math.floor(b[0] / 2)] : [b[0] - 1];
    }
    if (!b) return [a[0] + 1];

    let i = 0;
    const n = Math.min(a.length, b.length);
    while (i < n && a[i] === b[i]) i++;

    if (i === a.length && i === b.length) return [38];
    if (i === a.length) {
      const head = a.slice();
      const bi = b[i];
      return bi > Number.MIN_SAFE_INTEGER + 1
        ? head.concat([bi - 1])
        : head.concat(Pos.between(null, b.slice(i)));
    }
    if (i === b.length) return Pos.between(null, a);

    const ai = a[i];
    const bi = b[i];
    if (bi - ai >= 2) return a.slice(0, i).concat([Math.floor((ai + bi) / 2)]);
    const head = a.slice(0, i + 1);
    return head.concat(Pos.after(a.slice(i + 1)));
  },

  after(a) {
    if (!a.length) return [0];
    return [a[0] + 1];
  },

  /** 在有序的已有位置之后追加一个新的 */
  append(posList) {
    let last = null;
    for (const p of posList) {
      const d = Pos.decode(p);
      if (!last || Pos.compare(d, last) > 0) last = d;
    }
    return Pos.encode(last ? Pos.between(last, null) : Pos.between(null, null));
  },
};

// ------------------------------------------------------------------ 合并

function mergeMap(a, b, f) {
  if (!a || Object.keys(a).length === 0) return b || {};
  if (!b || Object.keys(b).length === 0) return a;
  const out = {};
  for (const k of Object.keys(a)) {
    out[k] = b[k] ? f(a[k], b[k]) : a[k];
  }
  for (const k of Object.keys(b)) {
    if (!(k in a)) out[k] = b[k];
  }
  return out;
}

/** 整个无服务器方案的心脏：交换律 + 结合律 + 幂等 */
const Merger = {
  merge(a, b) {
    if (a === b) return a;
    return {
      version: Math.max(a.version || 1, b.version || 1),
      // deviceId 只是「这份文件谁在写」的本地身份，但 merge 必须是纯对称函数，
      // 所以取字典序较小者；调用方合并后会把本机真实 id 写回去。
      deviceId: String(a.deviceId || '') <= String(b.deviceId || '') ? a.deviceId || '' : b.deviceId || '',
      deviceName: a.deviceName || b.deviceName || '',
      at: Math.max(a.at || 0, b.at || 0),
      tracks: mergeMap(a.tracks, b.tracks, Merger.mergeTrack),
      playlists: mergeMap(a.playlists, b.playlists, Merger.mergePlaylist),
      marks: mergeMap(a.marks, b.marks, Merger.mergeMark),
    };
  },

  mergeTrack(x, y) {
    return { core: pickReg(x.core, y.core), present: pickReg(x.present, y.present) };
  },

  mergeMark(x, y) {
    return { key: x.key, loved: pickReg(x.loved, y.loved), at: Math.max(x.at || 0, y.at || 0) };
  },

  mergePlaylist(x, y) {
    return {
      id: x.id,
      title: pickReg(x.title, y.title),
      createdAt: x.createdAt > 0 ? x.createdAt : y.createdAt || 0,
      present: pickReg(x.present, y.present),
      items: mergeMap(x.items, y.items, Merger.mergeItem),
    };
  },

  mergeItem(p, q) {
    return {
      key: p.key,
      pos: pickReg(p.pos, q.pos),
      present: pickReg(p.present, q.present),
      addedAt: p.addedAt > 0 ? p.addedAt : q.addedAt || 0,
    };
  },
};

// ------------------------------------------------------------------ 编解码

const MAGIC0 = 0x42;
const MAGIC1 = 0x4d;
const FORMAT_VERSION = 1;
const HEADER = 10;
const COMPRESS_THRESHOLD = 96;
const FLAG_DEFLATE = 1;
const FLAG_CHUNK = 2;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INV = (() => {
  const m = new Map();
  for (let i = 0; i < B64.length; i++) m.set(B64[i], i);
  return m;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

const Base64Url = {
  encode(buf) {
    let out = '';
    let i = 0;
    while (i < buf.length) {
      const b0 = buf[i];
      const b1 = i + 1 < buf.length ? buf[i + 1] : 0;
      const b2 = i + 2 < buf.length ? buf[i + 2] : 0;
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | (b1 >> 4)];
      if (i + 1 < buf.length) out += B64[((b1 & 15) << 2) | (b2 >> 6)];
      if (i + 2 < buf.length) out += B64[b2 & 63];
      i += 3;
    }
    return out;
  },

  decode(text) {
    const s = String(text).trim().replace(/=+$/, '');
    const out = Buffer.alloc(Math.floor((s.length * 6) / 8) + 2);
    let n = 0;
    let buf = 0;
    let bits = 0;
    for (const ch of s) {
      let v;
      if (B64_INV.has(ch)) v = B64_INV.get(ch);
      else if (ch === '+') v = 62;
      else if (ch === '/') v = 63;
      else if (/\s/.test(ch)) continue;
      else throw new Error(`同步码里有非法字符「${ch}」`);
      buf = ((buf << 6) | v) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[n++] = (buf >> bits) & 0xff;
      }
    }
    return out.subarray(0, n);
  },
};

const Codec = {
  /** 文档 → 二进制载荷 */
  pack(doc) {
    const raw = Buffer.from(JSON.stringify(doc), 'utf8');
    let body = raw;
    let flags = 0;
    if (raw.length >= COMPRESS_THRESHOLD) {
      const def = zlib.deflateRawSync(raw, { level: 9 });
      if (def.length < raw.length) {
        body = def;
        flags = FLAG_DEFLATE;
      }
    }
    const out = Buffer.alloc(HEADER + body.length);
    out[0] = MAGIC0;
    out[1] = MAGIC1;
    out[2] = FORMAT_VERSION;
    out[3] = flags;
    out[4] = 1;
    out[5] = 1;
    out.writeUInt32BE(crc32(body), 6);
    body.copy(out, HEADER);
    return out;
  },

  unpack(bytes) {
    const buf = Buffer.from(bytes);
    if (buf.length < HEADER) throw new Error('同步码太短');
    if (buf[0] !== MAGIC0 || buf[1] !== MAGIC1) throw new Error('这不是 BiliMusic 的同步码');
    if (buf[2] !== FORMAT_VERSION) throw new Error(`同步码格式版本不支持：${buf[2]}`);
    const flags = buf[3];
    if (flags & FLAG_CHUNK) throw new Error('这是分片二维码，不是完整同步码');
    const crc = buf.readUInt32BE(6);
    const body = buf.subarray(HEADER);
    if (crc32(body) !== crc) throw new Error('同步码校验失败，复制时可能丢了字符');
    const raw = flags & FLAG_DEFLATE ? zlib.inflateRawSync(body) : body;
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch (e) {
      throw new Error(`同步码内容解析失败：${e.message}`);
    }
  },

  encode(doc) {
    return Base64Url.encode(Codec.pack(doc));
  },

  decode(text) {
    return Codec.unpack(Base64Url.decode(text));
  },
};

// ------------------------------------------------------------------ 文档工具

function emptyDoc(deviceId = '', deviceName = '') {
  return {
    version: 1,
    deviceId,
    deviceName,
    at: Date.now(),
    tracks: {},
    playlists: {},
    marks: {},
  };
}

module.exports = {
  Hlc,
  hlcGreater,
  pickReg,
  maxTsOf,
  Pos,
  Merger,
  Codec,
  Base64Url,
  crc32,
  emptyDoc,
  emptyDocOf: emptyDoc,
};
