import {build} from 'esbuild';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const testDir = join(root, 'tests');
const entries = (await readdir(testDir)).filter(name => name.endsWith('.test.ts')).sort();
if (!entries.length) throw new Error('No regression tests found.');
const buildDir = await mkdtemp(join(root, '.test-build-'));
try {
  await build({
    entryPoints: entries.map(name => join(testDir, name)),
    outdir: buildDir,
    bundle: true,
    packages: 'external',
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outExtension: {'.js': '.mjs'},
    sourcemap: 'inline',
    logLevel: 'warning',
  });
  const files = entries.map(name => join(buildDir, name.replace(/\.ts$/, '.mjs')));
  const child = spawn(process.execPath, ['--test', ...files], {cwd: root, stdio: 'inherit'});
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
} finally {
  await rm(buildDir, {recursive: true, force: true});
}
