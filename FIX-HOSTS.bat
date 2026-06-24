@echo off
:: Double-click — requests Admin via UAC, then updates hosts file
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\update-hosts.ps1
