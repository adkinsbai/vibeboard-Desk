@echo off
title VibeBoard Launcher

cd /d C:\tmp\vibeboard-linux-prototype

echo ================================
echo   VibeBoard
echo ================================
echo.

:: Check if server is already running
netstat -ano | findstr :8789 | findstr LISTENING >nul 2>&1
if %errorlevel%==0 (
    echo Server is already running.
    echo Opening browser...
    start http://127.0.0.1:8789
    exit
)

:: Start server
echo Starting server...
start /b node server.mjs

:: Wait for server to start
echo Waiting for server...
timeout /t 3 /nobreak >nul

:: Open browser
echo Opening browser...
start http://127.0.0.1:8789

echo.
echo Server running in background.
echo You can close this window.
echo.
pause
