$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\ops\WindowsLifecycle.ps1')
$task = Get-BridgeTask $PSScriptRoot
& (Join-Path $PSScriptRoot 'Stop.ps1')
if ($task) { Unregister-ScheduledTask -TaskName 'QQ-Codex-Bridge' -Confirm:$false }
Write-Host 'Autostart removed. Runtime data and Start menu shortcuts were kept. Run Start.ps1 for manual startup.'
