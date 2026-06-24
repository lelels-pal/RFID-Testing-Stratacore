@echo off
title Stratacore - Stop dnsmasq
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\stop-dnsmasq.ps1
pause
