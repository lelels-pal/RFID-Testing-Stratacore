@echo off
title Stratacore - Logs
cd /d "%~dp0"
if not exist deploy\logs mkdir deploy\logs
explorer deploy\logs
