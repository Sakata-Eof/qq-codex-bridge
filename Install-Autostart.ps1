$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$stopFlag = Join-Path $bridgeRoot 'runtime\stop.flag'
if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag }
$taskName = 'QQ-Codex-Bridge'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$launcherPath = & (Join-Path $bridgeRoot 'scripts\ops\Build-WindowsLauncher.ps1')
$action = New-ScheduledTaskAction -Execute $launcherPath -Argument 'watchdog' -WorkingDirectory $bridgeRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Dedicated QQ bot controlling local Codex, with process watchdog.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
