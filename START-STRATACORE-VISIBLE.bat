@echo off
title Stratacore - Start (visible windows)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\start-stratacore.ps1 -ShowWindows
pause
