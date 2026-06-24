@echo off
:: Opens Windows Firewall for phones/chargers on LAN (HTTPS 443, OCPP 9000)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\open-lan-firewall.ps1
