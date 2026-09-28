import {readFileSync, writeFileSync, mkdirSync, lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {zipSync, unzipSync, strFromU8} from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'browser-helper');
const files = ['manifest.json', 'background.mjs', 'core.mjs', 'bridge.js', 'page-capture.js', 'audio-save-page.js', 'popup.html', 'popup.mjs', 'popup.css', 'README.md'];
const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || manifest.background?.service_worker !== 'background.mjs' || manifest.background.type !== 'module' || manifest.action?.default_popup !== 'popup.html') throw Error('Invalid browser helper manifest');
if (!manifest.content_scripts?.some(script => script.world === 'MAIN' && script.run_at === 'document_start' && script.js?.includes('page-capture.js') && script.matches?.includes('https://www.bilibili.com/video/*'))) throw Error('Missing normal Bilibili playback capture');
const archive = {};
for (const file of files) {
  const source = path.join(directory, file);
  if (!lstatSync(source).isFile()) throw Error(`Expected a regular extension file: ${file}`);
  if (/\.(?:mjs|js)$/.test(file)) {
    const syntax = spawnSync(process.execPath, ['--check', source], {encoding: 'utf8'});
    if (syntax.status !== 0) throw Error(syntax.stderr || `Invalid extension JavaScript: ${file}`);
  }
  archive['shiyin-browser-helper/' + file] = [new Uint8Array(readFileSync(source)), {mtime: new Date('2000-01-01T00:00:00Z')}];
}
const zipped = zipSync(archive, {level: 9});
const verified = unzipSync(zipped);
if (Object.keys(verified).length !== files.length || JSON.parse(strFromU8(verified['shiyin-browser-helper/manifest.json'])).version !== manifest.version) throw Error('Extension archive verification failed');
mkdirSync(path.join(root, 'public'), {recursive: true});
writeFileSync(path.join(root, 'public/shiyin-browser-helper.zip'), zipped);
console.log(`拾音浏览器助手 ${manifest.version} 已打包（${files.length} 个文件，${zipped.length} 字节）。`);
