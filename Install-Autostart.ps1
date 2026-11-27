param([string]$NodePath, [switch]$NoStart)
$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
. (Join-Path $bridgeRoot 'scripts\ops\WindowsLifecycle.ps1')
Assert-BridgeScheduledPort
Get-BridgeTask $bridgeRoot | Out-Null
Resolve-BridgeNode $bridgeRoot -NodePath $NodePath -Persist | Out-Null
$stopFlag = Join-Path $bridgeRoot 'runtime\stop.flag'
$taskName = 'QQ-Codex-Bridge'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$launcherPath = & (Join-Path $bridgeRoot 'scripts\ops\Build-WindowsLauncher.ps1')
$action = New-ScheduledTaskAction -Execute $launcherPath -Argument 'watchdog' -WorkingDirectory $bridgeRoot
$trigger = @(
    New-ScheduledTaskTrigger -AtLogOn -User $identity
    New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'QQ Codex Bridge: current-user logon startup and minute recovery; stop.flag pauses recovery.' -Force | Out-Null
if (-not $NoStart) {
    if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag }
    Start-ScheduledTask -TaskName $taskName
}
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
