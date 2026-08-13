@echo off
chcp 65001 >nul
title AR Hands Filter
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-LocalServer.ps1"
pause
