$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$programs = [Environment]::GetFolderPath('Programs')
$shell = New-Object -ComObject WScript.Shell
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
foreach ($entry in @(
    @{Name='Codex QQ 控制台'; Arguments=''},
    @{Name='Codex QQ 消息历史'; Arguments=' -History'}
)) {
    $shortcutPath = Join-Path $programs ($entry.Name + '.lnk')
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershellPath
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $bridgeRoot 'Start.ps1') + '"' + $entry.Arguments
    $shortcut.WorkingDirectory = $bridgeRoot
    $shortcut.Description = '打开本机 QQ Codex 服务；自动启动并验证当前浏览器。'
    $shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',14'
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    Copy-Item -LiteralPath $shortcutPath -Destination (Join-Path $bridgeRoot ($entry.Name + '.lnk')) -Force
    [pscustomobject]@{Name=$entry.Name; Installed=(Test-Path -LiteralPath $shortcutPath)}
}
