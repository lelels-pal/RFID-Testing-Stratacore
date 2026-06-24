@echo off
title Stratacore - Setup dnsmasq (LAN DNS)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\setup-dnsmasq.ps1
