@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist node_modules\electron\dist\electron.exe (
  echo Run npm install and npm run build first.
  pause
  exit /b 1
)
if not exist dist\index.html (
  echo Run npm run build first.
  pause
  exit /b 1
)
start "Winmux" node_modules\electron\dist\electron.exe .
