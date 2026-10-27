$ErrorActionPreference = 'Stop'
# Windows PowerShell's compiler supports WindowsApplication on .NET Framework.
if ($PSVersionTable.PSEdition -eq 'Core') {
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the windowless launcher.' }
    return
}
$bridgeRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$sourcePath = Join-Path $PSScriptRoot 'WindowsLauncher.cs'
$launcherDir = Join-Path $bridgeRoot 'runtime\launchers'
New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
$hasher = [Security.Cryptography.SHA256]::Create()
try { $sourceHash = [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($sourcePath))).Replace('-', '').ToLowerInvariant() }
finally { $hasher.Dispose() }
$launcherPath = Join-Path $launcherDir ('BridgeLauncher-' + $sourceHash.Substring(0, 16) + '.exe')
if (-not (Test-Path -LiteralPath $launcherPath)) {
    $temporaryPath = Join-Path $launcherDir ('build-' + [Guid]::NewGuid().ToString('N') + '.exe')
    try {
        Add-Type -TypeDefinition ([IO.File]::ReadAllText($sourcePath)) -OutputAssembly $temporaryPath -OutputType WindowsApplication
        # A content-addressed filename keeps a running launcher safe during upgrades.
        if (-not (Test-Path -LiteralPath $launcherPath)) { Move-Item -LiteralPath $temporaryPath -Destination $launcherPath }
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath }
    }
}
$launcherPath
