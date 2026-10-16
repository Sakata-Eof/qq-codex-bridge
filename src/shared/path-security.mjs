import fs from 'node:fs';
import path from 'node:path';

export function within(root, target) {
  const r = path.relative(fs.realpathSync(root), fs.realpathSync(target));
  return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r));
}
