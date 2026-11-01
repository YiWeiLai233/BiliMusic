// 在 Electron 渲染进程里实测：走本地代理的纯音频 DASH 能否播放、拖动、读出时长
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', '.userdata');
fs.mkdirSync(DATA, { recursive: true });
const LOG = path.join(DATA, 'audio-test.log');
fs.writeFileSync(LOG, '');
const log = (...a) => {
  const line = a.map((x) => (x instanceof Error ? x.stack : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
  fs.appendFileSync(LOG, line + '\n');
};

app.setPath('userData', DATA);
app.setPath('sessionData', path.join(DATA, 'session'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const { Bili } = require('../src/bili');
const { AudioProxy } = require('../src/audioProxy');

async function main() {
  const bili = new Bili(DATA);
  const proxy = new AudioProxy(bili);
  const port = await proxy.start();
  log('proxy port', port);

  const BV = 'BV1GJ411x7h7';
  const meta = await bili.videoInfo(BV, { force: true });
  const streams = await bili.audioStreams(BV, meta.cid);
  const chosen = streams[0];
  const url = proxy.audioUrl(BV, meta.cid, chosen.id);
  log('stream', chosen.id, chosen.label, 'url', url);

  await app.whenReady();

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  await win.loadURL('data:text/html,<html><body><audio id="a"></audio></body></html>');

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const a = document.getElementById('a');
      const events = [];
      const rec = (n) => a.addEventListener(n, () => events.push(n));
      ['loadstart','loadedmetadata','canplay','canplaythrough','play','playing','pause','seeked','ended','error','stalled','waiting'].forEach(rec);
      a.src = ${JSON.stringify(url)};
      a.volume = 0.001;
      const snap = (tag) => ({ tag, rs: a.readyState, dur: a.duration, ct: a.currentTime, err: a.error && a.error.code, net: a.networkState });
      const out = [];
      try { await a.play(); out.push(snap('play-called')); } catch (e) { out.push({ tag: 'play-rejected', msg: e.message }); }

      // 等第一次 timeupdate
      await new Promise((res) => {
        const t = setTimeout(res, 8000);
        a.addEventListener('timeupdate', function h() {
          if (a.currentTime > 0.3) { a.removeEventListener('timeupdate', h); clearTimeout(t); res(); }
        });
      });
      out.push(snap('after-progress'));
      const t1 = a.currentTime;

      // 拖动到 150 秒
      a.currentTime = 150;
      await new Promise((res) => {
        const t = setTimeout(res, 8000);
        a.addEventListener('seeked', function h() { a.removeEventListener('seeked', h); clearTimeout(t); res(); }, { once: true });
      });
      out.push(snap('after-seek-150'));

      // 再播 1.2 秒确认 seek 后能继续推进
      await new Promise((r) => setTimeout(r, 1200));
      out.push(snap('after-seek-play'));

      const info = {
        duration: a.duration,
        firstProgress: t1,
        events: [...new Set(events)],
        steps: out,
        currentSrc: a.currentSrc.slice(0, 60),
      };
      a.pause();
      return info;
    })()
  `);

  log('RESULT', result);

  const ok =
    Number.isFinite(result.duration) &&
    result.duration > 100 &&
    result.firstProgress > 0.2 &&
    result.steps.some((s) => s.tag === 'after-seek-150' && Math.abs(s.ct - 150) < 3 &&
      s.steps === undefined) &&
    !result.events.includes('error');
  log('PLAYBACK_OK:', ok);

  proxy.stop();
  app.exit(ok ? 0 : 3);
}

main().catch(async (e) => {
  log('FATAL', e);
  try { app.exit(1); } catch { process.exit(1); }
});
