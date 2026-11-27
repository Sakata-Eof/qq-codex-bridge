$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
. (Join-Path $bridgeRoot 'scripts\ops\WindowsLifecycle.ps1')
$autostart = Get-BridgeTask $bridgeRoot
$runtime = Join-Path $bridgeRoot 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$stopFlag = Join-Path $runtime 'stop.flag'
$wasStopped = Test-Path -LiteralPath $stopFlag
$service = Get-BridgeProcess $bridgeRoot service -RejectUnverified
if (-not $service -and (Test-BridgeHealth)) { throw 'A listener is running but its bridge PID could not be verified. Safe shutdown was not attempted; inspect Status.ps1 and runtime\pid.txt.' }
[IO.File]::WriteAllText($stopFlag, 'stop')
try {
    # Quiesce the watchdog first, including any spawn already in progress.
    Wait-BridgeStopped $bridgeRoot -WatchdogOnly
    $service = Get-BridgeProcess $bridgeRoot service -RejectUnverified
    if ($service) {
        $config = Get-Content -LiteralPath (Join-Path $runtime 'config.json') -Raw | ConvertFrom-Json
        if (-not $config.adminToken) { throw 'The local admin token is missing; safe shutdown was not attempted.' }
        $reply = Invoke-RestMethod ((Get-BridgeBaseUrl) + '/api/shutdown') -Method Post -Headers @{Authorization=('Bearer ' + $config.adminToken)} -ContentType 'application/json' -Body '{}' -TimeoutSec 8
        if ($reply.ok -ne $true) { throw 'Shutdown was not confirmed by the service.' }
    }
    Wait-BridgeStopped $bridgeRoot
} catch {
    $shutdownError = $_.Exception.Message
    if (-not $wasStopped) {
        Remove-Item -LiteralPath $stopFlag -ErrorAction SilentlyContinue
        try { Start-BridgeWatchdog $bridgeRoot $autostart } catch { Write-Warning $_.Exception.Message }
    }
    throw "Safe shutdown failed or was not confirmed: $shutdownError No processes were force-killed; check running tasks before retrying."
}
Write-Host 'Service and watchdog stopped. Automatic recovery is paused until Start.ps1 or Install.ps1.'
