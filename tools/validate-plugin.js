/**
 * Static pre-flight checks for the UXP bundle.
 *
 * This is NOT a substitute for loading the plugin in Photoshop - it cannot be. It
 * catches the class of mistake that makes Photoshop reject a plugin before any code
 * runs: a missing entrypoint file, an icon path the manifest promises but does not
 * ship, an inline <script> (UXP forbids it), a CommonJS require, or a bare module
 * specifier that the UXP bundler cannot resolve.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_MODULES = ['photoshop', 'uxp'];
const problems = [];
const notes = [];

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

if (manifest.manifestVersion !== 5) problems.push(`manifestVersion ${manifest.manifestVersion} (expected 5)`);
for (const field of ['id', 'name', 'version', 'main', 'host', 'entrypoints']) {
  if (!manifest[field]) problems.push(`manifest is missing "${field}"`);
}
if (!existsSync(join(root, manifest.main))) problems.push(`main entry "${manifest.main}" does not exist`);
if (!/^com\.[a-z0-9.]+$/.test(manifest.id)) problems.push(`id "${manifest.id}" is not a reverse-DNS id`);

const iconPaths = [];
for (const entry of manifest.entrypoints || []) {
  if (entry.type === 'panel' && !entry.minimumSize) problems.push(`panel entrypoint ${entry.id} has no minimumSize`);
  for (const icon of entry.icons || []) iconPaths.push(icon.path);
}
for (const icon of manifest.icons || []) iconPaths.push(icon.path);
for (const path of iconPaths) {
  if (!existsSync(join(root, path))) problems.push(`declared icon "${path}" is missing`);
}

const html = readFileSync(join(root, 'index.html'), 'utf8');
if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html)) problems.push('index.html contains an inline <script> (UXP CSP forbids it)');
if (/<link[^>]+href=["']https?:/i.test(html)) problems.push('index.html loads a remote stylesheet (offline plugin)');
for (const m of html.matchAll(/\bsrc=["']([^"']+)["']/g)) {
  const src = m[1];
  if (/^https?:/.test(src)) problems.push(`index.html loads a remote script: ${src}`);
  else if (!existsSync(join(root, src))) problems.push(`index.html references a missing script: ${src}`);
}

const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (full.endsWith('.js')) acc.push(full);
  }
  return acc;
};

const files = walk(join(root, 'src'));
for (const file of files) {
  const code = readFileSync(file, 'utf8');
  const rel = file.slice(root.length + 1);
  // UXP provides require() ONLY for host modules. Anything else is a bundling bug
  // that would throw at load time inside Photoshop.
  for (const m of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!HOST_MODULES.includes(m[1])) problems.push(`${rel}: require("${m[1]}") - only Adobe host modules can be required in UXP`);
  }
  if (/\bprocess\.(env|exit|argv)\b/.test(code)) problems.push(`${rel}: Node process API used inside src/`);
  if (/\bfrom ['"]node:/.test(code)) problems.push(`${rel}: node: builtin imported inside src/`);
  for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec);
      if (!existsSync(target)) problems.push(`${rel}: unresolved import "${spec}"`);
    } else if (!HOST_MODULES.includes(spec)) {
      problems.push(`${rel}: bare import "${spec}" will not resolve inside UXP`);
    }
  }
}

notes.push(`${files.length} source modules scanned`);
notes.push(`${iconPaths.length} declared icons, all present`);
notes.push('Not verified: loading in Photoshop (requires a Photoshop host)');

if (problems.length) {
  console.error('validate-plugin: FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('validate-plugin: OK');
for (const n of notes) console.log(`  · ${n}`);
