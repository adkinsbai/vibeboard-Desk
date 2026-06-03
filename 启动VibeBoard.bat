@echo off
chcp 65001 >nul
title VibeBoard 启动器

echo ================================
echo   VibeBoard 启动中...
echo ================================
echo.

cd /d C:\tmp\vibeboard-linux-prototype

:: 检查端口是否已被占用
netstat -ano | findstr :8789 | findstr LISTENING >nul
if %errorlevel%==0 (
    echo [INFO] 端口 8789 已有服务在运行
    echo.
    echo 访问地址: http://127.0.0.1:8789
    echo.
    pause
    exit /b
)

:: 启动服务器
echo [INFO] 启动服务器...
start /min node server.mjs

:: 等待启动
timeout /t 2 /nobreak >nul

:: 验证启动
curl -s -o nul -w "%%{http_code}" http://127.0.0.1:8789/ >nul 2>&1
if %errorlevel%==0 (
    echo.
    echo ================================
    echo   VibeBoard 启动成功!
    echo ================================
    echo.
    echo   正在打开浏览器...
    
    :: 自动打开浏览器
    start http://127.0.0.1:8789
    
    echo.
    echo   服务器在后台运行，关闭此窗口不影响服务
) else (
    echo.
    echo [ERROR] 启动失败，请检查 Node.js 是否安装
)

echo.
pause
