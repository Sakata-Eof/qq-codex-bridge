param([switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Stop.ps1')
& (Join-Path $PSScriptRoot 'Start.ps1') -NoBrowser:(-not $OpenBrowser)
Write-Host 'Service and watchdog restarted.'
