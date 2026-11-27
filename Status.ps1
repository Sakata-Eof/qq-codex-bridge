$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
. (Join-Path $bridgeRoot 'scripts\ops\WindowsLifecycle.ps1')
$task = Get-BridgeTask $bridgeRoot
$service = Get-BridgeProcess $bridgeRoot service
$watchdog = Get-BridgeProcess $bridgeRoot watchdog
$nodePath = $null
$hostFile = Join-Path $bridgeRoot 'runtime\windows-host.json'
if (Test-Path -LiteralPath $hostFile) { $nodePath = (Get-Content -LiteralPath $hostFile -Raw | ConvertFrom-Json).nodePath }
$healthy = [bool]($service -and (Test-BridgeHealth))
$environmentStatus = $null
if ($healthy) {
    try {
        $bridgeConfig = Get-Content -LiteralPath (Join-Path $bridgeRoot 'runtime\config.json') -Raw | ConvertFrom-Json
        $environmentStatus = Invoke-RestMethod ((Get-BridgeBaseUrl) + '/api/environment') -Headers @{Authorization=('Bearer ' + $bridgeConfig.adminToken)} -TimeoutSec 3
    } catch { }
}
[pscustomobject]@{
    ServicePid = $(if ($service) { $service.ProcessId } else { $null })
    Healthy = $healthy
    WatchdogPid = $(if ($watchdog) { $watchdog.ProcessId } else { $null })
    Autostart = $(if ($task) { [string]$task.State } else { 'NotInstalled' })
    RecoveryPaused = Test-Path -LiteralPath (Join-Path $bridgeRoot 'runtime\stop.flag')
    NodePath = $nodePath
    CoreToolsReady = $(if ($environmentStatus) { $environmentStatus.coreReady } else { $null })
    MediaToolsReady = $(if ($environmentStatus) { $environmentStatus.mediaReady } else { $null })
}
