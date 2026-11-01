'use strict';
/**
 * 本地音频代理：Chromium 的 <audio> 直接指向这里，
 * 由主进程带上 Referer / UA 去 B 站 CDN 取流并转发（含 Range 支持）。
 * 好处：直链过期可自动刷新、音画分离只取音频、封面绕开防盗链。
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { UA } = require('./bili');

/** 本地音频扩展名 → MIME */
const MIME = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-ape',
  '.alac': 'audio/mp4',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.mka': 'audio/x-matroska',
  '.webm': 'audio/webm',
};

const PASS_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
  'cache-control',
];

const LINK_TTL = 90 * 60 * 1000; // 直链约 2 小时，保守按 90 分钟提前刷新

class AudioProxy {
  /** @param {import('./bili').Bili} bili */
  constructor(bili, { token } = {}) {
    this.bili = bili;
    this.token = token || crypto.randomBytes(16).toString('hex');
    this.server = null;
    this.port = 0;
    /** @type {Map<string, {streams:any[], at:number}>} */
    this.streamCache = new Map();
    /** @type {Map<string, {buf:Buffer, type:string, at:number}>} */
    this.coverCache = new Map();
    this.coverInflight = new Map();
    this.stats = { bytesSent: 0, requests: 0, refreshes: 0, errors: 0 };
    /** 本地文件 id → 绝对路径（由主进程注入） */
    this.localResolver = null;
  }

