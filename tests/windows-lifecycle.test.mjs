import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const lifecycleScripts = ['Start.ps1', 'Stop.ps1', 'Restart.ps1', 'Install.ps1', 'Install-Autostart.ps1', 'Uninstall-Autostart.ps1', 'Status.ps1', 'Watchdog.ps1'];
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq bridge lifecycle '));
  fs.mkdirSync(path.join(root, 'scripts/ops'), {recursive: true});
  fs.mkdirSync(path.join(root, 'runtime'));
  for (const script of lifecycleScripts) fs.copyFileSync(new URL(`../${script}`, import.meta.url), path.join(root, script));
  fs.copyFileSync(new URL('../scripts/ops/WindowsLifecycle.ps1', import.meta.url), path.join(root, 'scripts/ops/WindowsLifecycle.ps1'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()), 'cleanup must stay in the temporary directory');
    assert.ok(path.basename(root).startsWith('qq bridge lifecycle '));
    fs.rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  });
  return root;
}

function run(root, source) {
  const script = path.join(root, 'driver.ps1');
  const resultFile = path.join(root, 'runtime/result.json');
  fs.rmSync(resultFile, {force: true});
  fs.writeFileSync(script, `$ErrorActionPreference = 'Stop'
# Import before installing mocks: module autoload can replace same-named functions.
Import-Module Microsoft.PowerShell.Management, Microsoft.PowerShell.Utility, ScheduledTasks -ErrorAction Stop
$PSModuleAutoLoadingPreference = 'None'
$global:fixtureRoot = $PSScriptRoot
function global:Assert-FixtureScheduler {
    if ($env:QQ_BRIDGE_LIFECYCLE_FIXTURE -ne $global:fixtureRoot -or
        [IO.Path]::GetDirectoryName($global:fixtureRoot) -ne [IO.Path]::GetTempPath().TrimEnd('\\') -or
        [IO.Path]::GetFileName($global:fixtureRoot) -notlike 'qq bridge lifecycle *') {
        throw 'Scheduler mocks require an isolated temporary fixture.'
    }
}
function global:Register-ScheduledTask { throw 'Real task registration is forbidden in lifecycle tests.' }
function global:Start-ScheduledTask { throw 'Real task startup is forbidden in lifecycle tests.' }
function global:Stop-ScheduledTask { throw 'Real task shutdown is forbidden in lifecycle tests.' }
function global:Unregister-ScheduledTask { throw 'Real task removal is forbidden in lifecycle tests.' }
function global:Get-ScheduledTask { [CmdletBinding()]param($TaskName) return $null }
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
function Save-Result($value) { $value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runtime 'result.json') -Encoding UTF8 }
${source}\n`);
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: os.tmpdir(), env: {...process.env, FIXTURE_NODE: process.execPath, QQ_BRIDGE_LIFECYCLE_FIXTURE: root, QQ_CODEX_PORT: ''}, windowsHide: true, encoding: 'utf8', timeout: 30000,
  });
  return readJSON(resultFile);
}

