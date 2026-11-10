/**
 * Packaging tests.
 *
 * These run against the artefact a user actually downloads - the zip in
 * artifacts/dist - rather than against the working tree. A plugin can pass every
 * unit test while the package is unloadable, and that is exactly what happened
 * here: the panel was shipped as `<script type="module">` over 43 ES modules, so
 * any host reading it as a plain script threw
 *   SyntaxError: Cannot use import statement outside a module
 * and showed an empty panel with nothing the user could act on.
 *
 * The build now compiles the module graph into one classic script. These tests
 * prove the shipped file is that, and that it boots.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Script } from 'node:vm';
import { createDocument, mountIndexHtml, installGlobals } from './support/dom.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'artifacts', 'dist');
const releaseZip = join(dist, 'Photografix-Skin-Studio-AI-Free-Core-v1.0.0.zip');

const build = () =>
  execFileSync(process.execPath, [join(root, 'tools', 'build-release.js')], { cwd: root, stdio: 'pipe' });

/** Unpacks the release zip and returns a reader for its entries. */
const unpackRelease = () => {
  if (!existsSync(releaseZip)) build();
  assert.ok(existsSync(releaseZip), 'the release zip was not produced');

  const scratch = join(tmpdir(), `photografix-release-${process.pid}-${Date.now()}`);
  execFileSync('unzip', ['-q', releaseZip, '-d', scratch]);
  const listing = execFileSync('unzip', ['-Z1', releaseZip], { encoding: 'utf8' }).split('\n').filter(Boolean);
  return { scratch, listing };
};

test('the release package exists and has the published name', () => {
  if (!existsSync(releaseZip)) build();
  assert.ok(existsSync(releaseZip), 'Photografix-Skin-Studio-AI-Free-Core-v1.0.0.zip is missing');
});

test('the release zip is valid and its layout is what UXP Developer Tool expects', () => {
  const { scratch, listing } = unpackRelease();

  // A corrupt zip would still "exist", so integrity is checked explicitly.
  execFileSync('unzip', ['-t', releaseZip], { stdio: 'pipe' });

  const entries = listing.map((l) => l.replace(/^[^/]+\//, ''));
  const required = [
    'plugin/manifest.json',
    'plugin/index.html',
    'plugin/panel.js',
    'INSTALL.txt',
    'LICENSE',
  ];
  for (const path of required) {
    assert.ok(entries.includes(path), `release is missing ${path}`);
  }

  // Icons declared by the manifest must be present at their declared paths.
  const manifest = JSON.parse(readFileSync(join(scratch, 'Photografix-Skin-Studio-AI-v1.0.0', 'plugin', 'manifest.json'), 'utf8'));
  for (const icon of manifest.icons || []) {
    assert.ok(entries.includes(`plugin/${icon.path}`), `declared icon ${icon.path} is not in the package`);
  }

  // Everything must sit under the single top-level folder; nothing may escape it.
  for (const entry of listing.filter((l) => !l.endsWith('/'))) {
    assert.equal(entry.includes('..'), false, `path traversal in package: ${entry}`);
  }
  const topLevel = new Set(listing.map((l) => l.split('/')[0]));
  assert.equal(topLevel.size, 1, `expected one top-level folder, found: ${[...topLevel].join(', ')}`);
});

test('the shipped panel.js is a classic script, not a module', () => {
  const { scratch } = unpackRelease();
  const pluginDir = join(scratch, 'Photografix-Skin-Studio-AI-v1.0.0', 'plugin');
  const panel = readFileSync(join(pluginDir, 'panel.js'), 'utf8');

  // Parsing with vm.Script uses non-module grammar: any surviving import/export
  // throws here, which is the exact failure mode that produced a blank panel.
  assert.doesNotThrow(() => new Script(panel, { filename: 'panel.js' }),
    'panel.js does not parse as a classic script');
  assert.equal(/^\s*(?:import|export)\s/m.test(panel), false, 'panel.js still contains module syntax');

  // index.html must reference panel.js and must not request module semantics.
  const html = readFileSync(join(pluginDir, 'index.html'), 'utf8');
  assert.match(html, /<script src="panel\.js"><\/script>/, 'index.html does not load panel.js as a classic script');
  assert.equal(/type=["']module["']/.test(html), false, 'index.html still requests module semantics');

  // UXP's CSP forbids inline scripts.
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(html), false, 'inline script found under UXP CSP');
});

test('the shipped panel.js actually boots the interface', async () => {
  const { scratch } = unpackRelease();
  const pluginDir = join(scratch, 'Photografix-Skin-Studio-AI-v1.0.0', 'plugin');
  const panel = readFileSync(join(pluginDir, 'panel.js'), 'utf8');

  // Run it in an isolated context whose globals are the headless DOM, so this is
  // the shipped bytes executing - not the source tree, and not a re-bundle.
  const doc = createDocument();
  installGlobals(doc);
  // The panel queries #tabs etc. by id, so the markup has to be mounted first.
  mountIndexHtml(doc, readFileSync(join(pluginDir, 'index.html'), 'utf8'));
  const sandbox = {
    document: doc,
    window: globalThis.window,
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
  };
  const context = (await import('node:vm')).createContext(sandbox);
  try {
    new Script(panel, { filename: 'panel.js' }).runInContext(context);
  } catch (err) {
    assert.fail(`the shipped panel.js threw on load: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 800));

  const tabs = doc.getElementById('tabs');
  assert.ok(tabs, 'the panel did not render a tab strip');
  assert.equal(tabs.querySelectorAll('.tab').length, 7, 'the shipped panel did not render all seven studios');
  assert.equal(doc.getElementById('workflow-list').querySelectorAll('.workflow__item').length, 7,
    'the shipped panel did not render the seven-stage workflow');
});

test('the release zip does not contain development material', () => {
  const { listing } = unpackRelease();
  const forbidden = /(^|\/)(tests?|tools|node_modules|\.git|artifacts)\//;
  const leaked = listing.filter((l) => forbidden.test(l.replace(/^[^/]+\//, '')));
  assert.deepEqual(leaked, [], `development files leaked into the release: ${leaked.join(', ')}`);
});
