import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  projectRoot,
  runtimeDir,
  exportsDir,
  publicDir,
  scriptsDir,
  verificationDir,
  defaultUsersRoot,
  probeWorkspaceDir,
} from '../src/paths.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const readSource = relative => fs.readFileSync(path.join(projectRoot, relative), 'utf8');

test('central paths resolve from the package root rather than the process working directory', () => {
  assert.equal(projectRoot, path.resolve(root));
  assert.equal(JSON.parse(readSource('package.json')).name, 'qq-codex-local-bridge');
  for (const value of [projectRoot, runtimeDir, exportsDir, publicDir, scriptsDir, verificationDir, defaultUsersRoot, probeWorkspaceDir]) {
    assert.equal(typeof value, 'string');
    assert(path.isAbsolute(value), `expected an absolute path: ${value}`);
  }
  const pathsURL = new URL('../src/paths.mjs', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import * as paths from ${JSON.stringify(pathsURL)}; console.log(JSON.stringify(paths));`],
  { cwd: path.parse(projectRoot).root, encoding: 'utf8', windowsHide: true });
  assert.equal(JSON.parse(output).projectRoot, projectRoot);
});

test('moving source preserves runtime, export, account and probe data locations', () => {
  assert.equal(runtimeDir, path.join(projectRoot, 'runtime'));
  assert.equal(exportsDir, path.join(projectRoot, 'exports'));
  assert.equal(verificationDir, path.join(exportsDir, 'verification', 'reports'));
  assert.equal(defaultUsersRoot, path.resolve(projectRoot, '../../work/qq-users'));
  assert.equal(probeWorkspaceDir, path.resolve(projectRoot, '../../work/probe'));
});

test('static pages and media commands resolve to existing resources through central paths', () => {
  assert.equal(publicDir, path.join(projectRoot, 'public'));
  assert.equal(scriptsDir, path.join(projectRoot, 'scripts'));
  for (const name of ['setup.html', 'setup.js', 'history.html', 'history.js', 'ui-client.js']) {
    assert(fs.statSync(path.join(publicDir, name)).isFile(), `${name} must remain available to the HTTP service`);
  }
  for (const name of ['transcribe.py', 'speak.ps1']) {
    assert(fs.statSync(path.join(scriptsDir, 'media', name)).isFile(), `${name} must remain available to media processing`);
  }
  // Inspect source instead of importing the live app or starting media subprocesses.
  assert(/path\.join\(\s*publicDir\s*,/.test(readSource('src/app.mjs')), 'static resource loading must use publicDir');
  assert(/path\.join\(\s*scriptsDir\s*,/.test(readSource('src/media/processor.mjs')), 'media commands must use scriptsDir');
});

test('root compatibility commands only delegate to an existing new entrypoint', () => {
  for (const name of ['server.mjs', 'notify-release.mjs']) {
    const source = readSource(name).replace(/^#![^\n]*\n/, '').replace(/^\s*\/\/.*$/gm, '').trim();
    const match = source.match(/^import\s+(['"])(\.\/(?:src|scripts)\/[^'"]+\.mjs)\1\s*;?$/);
    assert(match, `${name} must contain only a side-effect import, without duplicated runtime logic`);
    const target = path.resolve(projectRoot, match[2]);
    assert(fs.statSync(target).isFile(), `${name} must delegate to an existing module`);
  }
});
