@echo off
title Stratacore - Stop
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\stop-stratacore.ps1
pause
