# VibeBoard 一键启动脚本
# 双击运行即可启动后端服务器

Write-Host "================================" -ForegroundColor Cyan
Write-Host "  VibeBoard 启动中..." -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# 切换到项目目录
Set-Location "C:\tmp\vibeboard-linux-prototype"

# 检查端口 8789 是否已被占用
$existing = Get-NetTCPConnection -LocalPort 8789 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[INFO] 端口 8789 已有服务在运行" -ForegroundColor Yellow
    Write-Host "[INFO] PID: $($existing.OwningProcess)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "是否要重启服务？(Y/N)" -ForegroundColor Yellow
    $confirm = Read-Host
    if ($confirm -eq "Y" -or $confirm -eq "y") {
        Write-Host "正在停止旧服务..." -ForegroundColor Gray
        Stop-Process -Id $existing.OwningProcess -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    } else {
        Write-Host "保持现有服务运行" -ForegroundColor Green
        Write-Host "访问地址: http://127.0.0.1:8789" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "按任意键退出..." -ForegroundColor Gray
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        exit
    }
}

# 启动服务器
Write-Host "[INFO] 启动 Node.js 服务器..." -ForegroundColor Green
Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "server.mjs" -WorkingDirectory "C:\tmp\vibeboard-linux-prototype"

# 等待服务器启动
Write-Host "[INFO] 等待服务器就绪..." -ForegroundColor Gray
Start-Sleep -Seconds 2

# 验证服务器是否启动成功
$maxRetries = 5
$retryCount = 0
$serverReady = $false

while ($retryCount -lt $maxRetries -and -not $serverReady) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:8789/" -TimeoutSec 2 -UseBasicParsing
        if ($response.StatusCode -eq 200) {
            $serverReady = $true
        }
    } catch {
        $retryCount++
        Start-Sleep -Seconds 1
    }
}

Write-Host ""
if ($serverReady) {
    Write-Host "================================" -ForegroundColor Green
    Write-Host "  VibeBoard 启动成功!" -ForegroundColor Green
    Write-Host "================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  访问地址: http://127.0.0.1:8789" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  应用市场: http://127.0.0.1:8789/market.html" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  提示: 服务器在后台运行，关闭此窗口不影响服务" -ForegroundColor Gray
} else {
    Write-Host "================================" -ForegroundColor Red
    Write-Host "  启动失败!" -ForegroundColor Red
    Write-Host "================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "  请检查 Node.js 是否安装" -ForegroundColor Yellow
    Write-Host "  或手动运行: node server.mjs" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "按任意键退出..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
