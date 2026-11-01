@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
node_modules\electron\dist\electron.exe scripts\test-ui.js --no-sandbox --disable-gpu --disable-crash-reporter > .userdata\ui-stdout.log 2>&1
echo EXITCODE=%ERRORLEVEL% >> .userdata\ui-stdout.log
