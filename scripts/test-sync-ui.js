'use strict';
/**
 * 「跨设备同步」面板的 UI 冒烟测试。
 *
 * 跑法（**必须先清掉 ELECTRON_RUN_AS_NODE**，否则 electron.exe 会以纯 Node 模式启动）：
 *   Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
 *   node_modules\electron\dist\electron.exe scripts/test-sync-ui.js --no-sandbox --disable-gpu --disable-crash-reporter
 *
 * 只加载真实 renderer（renderer/index.html + app.js + style.css）+ 假 preload，
 * 不碰真实 B 站接口，所以能离线稳定跑。
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, '.userdata');
fs.mkdirSync(DATA, { recursive: true });
const LOG = path.join(DATA, 'sync-ui.log');
fs.writeFileSync(LOG, '');
const log = (...a) => {
  const line = a
    .map((x) => (x instanceof Error ? x.stack : typeof x === 'object' ? JSON.stringify(x) : String(x)))
    .join(' ');
  fs.appendFileSync(LOG, line + '\n');
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

app.setPath('userData', DATA);
app.setPath('sessionData', path.join(DATA, 'session'));
app.on('window-all-closed', () => {});

const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await app.whenReady();

  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    frame: false,
    backgroundColor: '#0d0f13',
    webPreferences: {
      preload: path.join(__dirname, 'test-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('preload-error', (_e, p, err) => errors.push(`preload: ${err.message}`));

  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await WAIT(1800);

  const js = (code) => win.webContents.executeJavaScript(code);

  // ───────── 1. 入口按钮存在且能打开面板
  {
    const hasBtn = await js(`!!document.getElementById('btn-sync')`);
    check('侧栏有「跨设备同步」入口', hasBtn);

    await js(`document.getElementById('btn-sync').click()`);
    await WAIT(600);
    const open = await js(`!document.getElementById('sync-mask').hidden`);
    check('点开后弹层可见', open);

    const intro = await js(
      `(document.querySelector('#sync-mask .sync-intro')?.textContent || '').replace(/\\s+/g,'')`
    );
    check('有「不需要服务器」的说明文案', intro.includes('不需要服务器'), intro.slice(0, 40));
  }

  // ───────── 2. 未启动时的初始状态
  {
    const st = await js(`document.getElementById('sync-status').textContent.trim()`);
    check('未启动时状态是「未启动」', st === '未启动', st);

    const startHidden = await js(`document.getElementById('btn-sync-start').hidden`);
    check('「启动服务」按钮可见', startHidden === false);

    const stopHidden = await js(`document.getElementById('btn-sync-stop').hidden`);
    check('「停止服务」按钮初始隐藏', stopHidden === true);

    const localHidden = await js(`document.getElementById('sync-local').hidden`);
    check('本机信息卡初始隐藏', localHidden === true);

    const peersHint = await js(`document.getElementById('sync-peers-hint').textContent.trim()`);
    check('对端提示引导启动服务', peersHint.includes('启动'), peersHint);
  }

  // ───────── 3. 启动服务后本机信息 / 口令 / 二维码可见
  {
    await js(`document.getElementById('btn-sync-start').click()`);
    await WAIT(800);

    const running = await js(`document.getElementById('sync-status').className.includes('ok')`);
    check('启动后状态变绿', running);

    const addr = await js(`document.getElementById('sync-addr').textContent.trim()`);
    check('显示本机地址', addr === '192.168.1.23:47821', addr);

    const token = await js(`document.getElementById('sync-token').textContent.trim()`);
    check('显示配对口令', token === 'abc123def456', token);

    const localVisible = await js(`!document.getElementById('sync-local').hidden`);
    check('本机信息卡展开', localVisible);

    const btnSwapped = await js(
      `document.getElementById('btn-sync-start').hidden && !document.getElementById('btn-sync-stop').hidden`
    );
    check('启动/停止按钮互换', btnSwapped);

    // 假 preload 没给 qrDataUrl，应落到失败兜底而不是抛错
    const qrFallback = await js(`document.getElementById('sync-qr').textContent.trim()`);
    check('二维码缺失时有兜底文案', qrFallback.includes('失败'), qrFallback);

    const calls = await js(`window.api.__calls()`);
    check('启动走的是 sync:start', calls.includes('sync:start'));
  }

  // ───────── 4. 手动填 IP/端口/口令同步
  {
    await js(`
      const h = document.getElementById('sync-host'); h.value = '192.168.1.50';
      h.dispatchEvent(new Event('input', { bubbles: true }));
      const p = document.getElementById('sync-port'); p.value = '51234';
      p.dispatchEvent(new Event('input', { bubbles: true }));
      const s = document.getElementById('sync-pass'); s.value = 'zzz999';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-sync-connect').click();
    `);
    await WAIT(700);

    const calls = await js(`window.api.__calls()`);
    check(
      '手动同步带着三个参数发出',
      calls.some((c) => c === 'sync:now:192.168.1.50:51234:zzz999'),
      calls.filter((c) => c.startsWith('sync:now')).join(',')
    );

    const st = await js(`document.getElementById('sync-status').textContent.trim()`);
    check('同步完成后状态显示成功文案', st.includes('同步完成'), st);
  }

  // ───────── 5. 参数缺失时拦住，不要发请求
  {
    await js(`
      document.getElementById('sync-host').value = '';
      document.getElementById('btn-sync-connect').click();
    `);
    await WAIT(400);
    const st = await js(`document.getElementById('sync-status').textContent.trim()`);
    const kind = await js(`document.getElementById('sync-status').className`);
    check('缺参数时提示且标红', st.includes('都要填') && kind.includes('err'), st + ' | ' + kind);
  }

  // ───────── 6. 文本同步码：导出 / 导入
  {
    await js(`document.getElementById('btn-sync-export').click()`);
    await WAIT(600);
    const code = await js(`document.getElementById('sync-code').value`);
    check('导出后文本框里有同步码', code.length > 5, code.slice(0, 20));

    const calls = await js(`window.api.__calls()`);
    check('导出走的是 sync:exportCode', calls.includes('sync:exportCode'));

    // 改成导入的码，点导入
    await js(`
      const t = document.getElementById('sync-code');
      t.value = 'BMotherFakeCodeFromPeer1234567890';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-sync-import').click();
    `);
    await WAIT(700);
    const calls2 = await js(`window.api.__calls()`);
    check(
      '导入走的是 sync:importCode',
      calls2.some((c) => c.startsWith('sync:importCode:BMotherF')),
      calls2.filter((c) => c.startsWith('sync:importCode')).join(',')
    );
    const st2 = await js(`document.getElementById('sync-status').textContent.trim()`);
    check('导入后显示结果', st2.includes('同步完成'), st2);
  }

  // ───────── 7. 空码导入被拦住
  {
    await js(`
      document.getElementById('sync-code').value = '';
      document.getElementById('btn-sync-import').click();
    `);
    await WAIT(400);
    const st = await js(`document.getElementById('sync-status').textContent.trim()`);
    check('空码时提示先粘贴', st.includes('粘贴'), st);
  }

  // ───────── 8. 关闭与遮罩
  {
    await js(`document.getElementById('btn-sync-close').click()`);
    await WAIT(400);
    const closed = await js(`document.getElementById('sync-mask').hidden`);
    check('关闭按钮能收起面板', closed);

    await js(`document.getElementById('btn-sync').click()`);
    await WAIT(500);
    await js(`
      const m = document.getElementById('sync-mask');
      m.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    `);
    await WAIT(400);
    const closed2 = await js(`document.getElementById('sync-mask').hidden`);
    check('点遮罩空白处能收起面板', closed2);
  }

  // ───────── 9. 停止服务
  {
    await js(`document.getElementById('btn-sync').click()`);
    await WAIT(500);
    await js(`document.getElementById('btn-sync-stop').click()`);
    await WAIT(700);
    const calls = await js(`window.api.__calls()`);
    check('停止走的是 sync:stop', calls.includes('sync:stop'));
    const st = await js(`document.getElementById('sync-status').textContent.trim()`);
    check('停止后状态回到「未启动」', st === '未启动', st);
  }

  // ───────── 10. 面板布局没有溢出
  {
    await js(`document.getElementById('btn-sync').click()`);
    await WAIT(700);
    const audit = await js(`(() => {
      const m = document.getElementById('sync-mask');
      const body = m.querySelector('.sync-body');
      const vw = window.innerWidth, vh = window.innerHeight;
      const issues = [];
      if (!body) return { issues: ['no .sync-body'], vw, vh };
      const r = body.getBoundingClientRect();
      if (r.x < -1 || r.y < -1) issues.push('body offscreen');
      if (r.x + r.width > vw + 1) issues.push('body overflows right');
      if (r.y + r.height > vh + 1) issues.push('body overflows bottom');
      if (r.width <= 0 || r.height <= 0) issues.push('body zero size');
      // 面板内的可交互元素不能被裁掉
      for (const id of ['btn-sync-start','btn-sync-stop','btn-sync-connect','btn-sync-export','btn-sync-import']) {
        const n = document.getElementById(id);
        if (!n) { issues.push('missing #' + id); continue; }
        if (n.hidden) continue;
        const b = n.getBoundingClientRect();
        if (b.width <= 0 || b.height <= 0) issues.push('#' + id + ' zero size');
        if (b.x + b.width > vw + 1) issues.push('#' + id + ' overflows right');
      }
      if (document.documentElement.scrollWidth > vw + 1) issues.push('page horizontal scroll');
      // 滚动容器自己不能横向溢出（内部元素撑破容器时按钮会被挤出可视区）
      if (body.scrollWidth > body.clientWidth + 1) {
        issues.push('body horizontal overflow ' + body.scrollWidth + '>' + body.clientWidth);
      }
      // 按钮必须真的落在滚动容器的可视范围内（不只是落在视口内）
      const br = body.getBoundingClientRect();
      for (const id of ['btn-sync-connect','btn-sync-export','btn-sync-import']) {
        const n = document.getElementById(id);
        if (!n || n.hidden) continue;
        const b = n.getBoundingClientRect();
        if (b.width < 60) issues.push('#' + id + ' squeezed to ' + Math.round(b.width) + 'px');
        if (b.right > br.right + 1) issues.push('#' + id + ' clipped by scroll box');
      }
      return { issues, vw, vh, w: Math.round(r.width), h: Math.round(r.height),
               scrollable: body.scrollHeight > body.clientHeight + 1 };
    })()`);
    log('布局审计:', JSON.stringify(audit));
    check('同步面板无布局问题', audit.issues.length === 0, JSON.stringify(audit.issues));
    fs.writeFileSync(path.join(DATA, 'sync-ui.png'), (await win.webContents.capturePage()).toPNG());
  }

  // ───────── 11. 无渲染层异常
  {
    const real = errors.filter((e) => !/Failed to load resource|net::ERR/i.test(e));
    check('渲染层没有报错', real.length === 0, real.slice(0, 3).join(' | '));
  }

  const failed = results.filter((r) => !r.ok);
  log('');
  log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) for (const f of failed) log('  FAIL ' + f.name + (f.detail ? '  — ' + f.detail : ''));

  win.destroy();
  app.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  log('FATAL', e);
  try {
    app.exit(1);
  } catch {
    process.exit(1);
  }
});
