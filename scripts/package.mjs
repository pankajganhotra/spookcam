// Production build + release zip: release/spookcam-v<version>.zip with manifest.json at the root,
// ready to unzip and "Load unpacked" in chrome://extensions.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (pkg.version !== version) throw new Error(`version mismatch: manifest ${version} vs package.json ${pkg.version}`);

execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs')], { stdio: 'inherit' });

const outDir = resolve(root, 'release');
const zip = resolve(outDir, `spookcam-v${version}.zip`);
await mkdir(outDir, { recursive: true });
await rm(zip, { force: true });
// -X: no extra file attributes (reproducible-ish), -r: recurse; run inside dist/ so files sit at the zip root.
execFileSync('zip', ['-X', '-r', '-q', zip, '.', '-x', '*.DS_Store'], { cwd: resolve(root, 'dist'), stdio: 'inherit' });
console.log(`packaged → ${zip}`);
