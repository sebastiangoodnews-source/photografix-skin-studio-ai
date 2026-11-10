/**
 * Builds the user-facing deliverable: a release folder and zip containing the plugin
 * source (in the layout UXP Developer Tool expects), the install instructions, the
 * licence and the panel preview, so a retoucher can install it without reading the
 * repository.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const folder = `photografix-skin-studio-${manifest.version}`;
const dist = join(root, 'artifacts', 'dist');
const pluginZip = join(dist, `${folder}.zip`);

execFileSync(process.execPath, [join(root, 'tools', 'build-plugin.js')], { cwd: root, stdio: 'inherit' });
if (!existsSync(pluginZip)) throw new Error('plugin bundle was not produced');

const stage = join(dist, `${folder}-release`);
const rmrf = (dir) => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) rmrf(f);
    else execFileSync('rm', ['-f', f]);
  }
  execFileSync('rmdir', [dir]);
};
rmrf(stage);
mkdirSync(join(stage, 'plugin'), { recursive: true });

// unpack the verified plugin bundle into the release folder
execFileSync('unzip', ['-q', pluginZip, '-d', join(stage, 'plugin')]);
execFileSync('mv', [join(stage, 'plugin', folder), join(stage, 'plugin', 'photografix-skin-studio')]);

for (const file of ['LICENSE', 'docs/04-tool-reference.md', 'docs/05-workflow-guide.md', 'docs/03-skin-science.md', 'docs/09-testing.md']) {
  if (existsSync(join(root, file))) execFileSync('cp', [join(root, file), join(stage, file.replace('/', '-'))]);
}
const preview = join(dist, `${folder}-panel-preview.html`);
if (existsSync(preview)) execFileSync('cp', [preview, join(stage, 'panel-preview.html')]);

writeFileSync(join(stage, 'INSTALL.txt'), readFileSync(join(root, 'INSTALL.txt'), 'utf8'));

const releaseZip = join(dist, `${folder}-release.zip`);
if (existsSync(releaseZip)) execFileSync('rm', ['-f', releaseZip]);
execFileSync('zip', ['-q', '-r', '-X', releaseZip, `${folder}-release`], { cwd: dist });

const kb = (p) => (statSync(p).size / 1024).toFixed(0);
console.log('\nbuild-release: OK');
console.log(`  plugin only   artifacts/dist/${folder}.zip            ${kb(pluginZip)} KB`);
console.log(`  full release  artifacts/dist/${folder}-release.zip    ${kb(releaseZip)} KB`);
console.log(`  release dir   artifacts/dist/${folder}-release/`);
