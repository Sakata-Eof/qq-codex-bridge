$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$runtime = Join-Path $bridgeRoot 'runtime'
$nodePath = 'C:\nvm4w\nodejs\node.exe'
$stopFlag = Join-Path $runtime 'stop.flag'
$mutex = [Threading.Mutex]::new($false, 'Local\QQCodexBridgeWatchdog-102044715')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
    while (-not (Test-Path -LiteralPath $stopFlag)) {
        $existing = $null
        $pidFile = Join-Path $runtime 'pid.txt'
        if (Test-Path -LiteralPath $pidFile) {
            $bridgePid = [int](Get-Content -LiteralPath $pidFile)
            $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgePid" -ErrorAction SilentlyContinue
            if ($candidate -and $candidate.Name -eq 'node.exe' -and $candidate.CommandLine.Contains((Join-Path $bridgeRoot 'server.mjs'))) { $existing = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue }
        }
        if ($existing) { $child = $existing } else {
            # The GUI launcher has no console; do not allocate one for Node either.
            $child = Start-Process -FilePath $nodePath -ArgumentList ('"' + (Join-Path $bridgeRoot 'server.mjs') + '"') -WorkingDirectory $bridgeRoot -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $runtime 'stdout.log') -RedirectStandardError (Join-Path $runtime 'stderr.log')
        }
        [IO.File]::WriteAllText((Join-Path $runtime 'watchdog.pid'), [string]$PID)
        $failures = 0
        while (-not $child.HasExited -and -not (Test-Path -LiteralPath $stopFlag)) {
            Start-Sleep -Seconds 15
            $child.Refresh()
            if ($child.HasExited) { break }
            try { Invoke-WebRequest -Uri 'http://127.0.0.1:17329/health' -UseBasicParsing -TimeoutSec 5 | Out-Null; $failures = 0 } catch { $failures++ }
            if ($failures -ge 4) {
                # Only terminate the exact bridge process already verified or created by this watchdog.
                $check = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Id)" -ErrorAction SilentlyContinue
                if ($check -and $check.Name -eq 'node.exe' -and $check.CommandLine.Contains((Join-Path $bridgeRoot 'server.mjs'))) { $child.Kill(); $child.WaitForExit(5000) | Out-Null }
                break
            }
        }
        if (-not (Test-Path -LiteralPath $stopFlag)) { Start-Sleep -Seconds 5 }
    }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
