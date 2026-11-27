# Shared by the Windows lifecycle entrypoints. No service is started on import.
function Assert-BridgeScheduledPort {
    if ($env:QQ_CODEX_PORT -and $env:QQ_CODEX_PORT -ne '17329') {
        throw 'Scheduled autostart uses port 17329. Clear QQ_CODEX_PORT before managing this installation.'
    }
}

function Get-BridgeTask {
    param([string]$BridgeRoot)
    $task = Get-ScheduledTask -TaskName 'QQ-Codex-Bridge' -ErrorAction SilentlyContinue
    if ($task) {
        Assert-BridgeScheduledPort
        $actions = @($task.Actions)
        if ($actions.Count -ne 1 -or -not $actions[0].WorkingDirectory -or
            [IO.Path]::GetFullPath($actions[0].WorkingDirectory).TrimEnd('\') -ine [IO.Path]::GetFullPath($BridgeRoot).TrimEnd('\')) {
            throw 'QQ-Codex-Bridge belongs to another directory. Uninstall its autostart there before installing this copy.'
        }
    }
    return $task
}

function Get-BridgeProcess {
    param([string]$BridgeRoot, [ValidateSet('service', 'watchdog')][string]$Kind, [switch]$RejectUnverified)
    $pidName = 'pid.txt'; $scriptName = 'server.mjs'; $processName = 'node.exe'
    if ($Kind -eq 'watchdog') { $pidName = 'watchdog.pid'; $scriptName = 'Watchdog.ps1'; $processName = 'powershell.exe' }
    $pidFile = Join-Path $BridgeRoot ('runtime\' + $pidName)
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    $processId = 0
    if (-not [int]::TryParse(([IO.File]::ReadAllText($pidFile)).Trim(), [ref]$processId) -or $processId -le 0) { return $null }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    $scriptPath = [regex]::Escape((Join-Path $BridgeRoot $scriptName))
    if ($candidate -and $candidate.Name -ieq $processName -and
        $candidate.CommandLine -match ('(?:^|\s)(?:"' + $scriptPath + '"|' + $scriptPath + ')(?:\s|$)')) {
        return $candidate
    }
    if ($candidate -and $RejectUnverified) { throw "PID $processId could not be verified as this bridge's $Kind. No process was stopped. Inspect runtime PID files and use an absolute server.mjs entrypoint." }
    return $null
}

function Get-BridgeRuntimePath {
    param([string]$NodePath, [string[]]$RegistryPaths = @([Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine')))
    $sources = @()
    if ($NodePath) { $sources += [IO.Path]::GetDirectoryName($NodePath) }
    $sources += $env:Path
    $sources += $RegistryPaths
    $sources += (Join-Path $env:SystemRoot 'System32')
    $sources += (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $result = [Collections.Generic.List[string]]::new()
    foreach ($source in $sources) {
        foreach ($entry in ([string]$source -split ';')) {
            $expanded = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))
            if (-not $expanded -or $expanded -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)') { continue }
            try { $full = [IO.Path]::GetFullPath($expanded) } catch { continue }
            if ($seen.Add($full)) { $result.Add($full) }
        }
    }
    return ($result -join ';')
}

function Resolve-BridgeNode {
    param([string]$BridgeRoot, [string]$NodePath, [switch]$Persist)
    $hostFile = Join-Path $BridgeRoot 'runtime\windows-host.json'
    $previousPath = $env:Path
    try {
        # Discovery can use refreshed paths without changing the calling terminal.
        $env:Path = Get-BridgeRuntimePath
        $candidates = @()
        if ($NodePath) { $candidates += $NodePath } else {
            if (Test-Path -LiteralPath $hostFile) {
                try { $candidates += (Get-Content -LiteralPath $hostFile -Raw | ConvertFrom-Json).nodePath } catch { }
            }
            $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($command) { $candidates += $command.Source }
        }
        foreach ($candidatePath in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
            if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) { continue }
            try {
                $version = & $candidatePath --version 2>$null
                if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { continue }
                $resolvedPath = (Resolve-Path -LiteralPath $candidatePath).ProviderPath
                if ($Persist) {
                    New-Item -ItemType Directory -Path (Join-Path $BridgeRoot 'runtime') -Force | Out-Null
                    $json = @{nodePath=$resolvedPath} | ConvertTo-Json
                    [IO.File]::WriteAllText($hostFile, $json)
                }
                return $resolvedPath
            } catch { }
        }
        throw 'Node.js 24 or newer was not found. Install it, then run Install.ps1 (or pass -NodePath to its node.exe).'
    } finally {
        $env:Path = $previousPath
    }
}

function Get-BridgeBaseUrl {
    $port = 17329
    if ($env:QQ_CODEX_PORT) { $port = [int]$env:QQ_CODEX_PORT }
    if ($port -lt 1 -or $port -gt 65535) { throw 'QQ_CODEX_PORT must be a valid TCP port.' }
    return "http://127.0.0.1:$port"
}

function Test-BridgeHealth {
    try { return (Invoke-RestMethod ((Get-BridgeBaseUrl) + '/health') -TimeoutSec 2).ok -eq $true } catch { return $false }
}

function Start-BridgeWatchdog {
    param([string]$BridgeRoot, $Task)
    if ($Task) {
        if ([string]$Task.State -eq 'Disabled') { throw 'Autostart is disabled. Run Install.ps1 to enable it again.' }
        Start-ScheduledTask -TaskName 'QQ-Codex-Bridge'
    } elseif (-not (Get-BridgeProcess $BridgeRoot watchdog)) {
        $launcherPath = & (Join-Path $BridgeRoot 'scripts\ops\Build-WindowsLauncher.ps1')
        Start-Process -FilePath $launcherPath -ArgumentList 'watchdog' -WorkingDirectory $BridgeRoot -WindowStyle Hidden
    }
}

function Wait-BridgeStopped {
    param([string]$BridgeRoot, [int]$TimeoutSeconds = 45, [switch]$WatchdogOnly)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (-not (Get-BridgeProcess $BridgeRoot watchdog) -and ($WatchdogOnly -or -not (Get-BridgeProcess $BridgeRoot service -RejectUnverified))) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Safe shutdown did not finish. No processes were force-killed. Check Status.ps1 and runtime logs before retrying.'
}
