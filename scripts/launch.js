'use strict';
/**
 * 启动器：把 Electron 运行时复制到项目外的固定目录，再从那里启动主程序。
 *
 * 为什么需要这么绕？
 *   本机上 electron.exe 只要位于 D:\bilibiliMusicPlayer 目录树下，
 *   Windows 的任务栏托盘图标注册就必然失败（tray.getBounds() 恒为 0x0，
 *   托盘里永远不会出现图标）；把同一份 dist 复制到项目外的目录就一切正常。
 *   已排除 ACL / 所有者 / token / 启动方式 / userData 位置等因素。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules', 'electron', 'dist');
const RT = path.join(os.homedir(), 'AppData', 'Local', 'BiliMusicRuntime');

function readVersion(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'version'), 'utf8').trim();
  } catch {
    return '';
  }
}

function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function pickExe(dir) {
  const names = ['electron.exe', 'electron'];
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function ensureRuntime() {
  const srcVer = readVersion(SRC);
  if (!srcVer) {
    throw new Error(`找不到 Electron 运行时：${SRC}（先运行 npm install）`);
  }
  const rtVer = readVersion(RT);
  const exe = pickExe(RT);
  if (rtVer === srcVer && exe) return { exe, copied: false };
  console.log(`[launch] 准备 Electron ${srcVer} 运行时 → ${RT}`);
  copyDir(SRC, RT);
  const exe2 = pickExe(RT);
  if (!exe2) throw new Error('运行时复制后仍找不到 electron 可执行文件');
  return { exe: exe2, copied: true };
}

function main() {
  let rt;
  try {
    rt = ensureRuntime();
  } catch (e) {
    console.error('[launch]', e.message);
    // 兜底：用项目内的 exe 启动（托盘图标在这台机器上会缺失）
    const inner = pickExe(SRC);
    if (!inner) process.exit(1);
    console.warn('[launch] 回退到项目内 Electron（托盘图标可能不可见）');
    rt = { exe: inner };
  }

  const args = ['.', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter', ...process.argv.slice(2)];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 环境里默认=1，不清会以 Node 模式跑

  const child = spawn(rt.exe, args, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    windowsHide: false,
  });
  child.on('exit', (code) => process.exit(code || 0));
}

main();
