@echo off
chcp 65001 >nul
cd /d "%~dp0outputs\edge-gym-booker" || goto :end
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" 2>nul
if errorlevel 1 (
  echo 请安装 Node.js 的 Windows LTS 版本，使用默认选项。安装后关闭本窗口，再双击开始设置。
  start "" https://nodejs.org/en/download
  goto :end
)
node setup.mjs
:end
pause
