@echo off
:: Double-click this file — it will ask for Administrator approval (UAC), then run setup.
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','''%~dp0setup-stratacore.ps1''')"
echo.
echo If UAC appeared, click Yes. Setup runs in the elevated window.
pause
