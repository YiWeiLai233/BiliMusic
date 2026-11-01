'use strict';
/**
 * 本地音乐库：扫描文件夹 → 读 ID3 标签 → 建索引。
 * 只记录文件路径，不复制文件；文件被移走/删除时标记为 missing。
 *
 * music-metadata 是纯 ESM，主进程是 CJS，所以只能用动态 import()。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const AUDIO_EXTS = new Set([
  '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus',
  '.wav', '.wma', '.ape', '.alac', '.aiff', '.aif', '.mka', '.webm',
]);

/** 单次扫描最多收这么多文件，防手滑选到整个磁盘 */
const MAX_FILES = 20000;
/** 同时读标签的并发数 */
const TAG_CONCURRENCY = 6;

let mmPromise = null;
/** 懒加载 music-metadata（ESM） */
function loadMM() {
  if (!mmPromise) mmPromise = import('music-metadata');
  return mmPromise;
}

function isAudioFile(name) {
  return AUDIO_EXTS.has(path.extname(name).toLowerCase());
}

/** 稳定的条目 id：路径的 sha1 前缀 */
function makeId(filePath) {
  return 'L' + crypto.createHash('sha1').update(filePath.toLowerCase()).digest('hex').slice(0, 16);
}

/** 从文件名猜「歌名 - 歌手」，标签缺失时兜底 */
function guessFromName(fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  // 「01. 歌名」「01 - 歌名」
  let s = base.replace(/^\s*\d{1,3}\s*[.\-_、)]\s*/, '').trim();
  // 「歌名 - 歌手」/「歌手 - 歌名」都见过，默认按「歌名 - 歌手」切
  const m = s.split(/\s+[-–—]\s+/);
  if (m.length >= 2) {
    return { title: m[0].trim() || base, artist: m.slice(1).join(' - ').trim() };
  }
  return { title: s || base, artist: '' };
}

/**
 * 递归列出目录下的音频文件。
 * @param {string} dir
 * @param {{max?:number, onProgress?:(n:number)=>void}} opts
 * @returns {Promise<string[]>}
 */
async function listAudioFiles(dir, { max = MAX_FILES, onProgress } = {}) {
  const out = [];
  const stack = [dir];
  let seenDirs = 0;

  while (stack.length && out.length < max) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue; // 没权限或已删除，跳过
    }
    seenDirs++;
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        // 跳过隐藏目录和常见无关目录
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
        stack.push(full);
      } else if (ent.isFile() && isAudioFile(ent.name)) {
        out.push(full);
        if (out.length >= max) break;
      }
    }
    if (onProgress) onProgress(out.length);
  }
  return out;
}

/**
 * 读一个文件的标签，转成条目。
 * 读失败也返回条目（用文件名兜底），只是 tagged=false。
 */
async function readTrack(filePath, mm) {
  const stat = await fsp.stat(filePath).catch(() => null);
  const id = makeId(filePath);
  const base = {
    id,
    kind: 'local',
    bvid: '',
    path: filePath,
    name: path.basename(filePath),
    size: stat ? stat.size : 0,
    mtime: stat ? stat.mtimeMs : 0,
    title: '',
    artist: '',
    album: '',
    duration: 0,
    cover: '',
    tagged: false,
    missing: false,
  };
  if (!stat) return { ...base, missing: true, ...guessFromName(filePath) };

  let meta = null;
  try {
    meta = await mm.parseFile(filePath, { duration: true, skipCovers: false });
  } catch {
    meta = null;
  }

  if (!meta) {
    return { ...base, ...guessFromName(filePath) };
  }

  const c = meta.common || {};
  const f = meta.format || {};
  const guessed = guessFromName(filePath);
  const pictures = Array.isArray(c.picture) ? c.picture : [];

  let cover = '';
  if (pictures.length) {
    // 挑像素最多的一张，避免拿封面缩略图
    const best = pictures.reduce((a, b) => {
      const sa = (a.data && a.data.length) || 0;
      const sb = (b.data && b.data.length) || 0;
      return sb > sa ? b : a;
    });
    if (best && best.data && best.data.length) {
      const fmt = (best.format || '').includes('png') ? 'png' : 'jpg';
      cover = `data:image/${fmt};base64,${Buffer.from(best.data).toString('base64')}`;
    }
  }

  const title = (c.title || '').trim() || guessed.title;
  const artist = (c.artist || c.albumartist || (Array.isArray(c.artists) ? c.artists.join(' / ') : '') || '').trim() || guessed.artist;

  return {
    ...base,
    title,
    artist,
    album: (c.album || '').trim(),
    duration: f.duration ? Math.round(f.duration) : 0,
    cover,
    tagged: !!(c.title || c.artist || c.album),
  };
}

/** 并发受限地 map */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 扫描一个文件夹，返回曲目数组。
 * @param {string} dir
 * @param {{onProgress?:(p:{files:number, done:number, total:number})=>void}} opts
 */
async function scanFolder(dir, { onProgress } = {}) {
  const mm = await loadMM();
  const files = await listAudioFiles(dir, {
    onProgress: (n) => onProgress && onProgress({ phase: 'list', files: n, done: 0, total: 0 }),
  });

  const total = files.length;
  let done = 0;
  const tracks = await mapLimit(files, TAG_CONCURRENCY, async (fp) => {
    const t = await readTrack(fp, mm);
    done++;
    if (onProgress && (done % 5 === 0 || done === total)) {
      onProgress({ phase: 'tags', files: total, done, total });
    }
    return t;
  });

  return { dir, tracks };
}

module.exports = {
  AUDIO_EXTS,
  MAX_FILES,
  isAudioFile,
  makeId,
  guessFromName,
  listAudioFiles,
  readTrack,
  scanFolder,
  loadMM,
};
