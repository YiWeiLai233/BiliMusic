# Bili Music v0.1.0

Turn your Bilibili favorites into a desktop music player. Scan to sign in, pick a favorites folder, hit play — no downloading, no transcoding, no video. Minimize to the tray and it keeps going.

**[Download BiliMusic-Setup-0.1.0.exe](./BiliMusic-Setup-0.1.0.exe) (103 MB, Windows x64)**

---

## What it does

**Library**

- Sign in with Bilibili's own QR code. Cookies are written to a local file only — nothing leaves your machine.
- Every favorites folder is listed automatically. Non-music entries are filtered out by section, and you can override that per track with a three-state ♪ toggle (manual music / manual non-music / back to auto).
- Multi-part videos are split into individual tracks. Each part gets its own row, its own play state, its own favorite mark.
- **Liked Songs** aggregates local files, imported links, and favorites folders into one list. Favorites folders can be *followed* (kept in sync on every visit) or imported once. Removing a track hides it permanently instead of letting the next sync resurrect it.

**Playing**

- Pure audio. Only the DASH audio track is requested — the video stream is never touched. A local Range proxy streams it straight to Chromium, so seeking works and nothing is written to disk.
- Three quality tiers: 64K / 132K / 192K. The bitrate that's actually playing is shown in the player bar.
- Shuffle, repeat-one, list-loop. Playback survives list rebuilds — filtering or switching folders won't desync what's playing.

**Local files**

- Point it at folders and it scans recursively, reading ID3 tags for title, artist, album, cover, and duration. Files are referenced in place, never copied.
- Supports mp3, flac, m4a, aac, ogg, opus, wav, wma, ape, aiff, and others.
- Missing files are marked in the list instead of silently disappearing.

**Playlists**

- Create, rename, delete, reorder by drag, and add tracks via right-click.
- Export to JSON and import back, with deduplication on merge.

**Background**

- Minimize to tray and keep playing.
- Global media keys, plus the Windows media overlay.
- Launch at login (optional).
- Close behavior is a setting: ask every time / minimize to tray / quit. The ask dialog has a "remember my choice" checkbox.

---

## Install

1. Run `BiliMusic-Setup-0.1.0.exe`.
2. **Windows will warn you first.** The installer is not code-signed, so SmartScreen shows "Windows protected your PC". Click **More info → Run anyway**. Signing certificates cost money annually; this is a personal project.
3. The installer requests administrator rights because it writes to `Program Files` by default. If you'd rather not elevate, that's what the admin prompt is for — cancel it and use the portable option below.
4. Launch from the Start menu or desktop shortcut.

The installer is per-machine, so by default it installs to `Program Files`. You can change the target directory during setup.

---

## Requires

- Windows 10 or 11, x64
- A Bilibili account (for reading your own favorites)
- Internet connection (audio is streamed, not cached)

---

## Known limitations

- **No offline caching.** Playback is streamed; there's no download-for-offline feature. That was explicitly deferred.
- **Audio URLs expire after ~2 hours.** The proxy re-resolves the stream when it notices, so a long session recovers on the next track change rather than mid-song.
- **Windows only.** Nothing here is conceptually Windows-specific, but it has never been built or tested on macOS or Linux.
- **No code signing.** See the install notes above.
- **Not a downloader.** There is no bulk export, no "download all", nothing that would amplify Bilibili's rate limiting. Request pacing is deliberately conservative.
- **Single account, no sync.** This is a personal tool. There's no cloud, no multi-device sync, no sharing.

---

## A note on the tray icon

On this build machine, `electron.exe` fails to register a Windows tray icon whenever it lives under the project directory tree — every other path works, including a directory with the same name elsewhere. ACLs, ownership, volume type, file contents, and process tokens were all ruled out.

Rather than ship with a broken tray, `npm start` copies the Electron runtime to `%LOCALAPPDATA%\BiliMusicRuntime` and launches from there. The packaged build is unaffected and starts normally. This is documented in the README as a known issue, not as something that was fixed.

---

## Testing

Around 2,600 lines across ten scripts, all runnable with `node scripts/test-*.js`:

| Script | Covers |
|---|---|
| `test-ui.js` | Full UI flow against mock IPC, 20 scenario groups |
| `test-preload.js` | Complete IPC surface stub for the renderer |
| `test-library.js` | 37 assertions on library and playlist behavior |
| `test-loved.js` | Real-account Liked Songs merge and exclusion table |
| `test-layout.js` | Layout audit at three window sizes |
| `test-multipage.js` | Real-API multi-part splitting |
| `test-part-audio.js` | Audio availability for every part of a multi-part video |
| `test-playback.js`, `test-e2e.js`, `test-hidden.js` | Playback, end-to-end, and hide-list behavior |

---

## Built with

Electron 43.3.0 · Node.js · no frontend framework
