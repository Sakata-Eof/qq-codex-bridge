$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
. (Join-Path $bridgeRoot 'scripts\ops\WindowsLifecycle.ps1')
$runtime = Join-Path $bridgeRoot 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$stopFlag = Join-Path $runtime 'stop.flag'
$watchdogLog = Join-Path $runtime 'watchdog.log'
$stderrLog = Join-Path $runtime 'stderr.log'
$watchdogRun = [guid]::NewGuid().ToString('N')

function Write-WatchdogEvent {
    param([string]$Event, [hashtable]$Details = @{})
    try {
        if ((Test-Path -LiteralPath $watchdogLog) -and (Get-Item -LiteralPath $watchdogLog).Length -ge 1MB) {
            Move-Item -LiteralPath $watchdogLog -Destination ($watchdogLog + '.1') -Force
        }
        $record = @{time=[DateTime]::UtcNow.ToString('o'); event=$Event; watchdogRun=$watchdogRun; watchdogPid=$PID}
        foreach ($key in $Details.Keys) { $record[$key] = $Details[$key] }
        [IO.File]::AppendAllText($watchdogLog, (($record | ConvertTo-Json -Compress) + [Environment]::NewLine))
    } catch { [Console]::Error.WriteLine('Watchdog diagnostics log could not be written.') }
}

function Get-StderrSummary {
    try {
        if (-not (Test-Path -LiteralPath $stderrLog)) { return @{status='missing'} }
        $stream = [IO.File]::Open($stderrLog, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            $length = $stream.Length
            $sample = [byte[]]::new([int][Math]::Min($length, 16384))
            $null = $stream.Seek(-$sample.Length, [IO.SeekOrigin]::End)
            $sampleLength = $stream.Read($sample, 0, $sample.Length)
        } finally { $stream.Dispose() }
        $tail = [Text.Encoding]::UTF8.GetString($sample, 0, $sampleLength)
        $categories = @(
            if ($tail -match '\bEADDRINUSE\b') { 'port_in_use' }
            if ($tail -match '\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b') { 'module_missing' }
            if ($tail -match 'FATAL ERROR:.*(?:heap|allocation|out of memory)') { 'node_out_of_memory' }
            if ($tail -match '\bENOSPC\b') { 'disk_full' }
            if ($tail -match '\b(?:EACCES|EPERM)\b') { 'access_denied' }
            if ($tail -match '\b(?:ERR_SQLITE_ERROR|SQLITE_[A-Z_]+)\b') { 'sqlite_error' }
            if ($tail -match '(?m)^(?:SyntaxError|TypeError|ReferenceError|RangeError):') { 'javascript_error' }
        )
        return @{status='sampled'; bytes=$length; sampledBytes=$sampleLength; categories=$categories}
    } catch { return @{status='unreadable'} }
}