test('Windows lifecycle scripts protect instance ownership and safe restart boundaries', {
  skip: process.platform !== 'win32', timeout: 60000,
}, async t => {
  await t.test('all lifecycle entrypoints parse under Windows PowerShell', () => {
    const root = fixture(t);
    const result = run(root, `
$errors = @()
Get-ChildItem -LiteralPath $root -Filter '*.ps1' | ForEach-Object {
    $tokens = $null; $parseErrors = $null
    [Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
    $errors += @($parseErrors | ForEach-Object { $_.Message })
}
$tokens = $null; $parseErrors = $null
[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts\\ops\\WindowsLifecycle.ps1'), [ref]$tokens, [ref]$parseErrors) | Out-Null
$errors += @($parseErrors | ForEach-Object { $_.Message })
Save-Result @{errors=@($errors)}
`);
    assert.deepEqual(result.errors, []);
  });

  await t.test('foreign tasks and disabled tasks cannot be started by this instance', () => {
    const root = fixture(t);
    const result = run(root, `
. (Join-Path $root 'scripts\\ops\\WindowsLifecycle.ps1')
$global:task = [pscustomobject]@{State='Ready'; Actions=@([pscustomobject]@{WorkingDirectory=$root})}
$global:starts = 0
function global:Get-ScheduledTask { [CmdletBinding()]param($TaskName) return $global:task }
function global:Start-ScheduledTask { param($TaskName) Assert-FixtureScheduler; $global:starts++ }
$ownTask = Get-BridgeTask $root
$env:QQ_CODEX_PORT = '18321'
$differentPortRejected = $false
try { Get-BridgeTask $root | Out-Null } catch { $differentPortRejected = $true }
$env:QQ_CODEX_PORT = ''
$global:task.Actions[0].WorkingDirectory = Join-Path $root 'another checkout'
$foreignRejected = $false
try { Get-BridgeTask $root | Out-Null } catch { $foreignRejected = $_.Exception.Message -like '*another directory*' }
$global:task.Actions[0].WorkingDirectory = $null
$missingDirectoryRejected = $false
try { Get-BridgeTask $root | Out-Null } catch { $missingDirectoryRejected = $true }
$disabledRejected = $false
try { Start-BridgeWatchdog $root ([pscustomobject]@{State='Disabled'}) } catch { $disabledRejected = $true }
Save-Result @{ownAccepted=($null -ne $ownTask);differentPortRejected=$differentPortRejected;foreignRejected=$foreignRejected;missingDirectoryRejected=$missingDirectoryRejected;disabledRejected=$disabledRejected;starts=$global:starts}
`);
    assert.equal(result.ownAccepted, true);
    assert.equal(result.differentPortRejected, true);
    assert.equal(result.foreignRejected, true);
    assert.equal(result.missingDirectoryRejected, true);
    assert.equal(result.disabledRejected, true);
    assert.equal(result.starts, 0);
  });

  await t.test('PID files only identify the expected executable and exact script argument', () => {
    const root = fixture(t);
    const result = run(root, `
. (Join-Path $root 'scripts\\ops\\WindowsLifecycle.ps1')
$global:candidate = [pscustomobject]@{ProcessId=123;Name='node.exe';CommandLine=('"C:\\Node Folder\\node.exe" "' + (Join-Path $root 'server.mjs') + '"')}
$global:queries = 0
function Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter) $global:queries++; return $global:candidate }
[IO.File]::WriteAllText((Join-Path $runtime 'pid.txt'), '123')
$valid = Get-BridgeProcess $root service
$global:candidate.CommandLine = $global:candidate.CommandLine.Replace('server.mjs"', 'server.mjs.bak"')
$prefixRejected = $null -eq (Get-BridgeProcess $root service)
$unverifiedRejected = $false
try { Get-BridgeProcess $root service -RejectUnverified | Out-Null } catch { $unverifiedRejected = $true }
$global:candidate.CommandLine = 'node.exe --eval harmless'
$otherCommandRejected = $null -eq (Get-BridgeProcess $root service)
$global:candidate.Name = 'other.exe'
$global:candidate.CommandLine = '"' + (Join-Path $root 'server.mjs') + '"'
$otherExecutableRejected = $null -eq (Get-BridgeProcess $root service)
[IO.File]::WriteAllText((Join-Path $runtime 'pid.txt'), 'not a pid')
$beforeInvalid = $global:queries
$invalidPidRejected = $null -eq (Get-BridgeProcess $root service)
Save-Result @{validPid=$valid.ProcessId;prefixRejected=$prefixRejected;unverifiedRejected=$unverifiedRejected;otherCommandRejected=$otherCommandRejected;otherExecutableRejected=$otherExecutableRejected;invalidPidRejected=$invalidPidRejected;invalidPidWasNotQueried=($beforeInvalid -eq $global:queries)}
`);
    assert.equal(result.validPid, 123);
    for (const key of ['prefixRejected', 'unverifiedRejected', 'otherCommandRejected', 'otherExecutableRejected', 'invalidPidRejected', 'invalidPidWasNotQueried']) assert.equal(result[key], true, key);
  });

  await t.test('Node discovery persists a usable path, recovers stale cache, and rejects explicit invalid paths', () => {
    const root = fixture(t);
    const result = run(root, `
. (Join-Path $root 'scripts\\ops\\WindowsLifecycle.ps1')
function Get-Command { [CmdletBinding()]param($Name,$CommandType) return [pscustomobject]@{Source=$env:FIXTURE_NODE} }
$first = Resolve-BridgeNode $root -Persist
$saved = (Get-Content -LiteralPath (Join-Path $runtime 'windows-host.json') -Raw | ConvertFrom-Json).nodePath
@{nodePath=(Join-Path $root 'removed node.exe')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'windows-host.json')
$fallback = Resolve-BridgeNode $root -Persist
$explicitRejected = $false
try { Resolve-BridgeNode $root -NodePath (Join-Path $root 'missing explicit node.exe') | Out-Null } catch { $explicitRejected = $true }
$oldNode = Join-Path $root 'old-node.ps1'
[IO.File]::WriteAllText($oldNode, "$([char]36)global:LASTEXITCODE = 0; 'v22.0.0'")
$oldVersionRejected = $false
try { Resolve-BridgeNode $root -NodePath $oldNode | Out-Null } catch { $oldVersionRejected = $true }
Save-Result @{first=$first;saved=$saved;fallback=$fallback;explicitRejected=$explicitRejected;oldVersionRejected=$oldVersionRejected}
`);
    assert.equal(path.resolve(result.first), process.execPath);
    assert.equal(path.resolve(result.saved), process.execPath);
    assert.equal(path.resolve(result.fallback), process.execPath);
    assert.equal(result.explicitRejected, true);
    assert.equal(result.oldVersionRejected, true);
  });

  await t.test('autostart builds real logon and minute triggers while registration failure keeps recovery paused', () => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'scripts/ops/Build-WindowsLauncher.ps1'), "Join-Path $PSScriptRoot '..\\..\\runtime\\fixture-launcher.exe'\n");
    const result = run(root, `
$global:registered = $null; $global:starts = 0; $global:failRegistration = $false
function global:Get-ScheduledTask { [CmdletBinding()]param($TaskName)
    if ($global:registered) { [pscustomobject]@{TaskName=$TaskName;State='Ready';Actions=@($global:registered.Action)} }
}
function global:Register-ScheduledTask { [CmdletBinding()]param($TaskName,$Action,$Trigger,$Principal,$Settings,$Description,[switch]$Force)
    Assert-FixtureScheduler
    if ($Action.WorkingDirectory -ne $global:fixtureRoot) { throw 'Task action escaped the fixture.' }
    if ($global:failRegistration) { throw 'fixture registration failed' }
    $global:registered = @{Action=$Action;Triggers=@($Trigger);Principal=$Principal;Settings=$Settings}
}
function global:Start-ScheduledTask { param($TaskName) Assert-FixtureScheduler; $global:starts++ }
foreach ($mockName in @('Register-ScheduledTask', 'Start-ScheduledTask', 'Get-ScheduledTask')) {
    $mockCommand = $ExecutionContext.InvokeCommand.GetCommand($mockName, [Management.Automation.CommandTypes]::All)
    if ($mockCommand.CommandType -ne 'Function' -or $mockCommand.ModuleName) { throw ('Unsafe scheduler command: ' + $mockName) }
}
[IO.File]::WriteAllText((Join-Path $runtime 'stop.flag'), 'stop')
& (Join-Path $root 'Install-Autostart.ps1') -NodePath $env:FIXTURE_NODE -NoStart | Out-Null
$pausedWithoutStart = Test-Path -LiteralPath (Join-Path $runtime 'stop.flag')
$configured = $global:registered
$global:failRegistration = $true
$registrationRejected = $false
try { & (Join-Path $root 'Install-Autostart.ps1') -NodePath $env:FIXTURE_NODE | Out-Null } catch { $registrationRejected = $true }
$pausedAfterFailure = Test-Path -LiteralPath (Join-Path $runtime 'stop.flag')
$startsAfterFailure = $global:starts
$global:failRegistration = $false
& (Join-Path $root 'Install-Autostart.ps1') -NodePath $env:FIXTURE_NODE | Out-Null
Save-Result @{triggerKinds=@($configured.Triggers | ForEach-Object {$_.CimClass.CimClassName});repeatInterval=$configured.Triggers[1].Repetition.Interval;repeatDuration=$configured.Triggers[1].Repetition.Duration;multipleInstances=[string]$configured.Settings.MultipleInstances;restartCount=$configured.Settings.RestartCount;pausedWithoutStart=$pausedWithoutStart;registrationRejected=$registrationRejected;pausedAfterFailure=$pausedAfterFailure;startsAfterFailure=$startsAfterFailure;starts=$global:starts;pausedAfterSuccess=(Test-Path -LiteralPath (Join-Path $runtime 'stop.flag'))}
`);
    assert.deepEqual(result.triggerKinds, ['MSFT_TaskLogonTrigger', 'MSFT_TaskTimeTrigger']);
    assert.equal(result.repeatInterval, 'PT1M');
    assert.ok(!result.repeatDuration, 'minute recovery must not expire after one day');
    assert.equal(result.multipleInstances, 'IgnoreNew');
    assert.equal(result.restartCount, 999);
    assert.equal(result.pausedWithoutStart, true);
    assert.equal(result.registrationRejected, true);
    assert.equal(result.pausedAfterFailure, true);
    assert.equal(result.startsAfterFailure, 0);
    assert.equal(result.starts, 1);
    assert.equal(result.pausedAfterSuccess, false);
  });

  await t.test('safe shutdown rejection restores the watchdog and aborts restart before its start step', () => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'runtime/config.json'), JSON.stringify({adminToken: 'synthetic-admin-token'}));
    fs.appendFileSync(path.join(root, 'scripts/ops/WindowsLifecycle.ps1'), `
function Get-BridgeTask { param($BridgeRoot) return $null }
function Get-BridgeProcess { param($BridgeRoot,$Kind,[switch]$RejectUnverified) if ($Kind -eq 'service') { [pscustomobject]@{ProcessId=123} } }
function Start-BridgeWatchdog { param($BridgeRoot,$Task) $global:resumed++; $global:resumedWhilePaused = Test-Path -LiteralPath (Join-Path $BridgeRoot 'runtime\\stop.flag') }
function Wait-BridgeStopped { param($BridgeRoot,[switch]$WatchdogOnly) if (-not $WatchdogOnly) { throw 'Unexpected complete wait after rejected shutdown' }; $global:waitedForWatchdog = $true }
`);
    fs.writeFileSync(path.join(root, 'Start.ps1'), `param([switch]$NoBrowser)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'runtime\\start-called'), 'called')
`);
    const result = run(root, `
$global:resumed = 0; $global:resumedWhilePaused = $null; $global:waitedForWatchdog = $false
function Invoke-RestMethod { [CmdletBinding()]param($Uri,$Method,$Headers,$ContentType,$Body,$TimeoutSec) throw 'fixture busy or unconfirmed response' }
$rejected = $false
try { & (Join-Path $root 'Restart.ps1') } catch { $rejected = $_.Exception.Message -like '*not confirmed*' }
Save-Result @{rejected=$rejected;resumed=$global:resumed;resumedWhilePaused=$global:resumedWhilePaused;waitedForWatchdog=$global:waitedForWatchdog;paused=(Test-Path -LiteralPath (Join-Path $runtime 'stop.flag'));startCalled=(Test-Path -LiteralPath (Join-Path $runtime 'start-called'))}
`);
    assert.equal(result.rejected, true);
    assert.equal(result.resumed, 1);
    assert.equal(result.resumedWhilePaused, false);
    assert.equal(result.waitedForWatchdog, true);
    assert.equal(result.paused, false);
    assert.equal(result.startCalled, false);
  });

  await t.test('successful restart waits for safe stop and only opens a browser when requested', () => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'Stop.ps1'), "$global:steps += 'stopped'\n");
    fs.writeFileSync(path.join(root, 'Start.ps1'), "param([switch]$NoBrowser)\n$global:steps += 'started'; $global:noBrowser += [bool]$NoBrowser\n");
    const result = run(root, `
$global:steps = @(); $global:noBrowser = @()
& (Join-Path $root 'Restart.ps1')
& (Join-Path $root 'Restart.ps1') -OpenBrowser
Save-Result @{steps=$global:steps;noBrowser=$global:noBrowser}
`);
    assert.deepEqual(result.steps, ['stopped', 'started', 'stopped', 'started']);
    assert.deepEqual(result.noBrowser, [true, false]);
  });
});
