import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

async function waitForFile(file, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for fixture file: ${file}`);
    await delay(40);
  }
}

function fixtureScript(mode) {
  return `param([switch]$History, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LauncherConsoleProbe {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
}
'@
$runtime = Join-Path $PSScriptRoot 'runtime'
$control = Get-Content -LiteralPath (Join-Path $runtime 'control.json') -Raw | ConvertFrom-Json
$result = @{
    mode = '${mode}'
    history = [bool]$History
    noBrowser = [bool]$NoBrowser
    consoleHandle = [LauncherConsoleProbe]::GetConsoleWindow().ToInt64()
    workingDirectory = (Get-Location).Path
    scriptRoot = $PSScriptRoot
}
$result | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $runtime 'result.json') -Encoding UTF8
Start-Sleep -Milliseconds $control.delayMs
[Console]::Out.WriteLine('fixture launcher stdout marker')
[Console]::Error.WriteLine('fixture launcher stderr marker')
[IO.File]::WriteAllText((Join-Path $runtime 'finished.txt'), 'complete')
exit $control.exitCode
`;
}

test('Windows launcher runs console-free scripts through the real compiled entrypoint', {
  skip: process.platform !== 'win32',
  timeout: 60000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq bridge launcher '));
  const ops = path.join(root, 'scripts/ops');
  const runtime = path.join(root, 'runtime');
  const resultFile = path.join(runtime, 'result.json');
  const finishedFile = path.join(runtime, 'finished.txt');
  const children = new Set();
  t.after(() => {
    for (const child of children) child.kill();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()), 'cleanup must stay in the temporary directory');
    assert.ok(path.basename(root).startsWith('qq bridge launcher '));
    fs.rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  });
  fs.mkdirSync(ops, {recursive: true});
  fs.mkdirSync(runtime, {recursive: true});
  for (const name of ['Build-WindowsLauncher.ps1', 'WindowsLauncher.cs']) {
    fs.copyFileSync(new URL(`../scripts/ops/${name}`, import.meta.url), path.join(ops, name));
  }
  fs.writeFileSync(path.join(root, 'Watchdog.ps1'), fixtureScript('watchdog'));
  fs.writeFileSync(path.join(root, 'Start.ps1'), fixtureScript('start'));
  execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ops, 'Build-WindowsLauncher.ps1')], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000,
  });
  const launchers = path.join(runtime, 'launchers');
  const executables = fs.readdirSync(launchers).filter(name => /^BridgeLauncher-.*\.exe$/.test(name));
  assert.equal(executables.length, 1, 'the isolated build must produce one launcher');
  const executable = path.join(launchers, executables[0]);

  function launch(args, {exitCode = 0, delayMs = 0} = {}) {
    fs.rmSync(resultFile, {force: true});
    fs.rmSync(finishedFile, {force: true});
    fs.writeFileSync(path.join(runtime, 'control.json'), JSON.stringify({exitCode, delayMs}));
    const child = spawn(executable, args, {cwd: os.tmpdir(), windowsHide: true, stdio: 'ignore'});
    children.add(child);
    const run = {child, exited: false};
    run.done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        children.delete(child);
        run.exited = true;
        resolve({code, signal});
      });
    });
    return run;
  }

  await t.test('the executable uses the Windows GUI subsystem', () => {
    const bytes = fs.readFileSync(executable);
    const peOffset = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.toString('ascii', peOffset, peOffset + 4), 'PE\0\0');
    assert.equal(bytes.readUInt16LE(peOffset + 24 + 68), 2, 'a GUI executable does not allocate its own console');
  });

  await t.test('watchdog has no console, waits for completion, and preserves errors and exit status', async () => {
    const run = launch(['watchdog'], {exitCode: 37, delayMs: 1000});
    await waitForFile(resultFile);
    const result = readJSON(resultFile);
    assert.equal(result.mode, 'watchdog');
    assert.equal(result.consoleHandle, 0, 'PowerShell must not expose a console window');
    assert.equal(path.resolve(result.workingDirectory), root);
    assert.equal(path.resolve(result.scriptRoot), root);
    assert.equal(run.exited, false, 'the scheduler action must stay running while its watchdog runs');
    assert.equal(fs.existsSync(finishedFile), false);
    assert.deepEqual(await run.done, {code: 37, signal: null});
    assert.equal(fs.readFileSync(finishedFile, 'utf8'), 'complete');
    const log = fs.readFileSync(path.join(runtime, 'launcher.log'), 'utf8');
    assert.match(log, /fixture launcher stdout marker/);
    assert.match(log, /fixture launcher stderr marker/);
  });

  await t.test('start forwards its supported flags from paths containing spaces', async () => {
    for (const flags of [[], ['-History', '-NoBrowser']]) {
      const run = launch(['start', ...flags]);
      assert.deepEqual(await run.done, {code: 0, signal: null});
      const result = readJSON(resultFile);
      assert.equal(result.mode, 'start');
      assert.equal(result.history, flags.includes('-History'));
      assert.equal(result.noBrowser, flags.includes('-NoBrowser'));
      assert.equal(result.consoleHandle, 0);
      assert.equal(path.resolve(result.scriptRoot), root);
    }
  });

  await t.test('unknown modes and arguments cannot invoke either PowerShell script', async () => {
    for (const args of [[], ['unknown'], ['watchdog', '-History'], ['start', '-File', 'untrusted.ps1'], ['start', '-NoBrowser', 'unexpected']]) {
      const result = await launch(args).done;
      assert.notEqual(result.code, 0, `${JSON.stringify(args)} must be rejected`);
      assert.equal(fs.existsSync(resultFile), false, 'invalid arguments must fail before running a script');
    }
  });
});
