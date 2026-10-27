param([switch]$History, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$stopFlag = Join-Path $bridgeRoot 'runtime\stop.flag'
if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag }
$autostart = Get-ScheduledTask -TaskName 'QQ-Codex-Bridge' -ErrorAction SilentlyContinue
if ($autostart) { Start-ScheduledTask -TaskName 'QQ-Codex-Bridge' }
$pidFile = Join-Path $bridgeRoot 'runtime\pid.txt'
$running = $null
if (Test-Path -LiteralPath $pidFile) {
    $bridgePid = [int](Get-Content -LiteralPath $pidFile)
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid" -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.CommandLine -and $candidate.CommandLine.Contains((Join-Path $bridgeRoot 'server.mjs'))) { $running = $candidate }
}
if (-not $running -and -not $autostart) {
    $launcherPath = & (Join-Path $bridgeRoot 'scripts\ops\Build-WindowsLauncher.ps1')
    Start-Process -FilePath $launcherPath -ArgumentList 'watchdog' -WorkingDirectory $bridgeRoot -WindowStyle Hidden
    $ready = $false
    for ($i=0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 300
        if (Test-Path -LiteralPath (Join-Path $bridgeRoot 'runtime\setup-url.txt')) {
            try { Invoke-WebRequest -Uri 'http://127.0.0.1:17329/' -TimeoutSec 1 | Out-Null; $ready = $true; break } catch {}
        }
    }
    if (-not $ready) { throw '服务未就绪，请查看 runtime\service.log。' }
}
if (-not $running -and $autostart) {
    $ready = $false
    for ($i=0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 1
        try { Invoke-WebRequest -Uri 'http://127.0.0.1:17329/health' -TimeoutSec 1 | Out-Null; $ready = $true; break } catch {}
    }
    if (-not $ready) { throw '守护进程未能启动服务，请查看 runtime\service.log。' }
}
$setupUrl = Get-Content -LiteralPath (Join-Path $bridgeRoot 'runtime\setup-url.txt')
if ($History) { $setupUrl = $setupUrl -replace '/#', '/history#' }
if (-not $NoBrowser) { Start-Process $setupUrl }
