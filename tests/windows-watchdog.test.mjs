import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

const exec = promisify(execFile);
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

async function waitFor(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Isolated watchdog fixture did not reach the expected state.');
    await delay(100);
  }
}

test('Windows watchdog recovers a crashed fixture and honors safe lifecycle operations', {
  skip: process.platform !== 'win32', timeout: 90000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq bridge watchdog '));
  const runtime = path.join(root, 'runtime');
  const ops = path.join(root, 'scripts/ops');
  fs.mkdirSync(runtime, {recursive: true});
  fs.mkdirSync(ops, {recursive: true});
  for (const name of ['Start.ps1', 'Stop.ps1', 'Restart.ps1', 'Watchdog.ps1']) {
    fs.copyFileSync(new URL(`../${name}`, import.meta.url), path.join(root, name));
  }
  for (const name of ['WindowsLifecycle.ps1', 'Build-WindowsLauncher.ps1', 'WindowsLauncher.cs']) {
    fs.copyFileSync(new URL(`../scripts/ops/${name}`, import.meta.url), path.join(ops, name));
  }
  fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({adminToken: 'fixture-token'}));
  fs.writeFileSync(path.join(runtime, 'windows-host.json'), JSON.stringify({nodePath: process.execPath}));
  fs.writeFileSync(path.join(root, 'server.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
const runtime = new URL('./runtime/', import.meta.url);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') { res.end('{"ok":true}'); return; }
  if (req.url === '/api/shutdown' && req.method === 'POST' && req.headers.authorization === 'Bearer fixture-token') {
    if (fs.existsSync(new URL('busy.flag', runtime))) { res.writeHead(400); res.end('{"error":"fixture busy"}'); return; }
    res.end('{"ok":true}'); setTimeout(() => server.close(() => process.exit(0)), 100); return;
  }
  res.writeHead(404); res.end('{}');
});
server.listen(Number(process.env.QQ_CODEX_PORT), '127.0.0.1', () => {
  fs.writeFileSync(new URL('pid.txt', runtime), String(process.pid));
  fs.writeFileSync(new URL('setup-url.txt', runtime), 'http://127.0.0.1:' + process.env.QQ_CODEX_PORT + '/#fixture-token');
});
setInterval(() => {
  const crash = new URL('crash.flag', runtime);
  if (!fs.existsSync(crash)) return;
  fs.unlinkSync(crash);
  fs.writeSync(2, 'Error: EADDRINUSE fixture-private-stderr');
  process.exit(43);
}, 50).unref();
`);
  // Never inspect or mutate the real installation's scheduled task.
  const wrapper = path.join(root, 'fixture.ps1');
  fs.writeFileSync(wrapper, `param([string]$Mode)
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Management, Microsoft.PowerShell.Utility, CimCmdlets, ScheduledTasks -ErrorAction Stop
$PSModuleAutoLoadingPreference = 'None'
function global:Get-ScheduledTask { return $null }
function global:Register-ScheduledTask { throw 'Real task registration is forbidden in watchdog fixtures.' }
function global:Start-ScheduledTask { throw 'Real task startup is forbidden in watchdog fixtures.' }
function global:Stop-ScheduledTask { throw 'Real task shutdown is forbidden in watchdog fixtures.' }
function global:Unregister-ScheduledTask { throw 'Real task removal is forbidden in watchdog fixtures.' }
if ($Mode -eq 'start') { & (Join-Path $PSScriptRoot 'Start.ps1') -NoBrowser }
elseif ($Mode -eq 'restart') { & (Join-Path $PSScriptRoot 'Restart.ps1') }
elseif ($Mode -eq 'stop') { & (Join-Path $PSScriptRoot 'Stop.ps1') }
else { throw 'Unsupported fixture mode' }
`);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = {...process.env, QQ_CODEX_PORT: String(port)};
  const run = mode => exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper, mode], {
    cwd: root, env, windowsHide: true, timeout: 55000,
  });
  const pid = () => Number(fs.readFileSync(path.join(runtime, 'pid.txt'), 'utf8'));
  const diagnostics = () => fs.readFileSync(path.join(runtime, 'watchdog.log'), 'utf8');
  const records = () => diagnostics().trim().split(/\r?\n/).map(line => JSON.parse(line));
  const alive = id => { try { process.kill(id, 0); return true; } catch { return false; } };
  t.after(async () => {
    fs.rmSync(path.join(runtime, 'busy.flag'), {force: true});
    try { await run('stop'); } finally {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('qq bridge watchdog '));
      fs.rmSync(root, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
    }
  });

  await run('start');
  const firstPid = pid();
  assert.equal(alive(firstPid), true);

  await t.test('a busy service rejects restart and retains its running process and recovery', async () => {
    fs.writeFileSync(path.join(runtime, 'busy.flag'), 'busy');
    await assert.rejects(run('restart'), error => /Safe shutdown failed/.test(error.stderr));
    assert.equal(pid(), firstPid);
    assert.equal(alive(firstPid), true);
    assert.equal(fs.existsSync(path.join(runtime, 'stop.flag')), false);
    fs.rmSync(path.join(runtime, 'busy.flag'));
    await waitFor(() => records().some(row=>row.event==='service_adopted'&&row.servicePid===firstPid));
  });

  await t.test('an exited Node process is replaced by the actual windowless watchdog', async () => {
    fs.writeFileSync(path.join(runtime, 'crash.flag'), '');
    await waitFor(() => pid() !== firstPid && alive(pid()));
    await waitFor(() => records().some(row=>row.event==='service_started'&&row.servicePid===pid()));
    const log=records();
    const exit=log.find(row=>row.event==='service_exited'&&row.servicePid===firstPid);
    assert.equal(exit.exitCode,43);
    assert.equal(exit.reason,'process_exit');
    assert.deepEqual(exit.stderr.categories,['port_in_use']);
    assert.match(exit.time,/Z$/);
    assert(log.some(row=>row.event==='service_restart_scheduled'&&row.servicePid===firstPid));
    assert(log.some(row=>row.event==='service_started'&&row.servicePid===pid()&&row.restartAfterPid===firstPid));
    assert.doesNotMatch(diagnostics(),/fixture-private-stderr|fixture-token/);
  });

  await t.test('safe restart waits for the old process before reporting readiness', async () => {
    const previous = pid();
    await run('restart');
    assert.equal(alive(previous), false);
    assert.notEqual(pid(), previous);
    assert.equal(alive(pid()), true);
  });

  await t.test('explicit stop blocks even a fresh watchdog launch until explicit start', async () => {
    const previous = pid();
    await run('stop');
    assert.equal(alive(previous), false);
    assert(records().some(row=>row.event==='watchdog_stopped'&&row.reason==='stop_flag'));
    assert.equal(fs.existsSync(path.join(runtime, 'watchdog.pid')), false);
    const executable = fs.readdirSync(path.join(runtime, 'launchers')).find(name => /^BridgeLauncher-.*\.exe$/.test(name));
    const child = spawn(path.join(runtime, 'launchers', executable), ['watchdog'], {cwd: root, env, windowsHide: true, stdio: 'ignore'});
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0);
    assert.equal(pid(), previous);
    assert.equal(alive(previous), false);
    await run('start');
    assert.notEqual(pid(), previous);
    assert.equal(alive(pid()), true);
    assert.equal(fs.existsSync(path.join(runtime, 'stop.flag')), false);
  });
});
