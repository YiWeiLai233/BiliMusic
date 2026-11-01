'use strict';
/**
 * B 站 Web API 客户端：WBI 签名、扫码登录、收藏夹、视频信息、DASH 音频地址。
 * 只依赖 node 内置能力（fetch / crypto），cookie 存本地文件。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

// WBI mixin 重排表（B 站前端固定常量）
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

// 音乐相关分区 tid（视频本体分区，不是收藏夹分区）
const MUSIC_TIDS = new Set([3, 28, 31, 30, 59, 29, 193, 130]);

const QUALITY_LABEL = {
  30216: '64K 流畅',
  30232: '132K 标准',
  30280: '192K 高品',
  30250: '杜比全景声',
  30251: 'Hi-Res 无损',
};

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

/** B 站要求的参数编码：encodeURIComponent 后去掉 !'()* */
function encodeValue(v) {
  return encodeURIComponent(String(v)).replace(/[!'()*]/g, '');
}

function buildQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeValue(k)}=${encodeValue(params[k])}`)
    .join('&');
}

class BiliError extends Error {
  constructor(code, message, extra) {
    super(message || `接口错误 ${code}`);
    this.name = 'BiliError';
    this.code = code;
    this.extra = extra;
  }
}

class Bili {
  /** @param {string} dataDir 持久化目录（cookie / 缓存） */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.cookieFile = path.join(dataDir, 'cookies.json');
    this.cacheFile = path.join(dataDir, 'video-meta.json');
    /** @type {Map<string,string>} */
    this.cookies = new Map();
    /** @type {Record<string, any>} */
    this.videoMeta = {};
    this.wbiKeys = null;
    this.wbiAt = 0;
    this._metaDirty = false;
    this._metaFlushTimer = null;
    this.load();
  }

  // ---------- 持久化 ----------

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) this.cookies.set(k, String(v));
    } catch {
      /* 首次运行无文件 */
    }
    try {
      this.videoMeta = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) || {};
    } catch {
      this.videoMeta = {};
    }
  }

  saveCookies() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const obj = Object.fromEntries(this.cookies);
      fs.writeFileSync(this.cookieFile, JSON.stringify(obj, null, 2), 'utf8');
      // 文件尽量只给当前用户读写
      try {
        fs.chmodSync(this.cookieFile, 0o600);
      } catch {
        /* Windows 上 chmod 语义有限，忽略 */
      }
    } catch (e) {
      console.warn('[bili] 保存 cookie 失败', e.message);
    }
  }

  _scheduleMetaFlush() {
    this._metaDirty = true;
    if (this._metaFlushTimer) return;
    this._metaFlushTimer = setTimeout(() => {
      this._metaFlushTimer = null;
      if (!this._metaDirty) return;
      this._metaDirty = false;
      try {
        fs.mkdirSync(this.dataDir, { recursive: true });
        fs.writeFileSync(this.cacheFile, JSON.stringify(this.videoMeta), 'utf8');
      } catch (e) {
        console.warn('[bili] 写缓存失败', e.message);
      }
    }, 1500);
    if (this._metaFlushTimer.unref) this._metaFlushTimer.unref();
  }

  // ---------- cookie ----------

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  isLoggedIn() {
    return this.cookies.has('SESSDATA');
  }

  logout() {
    this.cookies.clear();
    this.saveCookies();
  }

  /** 从响应里吸收 Set-Cookie */
  _absorbCookies(res) {
    let list = [];
    try {
      list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    } catch {
      list = [];
    }
    if (!list.length) {
      const single = res.headers.get('set-cookie');
      if (single) list = single.split(/,(?=[^;]+?=)/);
    }
    for (const line of list) {
      const pair = line.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (!k) continue;
      if (v === '' || v === 'deleted') this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    return list.length > 0;
  }

  // ---------- 请求 ----------

  async _raw(url, { headers = {}, timeout = 15000, method = 'GET', body } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: {
          ...BASE_HEADERS,
          ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
          ...headers,
        },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      this._absorbCookies(res);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async _json(url, opts) {
    const res = await this._raw(url, opts);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new BiliError(-1, `接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
    }
  }

  /** 解析 wbi 密钥（1 小时缓存） */
  async _ensureWbi() {
    if (this.wbiKeys && Date.now() - this.wbiAt < 3600_000) return this.wbiKeys;
    const nav = await this._json('https://api.bilibili.com/x/web-interface/nav');
    const img = nav?.data?.wbi_img?.img_url || '';
    const sub = nav?.data?.wbi_img?.sub_url || '';
    if (!img || !sub) throw new BiliError(-1, '无法获取 WBI 密钥（nav 接口异常）');
    const orig =
      img.split('/').pop().split('.')[0] + sub.split('/').pop().split('.')[0];
    this.wbiKeys = MIXIN_TAB.map((i) => orig[i]).join('').slice(0, 32);
    this.wbiAt = Date.now();
    return this.wbiKeys;
  }

  async _signedParams(params) {
    const mixin = await this._ensureWbi();
    const withTs = { ...params, wts: Math.round(Date.now() / 1000) };
    const q = buildQuery(withTs);
    return `${q}&w_rid=${md5(q + mixin)}`;
  }

  /** 带 wbi 签名的 GET */
  async apiGet(baseUrl, params = {}) {
    const qs = await this._signedParams(params);
    return this._json(`${baseUrl}?${qs}`);
  }

  // ---------- 扫码登录 ----------

  async qrGenerate() {
    const r = await this._json(
      'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
      { headers: { Referer: 'https://passport.bilibili.com/' } },
    );
    if (r.code !== 0) throw new BiliError(r.code, r.message || '二维码生成失败');
    return { url: r.data.url, key: r.data.qrcode_key };
  }

  /**
   * 轮询扫码状态。
   * @returns {{state:'waiting'|'scanned'|'expired'|'ok', message:string}}
   */
  async qrPoll(key) {
    const r = await this._json(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`,
      { headers: { Referer: 'https://passport.bilibili.com/' } },
    );
    const code = r?.data?.code;
    if (r.code === 0 && code === 0) {
      // 部分情况下 cookie 只在 data.url 里给出，兜底解析
      if (!this.isLoggedIn() && r.data?.url) {
        try {
          const u = new URL(r.data.url);
          for (const [k, v] of u.searchParams) {
            if (/^(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|sid)$/.test(k)) {
              this.cookies.set(k, v);
            }
          }
        } catch {
          /* ignore */
        }
      }
      this.saveCookies();
      return { state: 'ok', message: '登录成功' };
    }
    if (code === 86101) return { state: 'waiting', message: '等待扫码' };
    if (code === 86090) return { state: 'scanned', message: '已扫码，请在手机上确认' };
    if (code === 86038) return { state: 'expired', message: '二维码已失效，请刷新' };
    if (code === 86102) return { state: 'scanned', message: '已扫码，请确认登录' };
    return { state: 'waiting', message: r.message || `状态 ${r.code}` };
  }

  /** 拿一个匿名 buvid，降低 -352 风控概率 */
  async ensureBuvid() {
    if (this.cookies.has('buvid3')) return;
    try {
      const r = await this._json('https://api.bilibili.com/x/frontend/finger/spi');
      const b3 = r?.data?.b_3;
      const b4 = r?.data?.b_4;
      if (b3) this.cookies.set('buvid3', b3);
      if (b4) this.cookies.set('buvid4', b4);
    } catch {
      /* 拿不到也不致命 */
    }
  }

  async nav() {
    // nav 未登录也返回 code 0，data.isLogin 表示状态
    const r = await this._json('https://api.bilibili.com/x/web-interface/nav');
    const d = r?.data || {};
    return {
      isLogin: !!d.isLogin,
      mid: d.mid || 0,
      uname: d.uname || '',
      face: d.face || '',
      vip: !!(d.vipStatus === 1 || d.vip?.status === 1),
      level: d.level_info?.current_level ?? 0,
    };
  }

  // ---------- 收藏夹 ----------

  async favFolders(mid) {
    if (!mid) throw new BiliError(-101, '未登录');
    // 优先 list-all
    try {
      const r = await this.apiGet('https://api.bilibili.com/x/v3/fav/folder/created/list-all', {
        up_mid: mid,
        type: 0,
        rid: 0,
        web_location: 333.1387,
      });
      if (r.code === 0 && Array.isArray(r.data?.list)) {
        return r.data.list.map(normalizeFolder).filter(Boolean);
      }
    } catch {
      /* 落到分页接口 */
    }
    const out = [];
    for (let pn = 1; pn <= 10; pn++) {
      const r = await this.apiGet('https://api.bilibili.com/x/v3/fav/folder/created/list', {
        up_mid: mid,
        pn,
        ps: 100,
        web_location: 333.1387,
      });
      if (r.code !== 0) throw new BiliError(r.code, r.message || '收藏夹列表获取失败');
      const list = r.data?.list || [];
      out.push(...list.map(normalizeFolder).filter(Boolean));
      if (list.length < 100) break;
    }
    return out;
  }

  /**
   * 拉一个收藏夹里的全部条目（分页直到 has_more=false 或到达上限）。
   * @param {(loaded:number, total:number)=>void} [onProgress]
   */
  async favItems(mediaId, { max = 600, onProgress } = {}) {
    const out = [];
    let total = 0;
    for (let pn = 1; pn <= 40; pn++) {
      const r = await this.apiGet('https://api.bilibili.com/x/v3/fav/resource/list', {
        media_id: mediaId,
        pn,
        ps: 20,
        keyword: '',
        order: 'mtime',
        type: 0,
        tid: 0,
        platform: 'web',
        web_location: 333.1387,
      });
      if (r.code !== 0) throw new BiliError(r.code, r.message || '收藏夹内容获取失败');
      const info = r.data?.info || {};
      total = info.media_count ?? total;
      const medias = r.data?.medias || [];
      for (const m of medias) {
        const item = normalizeFavItem(m);
        if (item) out.push(item);
      }
      if (onProgress) onProgress(out.length, total);
      if (!r.data?.has_more || !medias.length || out.length >= max) break;
      // 轻微节流，避免连续请求触发风控
      await new Promise((res) => setTimeout(res, 120));
    }
    return { items: out, total };
  }

  // ---------- 视频信息 / 播放地址 ----------

  /** 取视频元信息（含 cid、分区），带磁盘缓存 */
  async videoInfo(bvid, { force = false } = {}) {
    const cached = this.videoMeta[bvid];
    if (!force && cached && cached.ts && Date.now() - cached.ts < 7 * 86400_000) {
      return cached;
    }
    const r = await this._json(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    );
    if (r.code !== 0) throw new BiliError(r.code, r.message || '视频信息获取失败');
    const d = r.data;
    const pages = (d.pages || []).map((p) => ({
      page: p.page,
      cid: p.cid,
      part: p.part || '',
      duration: p.duration || 0,
    }));
    const meta = {
      bvid: d.bvid,
      aid: d.aid,
      title: d.title,
      tid: d.tid,
      tname: d.tname || '',
      tnamev2: d.tname_v2 || '',
      pic: d.pic || '',
      duration: d.duration || 0,
      pubdate: d.pubdate || 0,
      owner: d.owner?.name || '',
      ownerMid: d.owner?.mid || 0,
      isMusic: MUSIC_TIDS.has(d.tid) || /音乐|MV|演奏|翻唱|VOCALOID/.test(d.tname || ''),
      pages,
      cid: pages[0]?.cid || d.cid || 0,
      ts: Date.now(),
    };
    this.videoMeta[bvid] = meta;
    this._scheduleMetaFlush();
    return meta;
  }

  /** 批量补全（并发受限），用于收藏夹过滤和预取 cid */
  async resolveMany(bvids, { concurrency = 5, onOne } = {}) {
    const queue = [...new Set(bvids)];
    const results = new Map();
    let idx = 0;
    const workerCount = Math.min(concurrency, queue.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (idx < queue.length) {
        const bvid = queue[idx++];
        try {
          const meta = await this.videoInfo(bvid);
          results.set(bvid, meta);
          if (onOne) onOne(bvid, meta, null);
        } catch (e) {
          results.set(bvid, null);
          if (onOne) onOne(bvid, null, e);
        }
        await new Promise((res) => setTimeout(res, 120));
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * 解析用户粘贴的 B 站链接 / BV 号，返回可用于「我的库」的曲目列表。
   * 支持：BV1xx411c7mD、https://www.bilibili.com/video/BV…、av123、
   *       带 ?p=2 的单 P、以及分享短链 b23.tv（会先跟随重定向）。
   * 返回 { bvid, page, multiPage, tracks: [...] }
   * @param {string} input
   */
  async resolveLinks(input) {
    const tokens = extractBiliRefs(input);
    if (!tokens.length) throw new BiliError(-400, '没找到有效的 B 站视频链接或 BV 号');

    const out = [];
    const failed = [];
    const seen = new Set();

    for (const t of tokens) {
      let bvid = t.bvid;
      let page = t.page || 0;
      try {
        // b23.tv 短链：跟随一次重定向拿到真实地址
        if (!bvid && t.shortUrl) {
          const real = await this._followShort(t.shortUrl);
          const again = extractBiliRefs(real);
          if (again.length) {
            bvid = again[0].bvid;
            page = page || again[0].page || 0;
          }
        }
        if (!bvid && t.aid) {
          // av 号：先换成 BV
          const vr = await this._json(
            `https://api.bilibili.com/x/web-interface/view?aid=${t.aid}`,
          );
          if (vr.code === 0 && vr.data?.bvid) bvid = vr.data.bvid;
        }
        if (!bvid) throw new BiliError(-404, '链接里没有 BV 号');

        const meta = await this.videoInfo(bvid);
        const pages = meta.pages && meta.pages.length ? meta.pages : [{ cid: meta.cid, part: '', page: 1, duration: meta.duration }];
        // 指定了 p 就只取那一 P，否则多 P 全部导入
        const targets = page > 0 ? pages.filter((p) => p.page === page) : pages;
        const use = targets.length ? targets : [pages[0]];
        const multi = pages.length > 1;

        for (const p of use) {
          const key = `${meta.bvid}:${p.cid}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // 分 P 名常被作者填成和视频标题一样或把它包含进去，直接拼会重复
          const cleaned = cleanPartName(p.part, meta.title);
          const partName = multi ? (cleaned ? `P${p.page} ${cleaned}` : `P${p.page}`) : '';
          out.push({
            bvid: meta.bvid,
            // 多 P 视频的每个分 P 要有独立 id，否则在库里会互相覆盖
            id: multi ? `${meta.bvid}:p${p.page}` : meta.bvid,
            cid: p.cid,
            page: p.page || 1,
            title: partName ? `${meta.title} · ${partName}` : meta.title,
            artist: meta.owner || '',
            cover: meta.pic || '',
            duration: p.duration || meta.duration || 0,
            tname: meta.tname || '',
            isMusic: !!meta.isMusic,
            part: p.page || 1,
            multiPage: multi,
          });
        }
      } catch (e) {
        failed.push({ input: t.raw || bvid || t.shortUrl, error: e.message });
      }
      await new Promise((res) => setTimeout(res, 150));
    }

    if (!out.length) {
      throw new BiliError(-404, failed[0]?.error || '解析失败');
    }
    return { tracks: out, failed };
  }

  /** 跟随 b23.tv 短链的重定向（不真正下载页面） */
  async _followShort(url) {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    });
    const loc = r.headers.get('location');
    if (loc) return loc;
    if (r.url && r.url !== url) return r.url;
    return url;
  }

  /**
   * 取音频流地址列表（按码率降序）。
   * @param {string} bvid
   * @param {number} cid
   */
  async audioStreams(bvid, cid) {
    if (!bvid || !cid) throw new BiliError(-400, '缺少 bvid 或 cid');
    const r = await this.apiGet('https://api.bilibili.com/x/player/wbi/playurl', {
      bvid,
      cid,
      fnval: 16,
      fnver: 0,
      fourk: 1,
      web_location: 1315873,
    });
    if (r.code !== 0) throw new BiliError(r.code, r.message || '播放地址获取失败');
    const dash = r.data?.dash;
    const audio = Array.isArray(dash?.audio) ? dash.audio.slice() : [];
    if (!audio.length) {
      // 个别老视频只有 durl
      const durl = r.data?.durl;
      if (Array.isArray(durl) && durl[0]?.url) {
        return [
          {
            id: 0,
            label: '默认音轨',
            codecs: '',
            bandwidth: 0,
            urls: [durl[0].url, ...(durl[0].backup_url || [])].filter(Boolean),
          },
        ];
      }
      throw new BiliError(-404, '该视频没有可用的音频流');
    }
    audio.sort((a, b) => b.bandwidth - a.bandwidth);
    return audio.map((a) => ({
      id: a.id,
      label: QUALITY_LABEL[a.id] || `${a.id}`,
      codecs: a.codecs || '',
      bandwidth: a.bandwidth,
      urls: [a.baseUrl || a.base_url, ...(a.backupUrl || a.backup_url || [])].filter(Boolean),
    }));
  }
}

// ---------- 数据规整 ----------

function normalizeFolder(f) {
  if (!f || f.id == null) return null;
  return {
    id: Number(f.id),
    fid: Number(f.fid ?? f.id),
    title: f.title || '未命名收藏夹',
    mediaCount: Number(f.media_count ?? 0),
    attr: f.attr ?? 0,
  };
}

function normalizeFavItem(m) {
  if (!m) return null;
  const bvid = m.bvid || (typeof m.bv_id === 'string' ? m.bv_id : '');
  const type = m.type;
  // type: 2 = 视频，12 = 音频，21 = 视频合集。只保留能取音频的条目
  if (!bvid) return null;
  if (type != null && ![2, 21].includes(Number(type))) return null;
  const dur = parseDuration(m.duration);
  return {
    bvid,
    aid: Number(m.id ?? m.aid ?? 0),
    title: m.title || m.name || '未命名',
    cover: normalizePic(m.cover || m.pic || ''),
    duration: dur,
    upper: m.upper?.name || '',
    upperMid: m.upper?.mid || 0,
    favTime: Number(m.fav_time ?? m.ctime ?? 0),
    intro: m.intro || '',
    type: Number(type ?? 2),
  };
}

/** 收藏夹里的 duration 是秒数；view 接口也是秒数。统一为秒 */
function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return Number(v);
    const parts = v.split(':').map(Number);
    if (parts.every((n) => Number.isFinite(n))) {
      return parts.reduce((acc, n) => acc * 60 + n, 0);
    }
  }
  return 0;
}

/**
 * 从任意文本里抽出 B 站视频引用。
 * 返回 [{ raw, bvid, page, shortUrl }]
 */
function extractBiliRefs(input) {
  const text = String(input || '');
  const out = [];

  // BV 号：BV + 10 位 base58（允许 1 个前缀字母变体）
  const bvRe = /(?:BV|bv)([1-9A-HJ-NP-Za-km-z]{10})/g;
  let m;
  while ((m = bvRe.exec(text))) {
    out.push({ raw: m[0], bvid: 'BV' + m[1], page: 0 });
  }

  // av 号
  if (!out.length) {
    const avRe = /(?:^|[^a-zA-Z])av(\d{1,12})/i;
    const am = avRe.exec(text);
    if (am) out.push({ raw: am[0].trim(), bvid: '', aid: Number(am[1]), page: 0 });
  }

  // b23.tv 短链
  const shortRe = /https?:\/\/b23\.tv\/[A-Za-z0-9]+/g;
  const shorts = text.match(shortRe) || [];

  // 给每个引用补上 ?p= 参数
  const pRe = /[?&]p=(\d+)/i;
  const pm = pRe.exec(text);
  const page = pm ? Number(pm[1]) : 0;
  for (const r of out) r.page = page;

  // 只有短链、没有明写 BV 的情况
  if (!out.length && shorts.length) {
    for (const s of shorts) out.push({ raw: s, bvid: '', shortUrl: s, page });
  }

  // 去重
  const seen = new Set();
  return out.filter((r) => {
    const k = r.bvid || r.shortUrl || `av${r.aid}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 从分 P 名里把重复的视频标题剥掉。
 * B 站很多多 P 投稿的分 P 名形如「日-《某某EP | 歌名》」，而视频标题是「《某某EP | 歌名》」，
 * 直接拼会得到「X · P2 日-X」这种废话。这里只在分 P 名包含标题时才清洗，其余原样保留。
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
  // 去掉标题本体，再掐掉残留的分隔符和空白
  let out = p.split(t).join(' ').replace(/\s+/g, ' ').trim();
  out = out.replace(/^[-–—·:：|｜/\s]+/, '').replace(/[-–—·:：|｜/\s]+$/, '');
  return out;
}