  /** 注入「本地曲目 id → 文件路径」的解析器，避免把绝对路径暴露给渲染进程 */
  setLocalResolver(fn) {
    this.localResolver = fn;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** 给渲染进程用的播放地址 */
  audioUrl(bvid, cid, qualityId) {
    const q = qualityId ? `&q=${qualityId}` : '';
    return `${this.baseUrl}/audio/${encodeURIComponent(bvid)}/${cid}?token=${this.token}${q}`;
  }

  coverUrl(url) {
    if (!url) return '';
    // 本地曲目的封面已经是 data: URL，直接给渲染进程用
    if (url.startsWith('data:')) return url;
    return `${this.baseUrl}/cover?token=${this.token}&u=${encodeURIComponent(url)}`;
  }

  /** 本地曲目的播放地址 */
  localUrl(id) {
    return `${this.baseUrl}/local/${encodeURIComponent(id)}?token=${this.token}`;
  }

  async start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handle(req, res).catch((e) => {
          this.stats.errors++;
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          try {
            res.end(`proxy error: ${e.message}`);
          } catch {
            /* client gone */
          }
        });
      });
      server.on('error', reject);
      server.keepAliveTimeout = 65_000;
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /** 清空直链缓存（比如切换清晰度后强制重取） */
  invalidate(bvid, cid) {
    if (bvid && cid != null) this.streamCache.delete(`${bvid}:${cid}`);
    else this.streamCache.clear();
  }

  /** 预热：把已取到的直链列表放进缓存，避免代理再请求一次 playurl */
  prime(bvid, cid, streams) {
    if (!streams || !streams.length) return;
    this.streamCache.set(`${bvid}:${cid}`, { streams, at: Date.now() });
  }

  async _handle(req, res) {
    const u = new URL(req.url, `http://127.0.0.1:${this.port}`);
    if (u.searchParams.get('token') !== this.token) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    if (u.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, port: this.port, stats: this.stats }));
      return;
    }
    if (u.pathname.startsWith('/audio/')) {
      await this._serveAudio(req, res, u);
      return;
    }
    if (u.pathname.startsWith('/local/')) {
      await this._serveLocal(req, res, u);
      return;
    }
    if (u.pathname === '/cover') {
      await this._serveCover(req, res, u);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  // ---------- 音频 ----------

  async _ensureStreams(bvid, cid, qualityId) {
    const key = `${bvid}:${cid}`;
    const hit = this.streamCache.get(key);
    const fresh = hit && Date.now() - hit.at < LINK_TTL;
    if (fresh && hit.streams.length) {
      if (!qualityId) return hit.streams;
      const match = hit.streams.find((s) => String(s.id) === String(qualityId));
      if (match) return [match, ...hit.streams.filter((s) => s !== match)];
      return hit.streams;
    }
    const streams = await this.bili.audioStreams(bvid, Number(cid));
    this.streamCache.set(key, { streams, at: Date.now() });
    if (hit) this.stats.refreshes++;
    return streams;
  }

  async _fetchStream(streams, rangeHeader) {
    let lastErr = null;
    for (const s of streams) {
      for (const url of s.urls) {
        try {
          const r = await fetch(url, {
            headers: {
              'User-Agent': UA,
              Referer: 'https://www.bilibili.com/',
              Origin: 'https://www.bilibili.com',
              ...(rangeHeader ? { Range: rangeHeader } : {}),
            },
          });
          if (r.status === 200 || r.status === 206 || r.status === 416) {
            return { res: r, url };
          }
          lastErr = new Error(`CDN ${r.status}`);
          try {
            await r.arrayBuffer();
          } catch {
            /* drain */
          }
        } catch (e) {
          lastErr = e;
        }
      }
    }
    throw lastErr || new Error('所有音频源都不可用');
  }

  async _serveAudio(req, res, u) {
    this.stats.requests++;
    const parts = u.pathname.split('/').filter(Boolean); // ['audio', bvid, cid]
    const bvid = decodeURIComponent(parts[1] || '');
    const cid = Number(parts[2] || 0);
    const qualityId = u.searchParams.get('q') || '';
    if (!bvid || !cid) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }

    const range = req.headers.range || '';
    let streams = await this._ensureStreams(bvid, cid, qualityId);
    let out;
    try {
      out = await this._fetchStream(streams, range);
    } catch (e) {
      // 直链过期或签名失效：强制刷新一次再试
      this.invalidate(bvid, cid);
      streams = await this._ensureStreams(bvid, cid, qualityId);
      out = await this._fetchStream(streams, range);
    }

    const upstream = out.res;
    const headers = {};
    for (const h of PASS_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    if (!headers['content-type'] || /octet-stream/i.test(headers['content-type'])) {
      headers['content-type'] = 'audio/mp4';
    }
    if (!headers['accept-ranges']) headers['accept-ranges'] = 'bytes';

    res.writeHead(upstream.status, headers);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const reader = upstream.body;
    if (!reader) {
      res.end();
      return;
    }

    let aborted = false;
    res.on('close', () => {
      aborted = true;
      try {
        reader.cancel();
      } catch {
        /* ignore */
      }
    });

    try {
      for await (const chunk of reader) {
        if (aborted) break;
        this.stats.bytesSent += chunk.length;
        if (!res.write(chunk)) {
          await new Promise((r) => res.once('drain', r));
        }
      }
    } catch (e) {
      if (!aborted) this.stats.errors++;
    } finally {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }

  // ---------- 本地文件 ----------

  async _serveLocal(req, res, u) {
    this.stats.requests++;
    const parts = u.pathname.split('/').filter(Boolean); // ['local', id]
    const id = decodeURIComponent(parts[1] || '');
    if (!id || !this.localResolver) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }

    let filePath = '';
    try {
      filePath = this.localResolver(id) || '';
    } catch {
      filePath = '';
    }
    if (!filePath) {
      // 库里没有这条（可能被删了）
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    let st;
    try {
      st = await fsp.stat(filePath);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('file missing');
      return;
    }
    if (!st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not a file');
      return;
    }

    const total = st.size;
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const baseHeaders = {
      'content-type': mime,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    };

    // 解析 Range：只支持单段，够 <audio> 用了
    const rangeHeader = req.headers.range || '';
    let start = 0;
    let end = total - 1;
    let status = 200;

    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (m) {
        const hasStart = m[1] !== '';
        const hasEnd = m[2] !== '';
        if (hasStart && hasEnd) {
          start = Number(m[1]);
          end = Number(m[2]);
        } else if (hasStart) {
          start = Number(m[1]);
          end = total - 1;
        } else if (hasEnd) {
          // bytes=-N 表示最后 N 字节
          start = Math.max(0, total - Number(m[2]));
          end = total - 1;
        }
        if (Number.isNaN(start) || Number.isNaN(end)) {
          res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${total}` });
          res.end();
          return;
        }
        end = Math.min(end, total - 1);
        if (start > end || start >= total) {
          res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${total}` });
          res.end();
          return;
        }
        status = 206;
      }
    }

    const chunkLen = end - start + 1;
    const headers = {
      ...baseHeaders,
      'content-length': String(chunkLen),
    };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;

    res.writeHead(status, headers);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath, { start, end });
    let aborted = false;
    res.on('close', () => {
      aborted = true;
      stream.destroy();
    });
    stream.on('error', (e) => {
      this.stats.errors++;
      if (!aborted) {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
    });
    stream.on('data', (chunk) => {
      this.stats.bytesSent += chunk.length;
      if (!res.write(chunk)) {
        stream.pause();
        res.once('drain', () => stream.resume());
      }
    });
    stream.on('end', () => {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    });
  }

  // ---------- 封面 ----------

  async _serveCover(req, res, u) {
    const raw = u.searchParams.get('u') || '';
    if (!raw) {
      res.writeHead(400);
      res.end();
      return;
    }
    const key = raw;
    const cached = this.coverCache.get(key);
    if (cached && Date.now() - cached.at < 6 * 3600_000) {
      res.writeHead(200, {
        'content-type': cached.type,
        'content-length': String(cached.buf.length),
        'cache-control': 'public, max-age=21600',
      });
      res.end(cached.buf);
      return;
    }

    try {
      let task = this.coverInflight.get(key);
      if (!task) {
        task = this._downloadCover(raw);
        this.coverInflight.set(key, task);
        task.finally(() => this.coverInflight.delete(key));
      }
      const { buf, type } = await task;
      // 简单容量控制
      if (this.coverCache.size > 300) {
        const oldest = [...this.coverCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this.coverCache.delete(oldest[0]);
      }
      this.coverCache.set(key, { buf, type, at: Date.now() });
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(buf.length),
        'cache-control': 'public, max-age=21600',
      });
      res.end(buf);
    } catch (e) {
      this.stats.errors++;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('cover failed');
    }
  }

  async _downloadCover(raw) {
    // 尝试原图 → 降级到 512 缩略图
    const candidates = [raw];
    if (/\.(jpg|jpeg|png|webp)$/i.test(raw)) {
      candidates.push(raw.replace(/\.\w+$/, '.jpg'));
    }
    let lastErr = null;
    for (const url of candidates) {
      try {
        const r = await fetch(url, {
          headers: {
            'User-Agent': UA,
            Referer: 'https://www.bilibili.com/',
          },
        });
        if (!r.ok) {
          lastErr = new Error(`cover ${r.status}`);
          continue;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        const type = r.headers.get('content-type') || 'image/jpeg';
        if (buf.length) return { buf, type };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('封面下载失败');
  }
}

module.exports = { AudioProxy, LINK_TTL };
