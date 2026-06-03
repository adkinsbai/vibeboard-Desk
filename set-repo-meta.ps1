$repo = 'adkinsbai/vibeboard-Desk'
$headers = @{Accept = 'application/vnd.github.v3+json'}

$body = @{
  description = 'AI-powered hardware app generation — describe your app in natural language, deploy to Taishan RK3566 in 30 seconds'
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://api.github.com/repos/$repo" -Method Patch -Headers $headers -Body $body -ContentType 'application/json' | Select-Object full_name, description

$topics = @{names = @('ai', 'hardware', 'embedded', 'rk3566', 'taishan', 'code-generation', 'llm', 'kiosk', 'iot', 'nodejs')} | ConvertTo-Json
Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/topics" -Method Put -Headers $headers -Body $topics -ContentType 'application/json'
Write-Host "Topics set"
