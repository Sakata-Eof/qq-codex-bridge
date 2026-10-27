$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$localLaunchers = Join-Path $bridgeRoot 'exports\launchers'
New-Item -ItemType Directory -Path $localLaunchers -Force | Out-Null
$programs = [Environment]::GetFolderPath('Programs')
$shell = New-Object -ComObject WScript.Shell
$launcherPath = & (Join-Path $bridgeRoot 'scripts\ops\Build-WindowsLauncher.ps1')
foreach ($entry in @(
    @{Name='Codex QQ 控制台'; Arguments=''},
    @{Name='Codex QQ 消息历史'; Arguments=' -History'}
)) {
    $shortcutPath = Join-Path $programs ($entry.Name + '.lnk')
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $launcherPath
    $shortcut.Arguments = 'start' + $entry.Arguments
    $shortcut.WorkingDirectory = $bridgeRoot
    $shortcut.Description = '打开本机 QQ Codex 服务；自动启动并验证当前浏览器。'
    $shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',14'
    $shortcut.WindowStyle = 1
    $shortcut.Save()
    Copy-Item -LiteralPath $shortcutPath -Destination (Join-Path $localLaunchers ($entry.Name + '.lnk')) -Force
    [pscustomobject]@{Name=$entry.Name; Installed=(Test-Path -LiteralPath $shortcutPath)}
}
