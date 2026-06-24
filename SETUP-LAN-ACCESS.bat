@echo off
title Stratacore - Universal LAN access
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\setup-lan-access.ps1
