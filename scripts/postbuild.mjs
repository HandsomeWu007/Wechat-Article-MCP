import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');

if (fs.existsSync(cli)) {
  const src = fs.readFileSync(cli, 'utf8');
  if (!src.startsWith('#!')) {
    fs.writeFileSync(cli, `#!/usr/bin/env node\n${src}`);
  }
  try {
    fs.chmodSync(cli, 0o755);
  } catch {
    /* Windows 上忽略 */
  }
  console.log('postbuild: dist/cli.js ready');
}
