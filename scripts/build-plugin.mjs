// build-plugin.mjs — zip a plugin directory into dist-plugins/<name>.nnzplugin
//
// Usage:  node scripts/build-plugin.mjs [pluginDirName]
//         (defaults to "conversation-voice")
//
// The archive holds the plugin's files at its ROOT (plugin.json at top level,
// not nested inside a folder). node_modules, .git and *.nnzplugin are excluded.

import { createRequire } from 'node:module';
import {
  existsSync, mkdirSync, statSync, rmSync, readdirSync
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const name = (process.argv[2] || 'conversation-voice').trim();
const srcDir = join(repoRoot, 'plugins', name);
const outDir = join(repoRoot, 'dist-plugins');
const outFile = join(outDir, name + '.nnzplugin');

if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
  console.error(`[build-plugin] Direktori plugin tidak ditemukan: ${srcDir}`);
  process.exit(1);
}
if (!existsSync(join(srcDir, 'plugin.json'))) {
  console.error(`[build-plugin] ${srcDir} tidak punya plugin.json — bukan paket plugin yang valid.`);
  process.exit(1);
}

let AdmZip;
try {
  AdmZip = require('adm-zip');
} catch (e) {
  try {
    AdmZip = (await import('adm-zip')).default;
  } catch (e2) {
    console.error('[build-plugin] Modul "adm-zip" tidak terpasang.');
    console.error('               Jalankan dulu:  npm install adm-zip');
    process.exit(1);
  }
}

const EXCLUDE_DIRS = new Set(['node_modules', '.git']);

function collect(dir, relFolder, zip) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      const childFolder = relFolder ? relFolder + '/' + entry.name : entry.name;
      collect(abs, childFolder, zip);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.nnzplugin')) continue;
      // adm-zip: addLocalFile(localPath, zipFolderPath, zipEntryName)
      zip.addLocalFile(abs, relFolder, entry.name);
    }
  }
}

mkdirSync(outDir, { recursive: true });
if (existsSync(outFile)) {
  try { rmSync(outFile); } catch (e) { /* overwritten below anyway */ }
}

const zip = new AdmZip();
collect(srcDir, '', zip);

if (!zip.getEntries().length) {
  console.error(`[build-plugin] Tidak ada file untuk dikemas dari ${srcDir}.`);
  process.exit(1);
}

zip.writeZip(outFile);

const size = statSync(outFile).size;
console.log(`[build-plugin] ${name}`);
console.log(`[build-plugin] output : ${outFile}`);
console.log(`[build-plugin] ukuran : ${size} byte (${(size / 1024).toFixed(1)} KB)`);
console.log(`[build-plugin] isi    : ${zip.getEntries().map((e) => e.entryName).join(', ')}`);
