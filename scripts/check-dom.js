'use strict';
/**
 * 静态检查：renderer/app.js 里 $('xxx') 引用的 id 是否都在 index.html 里存在。
 * 漏一个 id 的后果是运行时静默 null，点按钮没反应，很难查。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const refs = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

const missing = [...refs].filter((r) => !ids.has(r));
console.log(`html ids: ${ids.size}, js refs: ${refs.size}`);
console.log(`missing in html: ${missing.length ? missing.join(', ') : '(none)'}`);

// 同步面板必须齐全
const need = [
  'btn-sync',
  'sync-mask',
  'btn-sync-close',
  'sync-status',
  'btn-sync-start',
  'btn-sync-stop',
  'sync-local',
  'sync-addr',
  'sync-token',
  'sync-qr',
  'sync-peers',
  'sync-peers-hint',
  'sync-host',
  'sync-port',
  'sync-pass',
  'btn-sync-connect',
  'btn-sync-export',
  'btn-sync-import',
  'sync-code',
];
const lack = need.filter((i) => !ids.has(i));
console.log(`sync ids missing: ${lack.length ? lack.join(', ') : '(none)'}`);

process.exit(missing.length === 0 && lack.length === 0 ? 0 : 1);
