@echo off
title Stratacore - Full Restart (apps + Docker DNS)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\restart-stratacore.ps1
