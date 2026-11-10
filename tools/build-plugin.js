/**
 * Builds the distributable plugin bundle.
 *
 * What ships is exactly what Photoshop loads: manifest.json, index.html, src/ and
 * icons/. Everything else in the repo (tests, tools, artifacts, docs) is development
 * material and is left out.
 *
 * The important part is the second half of this script: after writing the zip it
 * re-reads the archive and validates it as a *bundle*, not as a working tree. A path
 * that resolves during development can still be broken in the zip - for example an
 * import reaching up out of src/ into tools/. That exact bug existed here, so the
 * check is not hypothetical.
 */
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const name = `photografix-skin-studio-${version}`;
const outDir = join(root, 'artifacts', 'dist');
const outFile = join(outDir, `${name}.zip`);
const staging = join(outDir, name);

const SHIP = ['manifest.json', 'index.html', 'src', 'icons'];
const HOST_MODULES = ['photoshop', 'uxp'];

const problems = [];

// ---------------------------------------------------------------------------
// 1. Stage
// ---------------------------------------------------------------------------
const rmrf = (dir) => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) rmrf(full);
    else execFileSync('rm', ['-f', full]);
  }
  execFileSync('rmdir', [dir]);
};

rmrf(staging);
mkdirSync(staging, { recursive: true });
for (const entry of SHIP) {
  if (!existsSync(join(root, entry))) {
    problems.push(`required bundle entry missing from the repo: ${entry}`);
    continue;
  }
  execFileSync('cp', ['-R', join(root, entry), join(staging, entry)]);
}

// ---------------------------------------------------------------------------
// 2. Validate the staged bundle as if it were already installed
// ---------------------------------------------------------------------------
const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
};

const stagedFiles = walk(staging);
const rel = (f) => posix.join(...f.slice(staging.length + 1).split(/[\\/]/));

// every declared icon must exist inside the bundle
const iconPaths = [
  ...(manifest.icons || []).map((i) => i.path),
  ...(manifest.entrypoints || []).flatMap((e) => (e.icons || []).map((i) => i.path)),
];
for (const path of iconPaths) {
  if (!existsSync(join(staging, path))) problems.push(`manifest declares "${path}" but the bundle does not contain it`);
}

// main entry must exist
if (!existsSync(join(staging, manifest.main || ''))) problems.push(`manifest main "${manifest.main}" is missing from the bundle`);

// index.html must not reference anything outside the bundle
const htmlPath = join(staging, manifest.main || 'index.html');
if (existsSync(htmlPath)) {
  const html = readFileSync(htmlPath, 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html)) problems.push('index.html contains an inline <script> (UXP CSP forbids it)');
  for (const m of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    const target = m[1];
    if (/^(https?:|data:|#|mailto:)/.test(target)) {
      if (/^https?:/.test(target)) problems.push(`index.html loads a remote asset: ${target}`);
      continue;
    }
    if (!existsSync(join(staging, target))) problems.push(`index.html references "${target}", which is not in the bundle`);
  }
}

// every relative import inside the bundle must resolve INSIDE the bundle
for (const file of stagedFiles.filter((f) => f.endsWith('.js'))) {
  const code = readFileSync(file, 'utf8');
  const from = rel(file);
  for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      const target = posix.normalize(posix.join(posix.dirname(from), spec));
      if (target.startsWith('..')) {
        problems.push(`${from}: imports "${spec}" which escapes the bundle - the shipped plugin would fail to load`);
      } else if (!stagedFiles.some((f) => rel(f) === target)) {
        problems.push(`${from}: imports "${spec}" (${target}) which is not in the bundle`);
      }
    } else if (!HOST_MODULES.includes(spec)) {
      problems.push(`${from}: bare import "${spec}" will not resolve inside UXP`);
    }
  }
  for (const m of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!HOST_MODULES.includes(m[1])) problems.push(`${from}: require("${m[1]}") is not a host module`);
  }
}

