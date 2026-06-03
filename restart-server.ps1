# Kill existing server
Get-NetTCPConnection -LocalPort 8789 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# Start server
Start-Process -WindowStyle Hidden -FilePath node -ArgumentList 'server.mjs' -WorkingDirectory 'C:\tmp\vibeboard-linux-prototype'
Start-Sleep -Seconds 2

# Verify
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8789/' -TimeoutSec 3 -UseBasicParsing
  Write-Host "Server started: HTTP $($r.StatusCode)"
} catch {
  Write-Host "Server failed to start: $($_.Exception.Message)"
}
