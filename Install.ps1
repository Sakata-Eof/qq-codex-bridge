param([string]$NodePath, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
. (Join-Path $bridgeRoot 'scripts\ops\WindowsLifecycle.ps1')
Assert-BridgeScheduledPort
Get-BridgeTask $bridgeRoot | Out-Null
$nodePath = Resolve-BridgeNode $bridgeRoot -NodePath $NodePath -Persist
$package = Get-Content -LiteralPath (Join-Path $bridgeRoot 'package.json') -Raw | ConvertFrom-Json
foreach ($dependency in $package.dependencies.PSObject.Properties.Name) {
    if (-not (Test-Path -LiteralPath (Join-Path $bridgeRoot ('node_modules\' + $dependency + '\package.json')))) { throw 'Dependencies are missing. Run npm ci in this directory, then run Install.ps1 again.' }
}
& (Join-Path $bridgeRoot 'scripts\ops\Build-WindowsLauncher.ps1') | Out-Null
if ((Get-BridgeProcess $bridgeRoot service -RejectUnverified) -or (Get-BridgeProcess $bridgeRoot watchdog -RejectUnverified)) { & (Join-Path $bridgeRoot 'Stop.ps1') }
& (Join-Path $bridgeRoot 'Install-Autostart.ps1') -NodePath $nodePath -NoStart
& (Join-Path $bridgeRoot 'Install-Launchers.ps1')
& (Join-Path $bridgeRoot 'Start.ps1') -NoBrowser:$NoBrowser
Write-Host 'Installed current-user logon startup, automatic recovery, and Start menu shortcuts.'