$hasher = [Security.Cryptography.SHA256]::Create()
try { $rootHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($bridgeRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 24) } finally { $hasher.Dispose() }
$mutex = [Threading.Mutex]::new($false, ('Local\QQCodexBridgeWatchdog-' + $rootHash))
$ownsMutex = $false
try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
if (-not $ownsMutex) { $mutex.Dispose(); exit 0 }
$phase = 'watchdog_start'
$restartAfterPid = $null
$stopReason = 'stop_flag'
try {
    [IO.File]::WriteAllText((Join-Path $runtime 'watchdog.pid'), [string]$PID)
    Write-WatchdogEvent 'watchdog_started'
    while (-not (Test-Path -LiteralPath $stopFlag)) {
        $phase = 'find_service'
        $existing = Get-BridgeProcess $bridgeRoot service
        if ($existing) {
            $child = Get-Process -Id $existing.ProcessId -ErrorAction Stop
            Write-WatchdogEvent 'service_adopted' @{servicePid=$child.Id}
        } else {
            $phase = 'resolve_node'
            $nodePath = Resolve-BridgeNode $bridgeRoot
            $env:Path = Get-BridgeRuntimePath -NodePath $nodePath
            if (Test-Path -LiteralPath $stopFlag) { break }
            $phase = 'spawn_service'
            # The GUI launcher has no console; do not allocate one for Node either.
            $child = Start-Process -FilePath $nodePath -ArgumentList ('"' + (Join-Path $bridgeRoot 'server.mjs') + '"') -WorkingDirectory $bridgeRoot -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $runtime 'stdout.log') -RedirectStandardError $stderrLog
            $phase = 'write_service_pid'
            [IO.File]::WriteAllText((Join-Path $runtime 'pid.txt'), [string]$child.Id)
            Write-WatchdogEvent 'service_started' @{servicePid=$child.Id; restartAfterPid=$restartAfterPid}
        }
        $restartAfterPid = $null
        $phase = 'monitor_service'
        $observed = [Diagnostics.Stopwatch]::StartNew()
        try { $null = $child.Handle } catch { } # Keep an exit status handle for an adopted process.

        $wasHealthy = $false
        $failures = 0
        $exitReason = 'process_exit'
        $nextHealthCheck = [DateTime]::UtcNow.AddSeconds(15)
        while (-not $child.HasExited -and -not (Test-Path -LiteralPath $stopFlag)) {
            Start-Sleep -Seconds 1
            $child.Refresh()
            if ($child.HasExited) { break }
            if ([DateTime]::UtcNow -lt $nextHealthCheck) { continue }

            if (Test-BridgeHealth) {
                if (-not $wasHealthy -or $failures) {
                    Write-WatchdogEvent 'service_healthy' @{servicePid=$child.Id; previousHealthFailures=$failures; observedMs=$observed.ElapsedMilliseconds}
                }
                $wasHealthy = $true
                $failures = 0
            } else { $failures++ }
            $nextHealthCheck = [DateTime]::UtcNow.AddSeconds(15)
            if ($failures -ge 4 -and -not (Test-Path -LiteralPath $stopFlag)) {
                # Only terminate the exact bridge process already verified or created by this watchdog.
                $check = Get-BridgeProcess $bridgeRoot service
                if ($check -and $check.ProcessId -eq $child.Id) {
                    Write-WatchdogEvent 'service_health_timeout' @{servicePid=$child.Id; consecutiveFailures=$failures; observedMs=$observed.ElapsedMilliseconds}
                    $phase = 'terminate_unhealthy_service'
                    $exitReason = 'health_timeout'
                    $child.Kill()
                    if (-not $child.WaitForExit(5000)) { Write-WatchdogEvent 'service_termination_unconfirmed' @{servicePid=$child.Id} }
                    $phase = 'monitor_service'
                } else {
                    Write-WatchdogEvent 'service_termination_skipped' @{servicePid=$child.Id; reason='identity_unverified'; consecutiveFailures=$failures}
                }
                break
            }
        }
        $stopping = Test-Path -LiteralPath $stopFlag
        if ($child.HasExited) {
            if ($stopping -and $exitReason -eq 'process_exit') { $exitReason = 'stop_requested' }
            $exitCode = $null
            try { $exitCode = $child.ExitCode } catch { }
            Write-WatchdogEvent 'service_exited' @{
                servicePid=$child.Id; exitCode=$exitCode; reason=$exitReason;
                observedMs=$observed.ElapsedMilliseconds; stderr=(Get-StderrSummary)
            }
            if (-not $stopping) {
                $restartAfterPid = $child.Id
                Write-WatchdogEvent 'service_restart_scheduled' @{servicePid=$child.Id; reason=$exitReason; delayMs=5000}
            }
        }
        $child.Dispose()
        if (-not (Test-Path -LiteralPath $stopFlag)) { Start-Sleep -Seconds 5 }
    }
} catch {
    $stopReason = 'watchdog_error'
    Write-WatchdogEvent 'watchdog_error' @{stage=$phase; hresult=$_.Exception.HResult}
    throw
} finally {
    Write-WatchdogEvent 'watchdog_stopped' @{reason=$stopReason}
    $watchdogPidFile = Join-Path $runtime 'watchdog.pid'
    if ((Test-Path -LiteralPath $watchdogPidFile) -and ([IO.File]::ReadAllText($watchdogPidFile)).Trim() -eq [string]$PID) { Remove-Item -LiteralPath $watchdogPidFile }
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
