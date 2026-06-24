@echo off
title Stratacore - Verify LAN access
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\verify-lan-access.ps1
pause