// the bundle must not ship development material
for (const file of stagedFiles) {
  const r = rel(file);
  if (/^(tests?|tools|artifacts|docs)\//.test(r) || r.startsWith('.')) problems.push(`development file leaked into the bundle: ${r}`);
}

// ---------------------------------------------------------------------------
// 3. Zip
// ---------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
if (existsSync(outFile)) execFileSync('rm', ['-f', outFile]);
execFileSync('zip', ['-q', '-r', '-X', outFile, name], { cwd: outDir });

// ---------------------------------------------------------------------------
// 4. Verify the archive round-trips
// ---------------------------------------------------------------------------
const listing = execFileSync('unzip', ['-Z1', outFile], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
for (const path of iconPaths) {
  if (!listing.includes(`${name}/${path}`)) problems.push(`icon "${path}" is not present in the generated zip`);
}
const manifestInZip = listing.includes(`${name}/manifest.json`);
if (!manifestInZip) problems.push('manifest.json is not at the root of the zip - UXP will reject the package');
const escaped = listing.filter((p) => !p.startsWith(`${name}/`) || p.split('/').includes('..'));
if (escaped.length) problems.push(`zip contains paths outside the plugin folder: ${escaped.slice(0, 5).join(', ')}`);

const zipBytes = statSync(outFile).size;
const totalBytes = stagedFiles.reduce((acc, f) => acc + statSync(f).size, 0);

if (problems.length) {
  console.error('build-plugin: FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('build-plugin: OK');
console.log(`  bundle   ${posix.join('artifacts', 'dist', `${name}.zip`)}`);
console.log(`  files    ${stagedFiles.length} (${(totalBytes / 1024).toFixed(0)} KB uncompressed, ${(zipBytes / 1024).toFixed(0)} KB zipped)`);
console.log(`  contents ${SHIP.join(', ')}`);
console.log('  verified manifest, icons, index.html references, and every import resolves inside the bundle');
console.log('  NOT verified: loading the plugin in Photoshop (no host in this environment)');

// A single-file, self-contained HTML build is handy for a quick look at the panel
// without unzipping anything, so it is emitted alongside the plugin.
writeFileSync(join(outDir, `${name}-panel-preview.html`), buildSingleFilePreview());
console.log(`  preview  ${posix.join('artifacts', 'dist', `${name}-panel-preview.html`)} (double-click to open the panel in a browser)`);

/**
 * Builds a single self-contained HTML file so the panel can be opened directly in a
 * browser (no dev server, no unzip).
 *
 * This is not a naive concatenation. Every module is wrapped in its own function
 * scope with an explicit export object, because two modules in this codebase export
 * the same identifier (both `analysis/skin.js` and `masks/masks.js` export
 * `maskCoverage`, and one re-exports `softThreshold`); flattening them into one scope
 * is a syntax error. The import graph is resolved depth-first so dependencies are
 * defined before their dependents, and a cycle is reported rather than silently
 * producing a file whose bindings are undefined at call time.
 *
 * The generated file is executed by the UI test suite against the headless DOM, so a
 * broken preview fails the build rather than shipping.
 */
function buildSingleFilePreview() {
  const entry = resolve(root, 'src', 'ui', 'main.js');
  const seen = new Set();
  const order = [];
  const stack = [];
  const cycles = [];

  const visit = (file) => {
    if (seen.has(file)) return;
    if (stack.includes(file)) {
      cycles.push([...stack.slice(stack.indexOf(file)), file]);
      return;
    }
    stack.push(file);
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), m[1]);
      if (existsSync(target)) visit(target);
    }
    stack.pop();
    seen.add(file);
    order.push(file);
  };
  visit(entry);
  if (cycles.length) {
    throw new Error(`preview build: import cycle(s) detected, bindings would be undefined at call time: ${cycles.map((c) => c.map((f) => f.slice(root.length + 1)).join(' -> ')).join('; ')}`);
  }

  const moduleId = (file) => posix.join(...file.slice(root.length + 1).split(/[\\/]/));

  const chunks = order.map((file) => {
    const id = moduleId(file);
    let code = readFileSync(file, 'utf8');
    const exports = [];

    // import { a, b as c } from './x.js'  ->  const { a, b: c } = __require('./x.js')
    code = code.replace(/\bimport\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"];?/g, (_, names, spec) => {
      const target = resolve(dirname(file), spec);
      const binding = names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => {
          const [orig, alias] = n.split(/\s+as\s+/).map((x) => x.trim());
          return alias ? `${orig}: ${alias}` : orig;
        })
        .join(', ');
      return `const { ${binding} } = __require(${JSON.stringify(moduleId(target))});`;
    });
    // side-effect import of a relative module
    code = code.replace(/\bimport\s+['"](\.[^'"]+)['"];?/g, (_, spec) => {
      const target = resolve(dirname(file), spec);
      return `__require(${JSON.stringify(moduleId(target))});`;
    });

    code = code.replace(/^\s*export\s+default\s+/gm, 'const __default = ');
    code = code.replace(/^\s*export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?;?/gm, (_, names, spec) => {
      const entries = names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => {
          const [orig, alias] = n.split(/\s+as\s+/).map((x) => x.trim());
          const local = spec ? `__require(${JSON.stringify(moduleId(resolve(dirname(file), spec)))}).${orig}` : orig;
          return `${alias || orig}: ${local}`;
        });
      exports.push(...entries);
      return '';
    });
    code = code.replace(/^\s*export\s+(const|let|var|function|class|async\s+function)\s+([A-Za-z0-9_$]+)/gm, (_, kind, name) => {
      exports.push(`${name}: ${name}`);
      return `${kind} ${name}`;
    });

    if (code.includes('__default')) exports.push(`default: __default`);

    // Adobe host modules are resolved by UXP's own require(); in a browser there is
    // none, and every caller already guards for a null host.
    const body = code.replace(/\brequire\s*\(\s*['"](photoshop|uxp)['"]\s*\)/g, 'null');

    return `/* ---- ${id} ---- */
__define(${JSON.stringify(id)}, function () {
${body}
return { ${exports.join(', ')} };
});`;
  });

  const runtime = `
const __modules = Object.create(null);
const __cache = Object.create(null);
const __define = (id, factory) => { __modules[id] = factory; };
const __require = (id) => {
  if (__cache[id]) return __cache[id];
  const factory = __modules[id];
  if (!factory) throw new Error('module not bundled: ' + id);
  const exports = factory();
  __cache[id] = exports;
  return exports;
};
`;

  const sourceHtml = readFileSync(join(root, 'index.html'), 'utf8');
  const cssPath = join(root, 'src', 'ui', 'styles.css');
  const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
  return sourceHtml
    .replace(/<link[^>]+styles\.css[^>]*>/i, () => `<style>\n${css}\n</style>`)
    .replace(/<script[^>]*src=["'][^"']*main\.js["'][^>]*><\/script>/i, () => `<script type="module">\n${runtime}\n${chunks.join('\n\n')}\n__require(${JSON.stringify(moduleId(entry))});\n</script>`);
}
