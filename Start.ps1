param([switch]$History, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
. (Join-Path $bridgeRoot 'scripts\ops\WindowsLifecycle.ps1')
$autostart = Get-BridgeTask $bridgeRoot
if ($autostart -and [string]$autostart.State -eq 'Disabled') { throw 'Autostart is disabled. Run Install.ps1 to enable it again.' }
Resolve-BridgeNode $bridgeRoot -Persist | Out-Null
$stopFlag = Join-Path $bridgeRoot 'runtime\stop.flag'
if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag }
Start-BridgeWatchdog $bridgeRoot $autostart
$ready = $false
for ($i=0; $i -lt 90; $i++) {
    if ((Get-BridgeProcess $bridgeRoot service) -and (Get-BridgeProcess $bridgeRoot watchdog) -and
        (Test-Path -LiteralPath (Join-Path $bridgeRoot 'runtime\setup-url.txt')) -and (Test-BridgeHealth)) { $ready = $true; break }
    # A previous scheduled launcher can still be exiting after a safe stop.
    if ($autostart -and $i % 4 -eq 3) { Start-BridgeWatchdog $bridgeRoot $autostart }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw 'Service or watchdog is not ready. Check Status.ps1 and runtime\launcher.log / service.log.' }
$setupUrl = Get-Content -LiteralPath (Join-Path $bridgeRoot 'runtime\setup-url.txt')
if ($History) { $setupUrl = $setupUrl -replace '/#', '/history#' }
if (-not $NoBrowser) { Start-Process $setupUrl }
