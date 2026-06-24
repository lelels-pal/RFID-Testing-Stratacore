@echo off
title Stratacore - Start
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\start-stratacore.ps1
pause
