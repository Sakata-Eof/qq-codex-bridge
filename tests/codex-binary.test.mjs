import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveCodexBinary} from '../src/core/codex-binary.mjs';

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-codex-binary-'));
  t.after(() => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('qq-codex-binary-'));
    fs.rmSync(temporary, {recursive: true, force: true});
  });
  const root = path.join(temporary, 'OpenAI', 'Codex', 'bin');
  const options = {platform: 'win32', env: {LOCALAPPDATA: temporary}};
  const install = (version, modified = 1) => {
    const file = path.join(root, version, 'codex.exe');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, 'fixture');
    fs.utimesSync(file, modified, modified);
    return file;
  };
  return {temporary, root, options, install};
}

test('a deleted desktop version is rediscovered when a later account process starts', t => {
  const f = fixture(t), original = f.install('old', 1);
  assert.equal(resolveCodexBinary(original, f.options), original);
  const replacement = f.install('new', 2);
  fs.unlinkSync(original);
  assert.equal(resolveCodexBinary(original, f.options), replacement);
  const next = f.install('newer', 3);
  fs.unlinkSync(replacement);
  assert.equal(resolveCodexBinary(replacement, f.options), next);
});

test('default discovery selects the newest executable and skips incomplete versions', t => {
  const f = fixture(t);
  f.install('older', 1);
  const latest = f.install('latest', 4);
  fs.mkdirSync(path.join(f.root, 'incomplete'), {recursive: true});
  fs.mkdirSync(path.join(f.root, 'directory-decoy', 'codex.exe'), {recursive: true});
  assert.equal(resolveCodexBinary('codex', f.options), latest);
  assert.equal(resolveCodexBinary('codex.exe', f.options), latest);
});

test('an existing configured executable remains pinned when another version is installed', t => {
  const f = fixture(t), pinned = f.install('pinned', 1);
  f.install('newer', 2);
  assert.equal(resolveCodexBinary(pinned, f.options), pinned);
});

test('custom commands and missing custom paths are never silently replaced', t => {
  const f = fixture(t);
  f.install('available');
  const custom = path.join(f.temporary, 'custom', 'codex.exe');
  const sibling = path.join(f.temporary, 'OpenAI', 'Codex', 'bin-other', 'version', 'codex.exe');
  const nested = path.join(f.root, 'version', 'nested', 'codex.exe');
  const binaries = ['custom-codex', 'relative/codex.exe', custom, sibling, nested];
  if (process.platform === 'win32') binaries.push((path.parse(f.temporary).root[0] === 'Z' ? 'Y' : 'Z') + ':\\codex.exe');
  for (const binary of binaries) {
    assert.equal(resolveCodexBinary(binary, f.options), binary);
  }
});

test('missing installations and non-Windows environments preserve the requested command', t => {
  const f = fixture(t), missing = path.join(f.root, 'removed', 'codex.exe');
  assert.equal(resolveCodexBinary(missing, f.options), missing);
  assert.equal(resolveCodexBinary('codex', f.options), 'codex');
  f.install('available');
  assert.equal(resolveCodexBinary('codex', {...f.options, platform: 'linux'}), 'codex');
  assert.equal(resolveCodexBinary('codex', {platform: 'win32', env: {}}), 'codex');
});
