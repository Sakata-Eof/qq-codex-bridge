import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectRoot } from '../src/paths.mjs';

function files(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(folder, entry.name);
    return entry.isDirectory() ? files(target) : /\.(?:mjs|js)$/.test(entry.name) ? [target] : [];
  });
}
const modules = ['src', 'public', 'tests', 'scripts'].flatMap(folder => files(path.join(projectRoot, folder)));
modules.push(path.join(projectRoot, 'server.mjs'), path.join(projectRoot, 'notify-release.mjs'));
let imports = 0;
for (const file of modules) {
  execFileSync(process.execPath, ['--check', file], { windowsHide: true, stdio: 'pipe' });
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/^import\s+(?:[^;\n]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    const imported = fileURLToPath(new URL(match[1], pathToFileURL(file)));
    if (!fs.existsSync(imported)) throw new Error(`Missing import ${match[1]} in ${path.relative(projectRoot, file)}`);
    imports++;
  }
}
for (const name of ['setup.html', 'history.html']) {
  const source = fs.readFileSync(path.join(projectRoot, 'public', name), 'utf8');
  for (const match of source.matchAll(/<script\b[^>]*\bsrc="\/([^"?]+)"/g)) {
    if (!fs.existsSync(path.join(projectRoot, 'public', match[1]))) throw new Error(`Missing browser asset ${match[1]}`);
  }
}
console.log(`Checked ${modules.length} JavaScript files, ${imports} relative imports, and browser script assets.`);