function normalizePic(url) {
  if (!url) return '';
  let u = String(url).trim();
  if (u.startsWith('//')) u = 'https:' + u;
  if (u.startsWith('http://')) u = 'https://' + u.slice(7);
  // 去掉 @ 后缀拿到原图，代理端会再处理
  return u;
}

/**
 * 把收藏夹条目 + 解析到的元信息展开成可入库的曲目。
 * 多 P 视频按分 P 拆成独立曲目（id 为 `bvid:pN`），单 P 用裸 bvid。
 * 主进程（收藏夹跟随）用；渲染进程有一份等价实现，两边结果要一致。
 * @param {Array<{bvid:string}>} items favItems 返回的条目
 * @param {Map<string, any>} metas resolveMany 返回的 Map
 * @returns {Array<any>}
 */
function expandFavTracks(items, metas) {
  const out = [];
  const now = Date.now();
  for (const it of items || []) {
    const meta = metas && metas.get ? metas.get(it.bvid) : null;
    if (!meta) continue;
    const pages = Array.isArray(meta.pages) ? meta.pages : [];
    if (pages.length > 1) {
      for (const p of pages) {
        const cleaned = cleanPartName(p.part, meta.title);
        const partName = cleaned ? `P${p.page} ${cleaned}` : `P${p.page}`;
        out.push({
          id: `${meta.bvid}:p${p.page}`,
          bvid: meta.bvid,
          cid: p.cid,
          page: p.page,
          multiPage: true,
          title: `${meta.title} · ${partName}`,
          artist: meta.owner || '',
          cover: normalizePic(meta.pic || ''),
          duration: p.duration || meta.duration || 0,
          tname: meta.tname || '',
          isMusic: !!meta.isMusic,
          addedAt: now,
        });
      }
    } else {
      out.push({
        id: meta.bvid,
        bvid: meta.bvid,
        cid: meta.cid,
        page: 1,
        multiPage: false,
        title: meta.title,
        artist: meta.owner || '',
        cover: normalizePic(meta.pic || ''),
        duration: meta.duration || 0,
        tname: meta.tname || '',
        isMusic: !!meta.isMusic,
        addedAt: now,
      });
    }
  }
  return out;
}

module.exports = {
  Bili,
  BiliError,
  UA,
  BASE_HEADERS,
  MUSIC_TIDS,
  QUALITY_LABEL,
  extractBiliRefs,
  cleanPartName,
  expandFavTracks,
};
