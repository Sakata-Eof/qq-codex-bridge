$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot 'runtime'
[IO.File]::WriteAllText((Join-Path $runtime 'stop.flag'), 'stop')
$config = Get-Content -LiteralPath (Join-Path $runtime 'config.json') -Raw | ConvertFrom-Json
try { Invoke-RestMethod 'http://127.0.0.1:17329/api/shutdown' -Method Post -Headers @{ Authorization = 'Bearer ' + $config.adminToken } -ContentType 'application/json' -Body '{}' | Out-Null } catch {
    if ($_.Exception.Response) { Remove-Item -LiteralPath (Join-Path $runtime 'stop.flag'); Start-ScheduledTask -TaskName 'QQ-Codex-Bridge'; Write-Host '服务拒绝停机，守护仍启用。请先在 QQ 发送 /stop，再运行本脚本。' }
}
