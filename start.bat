@echo off
setlocal
cd /d "%~dp0"
rem Launch via scripts\launch.js, which copies the Electron runtime outside
rem the repo before starting (Windows tray icon fails to register when the
rem exe lives under this project dir on this machine).
node scripts\launch.js %*
