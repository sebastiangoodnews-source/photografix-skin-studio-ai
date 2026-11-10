/**
 * Builds the user-facing deliverable: the release folder and the published zip.
 *
 * What a user downloads is not the repository. It is one folder containing the
 * plugin in the layout UXP Developer Tool expects, the install instructions, the
 * licence, the reference docs and a preview they can open in a browser without
 * Photoshop:
 *
 *   Photografix-Skin-Studio-AI-v1.0.0/
 *     plugin/                 <- select plugin/manifest.json in UXP Developer Tool
 *       manifest.json
 *       index.html
 *       panel.js
 *       icons/
 *       src/
 *     INSTALL.txt
 *     LICENSE
 *     RELEASE_NOTES_v1.0.0.md
 *     panel-preview.html
 *     docs-*.md
 *
 * The zip is named after the release, not after the folder, because the published
 * asset name is what people quote in support threads.
 */
import { readFileSync, mkdirSync, existsSync, statSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;

export const RELEASE_FILE = `Photografix-Skin-Studio-AI-Free-Core-v${version}.zip`;
export const RELEASE_DIR = `Photografix-Skin-Studio-AI-v${version}`;

const dist = join(root, 'artifacts', 'dist');
const pluginZip = join(dist, `photografix-skin-studio-${version}.zip`);

const rmrf = (dir) => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) rmrf(full);
    else execFileSync('rm', ['-f', full]);
  }
  execFileSync('rmdir', [dir]);
};

const mb = (path) => (statSync(path).size / 1024).toFixed(0);

export const buildRelease = ({ quiet = false } = {}) => {
  // 1. Build (and verify) the plugin bundle first.
  execFileSync(process.execPath, [join(root, 'tools', 'build-plugin.js')], {
    cwd: root,
    stdio: quiet ? 'pipe' : 'inherit',
  });
  if (!existsSync(pluginZip)) throw new Error('plugin bundle was not produced by build-plugin.js');

  // 2. Lay out the release folder from a clean slate.
  const stage = join(dist, RELEASE_DIR);
  rmrf(stage);
  mkdirSync(stage, { recursive: true });

  // Unpack into a scratch directory and lift the package's top folder. Unpacking
  // straight into stage/plugin/ and then moving things inside the release folder is
  // how an empty plugin-files/ directory once ended up inside the shipped zip; a
  // scratch dir plus an assertion is harder to get wrong.
  const scratch = join(dist, '.unpack');
  rmrf(scratch);
  mkdirSync(scratch, { recursive: true });
  execFileSync('unzip', ['-q', pluginZip, '-d', scratch]);
  execFileSync('mv', [join(scratch, `photografix-skin-studio-${version}`), join(stage, 'plugin')]);
  rmrf(scratch);

  if (!existsSync(join(stage, 'plugin', 'manifest.json'))) {
    throw new Error('release layout is wrong: plugin/manifest.json must sit at the root of plugin/');
  }

  // 3. User-facing material, flattened so the folder reads as a release not a repo.
  const docs = [
    'docs/03-skin-science.md',
    'docs/04-tool-reference.md',
    'docs/05-workflow-guide.md',
    'docs/06-photoshop-integration.md',
    'docs/09-testing.md',
  ];
  const extras = [...docs, 'INSTALL.txt', 'LICENSE', `RELEASE_NOTES_v${version}.md`];
  for (const file of extras) {
    if (!existsSync(join(root, file))) continue;
    copyFileSync(join(root, file), join(stage, file.replace('/', '-')));
  }

  const preview = join(dist, `photografix-skin-studio-${version}-panel-preview.html`);
  if (existsSync(preview)) copyFileSync(preview, join(stage, 'panel-preview.html'));

  // 4. Zip. -X keeps out local timestamps/uid noise so the artefact is reproducible.
  const releaseZip = join(dist, RELEASE_FILE);
  if (existsSync(releaseZip)) execFileSync('rm', ['-f', releaseZip]);
  execFileSync('zip', ['-q', '-r', '-X', releaseZip, RELEASE_DIR], { cwd: dist });

  if (quiet) return { releaseZip };
  console.log('\nbuild-release: OK');
  console.log(`  package     artifacts/dist/${RELEASE_FILE}   ${mb(releaseZip)} KB`);
  console.log(`  plugin zip  artifacts/dist/photografix-skin-studio-${version}.zip   ${mb(pluginZip)} KB`);
  console.log(`  install dir ${RELEASE_DIR}/plugin/  (${readdirSync(join(stage, 'plugin')).length} entries at root)`);
  console.log('  next        load plugin/ in UXP Developer Tool > Add Plugin');
  return { releaseZip };
};

// Run directly for `npm run release`.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRelease();
}
