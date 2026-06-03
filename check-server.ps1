try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8789/' -TimeoutSec 3 -UseBasicParsing
  Write-Host "Server alive: HTTP $($r.StatusCode)"
} catch {
  Write-Host "Server NOT responding: $($_.Exception.Message)"
}

$conn = Get-NetTCPConnection -LocalPort 8789 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  Write-Host "Port 8789 listening, PID: $($conn.OwningProcess)"
} else {
  Write-Host "Port 8789 NOT listening"
}
