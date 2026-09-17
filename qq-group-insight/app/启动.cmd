@echo off
rem Local console launcher. Keep this file ASCII-only:
rem cmd.exe reads .cmd files as ANSI/GBK, so non-ASCII text would break parsing.
setlocal
chcp 65001 >nul
title Chat Summary Console
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

node "server\main.mjs"
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" echo [launcher] node exited with code %EXITCODE%
echo [launcher] console stopped. Press any key to close this window.
pause >nul
exit /b %EXITCODE%

:NONODE
echo [launcher] Node.js not found in PATH.
echo [launcher] Install Node.js 20+ from https://nodejs.org and run this file again.
echo.
pause >nul
exit /b 1
