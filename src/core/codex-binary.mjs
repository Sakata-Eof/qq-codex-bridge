import fs from 'node:fs';
import path from 'node:path';

// Desktop updates can remove a version directory while the bridge keeps running.
// Only replace the default command or a missing binary from that managed layout.
export function resolveCodexBinary(binary = 'codex', {env = process.env, platform = process.platform} = {}) {
  if (platform !== 'win32' || !env.LOCALAPPDATA) return binary;
  const root = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  const defaultCommand = binary === 'codex' || binary === 'codex.exe';
  if (!defaultCommand) {
    if (!path.isAbsolute(binary) || fs.existsSync(binary)) return binary;
    const relative = path.relative(root, binary);
    const parts = relative.split(path.sep);
    if (path.isAbsolute(relative) || parts.length !== 2 || parts[0] === '..' || parts[1].toLowerCase() !== 'codex.exe') return binary;
  }
  let entries;
  try { entries = fs.readdirSync(root, {withFileTypes: true}); } catch { return binary; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'codex.exe');
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) candidates.push({file, modified: stat.mtimeMs});
    } catch { /* A concurrent update may remove a candidate during discovery. */ }
  }
  candidates.sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
  return candidates[0]?.file || binary;
}
