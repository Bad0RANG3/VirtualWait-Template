@echo off
chcp 65001 >nul
cd /d %~dp0
echo [VirtualWait Bot] 启动 NoneBot2（Ctrl+C 停止）...
.venv\Scripts\python.exe bot.py
pause
