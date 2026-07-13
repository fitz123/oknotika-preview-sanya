import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [...walk(resolve(appRoot, 'src')), ...walk(resolve(appRoot, 'scripts'))]
  .filter((path) => extname(path) === '.js');

for (const path of files) {
  execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
}

console.log(`Checked ${files.length} JavaScript source files.`);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
