# 06 — Photoshop integration

> **Read this first.** The integration described here is implemented and unit-tested
> as a *translation layer*. It has **not** been executed inside Photoshop in this
> environment, because no Photoshop host exists here. Nothing in this repository
> claims otherwise, and the test suite fails if a manifest or doc ever claims it was
> "tested in Photoshop".

## How the plugin runs

`manifest.json` declares one panel entrypoint at `index.html`, minimum size 320×480,
host Photoshop 24.2+. `index.html` loads `src/ui/main.js` as an ES module and nothing
else — no remote assets, no inline scripts (UXP's CSP forbids them), and
`tools/validate-plugin.js` enforces both.

At boot:

1. `probeHost()` tries `require('photoshop')`. Outside Photoshop it reports
   `unavailable` and the panel runs in **preview mode** with a synthetic portrait, so
   the UI is never dead and never pretends to be connected.
2. Inside Photoshop, `captureDocument()` reads the active document into a `Frame` at a
   preview-safe size and records the scale factor.
3. Every stage runs on that frame; the panel shows a real before/after.
4. **Apply stage** adds the stage to the session (still nothing written to the
   document). **Build Photoshop layers** replays the whole stack.

## Panel loading, and the module-compatibility issue

The panel is shipped as **one classic script**, `panel.js`, loaded with:

```html
<script src="panel.js"></script>
```

Not `<script type="module">`. This is deliberate and it is load-bearing.

The source is 43 ES modules, which is right for development. Shipping them as a module
graph, however, depends on the host providing module semantics. Any host that treats
the entry as a plain script throws

```
SyntaxError: Cannot use import statement outside a module
```

on the first `import`, and the panel renders empty — with no error a user could act on.
That failure mode was reproduced against the built file during development, not
assumed.

Since Photoshop's UXP runtime cannot be exercised in this environment, the dependency
was removed rather than trusted:

- `tools/build-plugin.js` compiles the module graph into one IIFE with a small module
  registry. Each module keeps its **own scope** — two modules in this codebase export
  `maskCoverage`, so a flat concatenation would be a syntax error — and the graph is
  resolved depth-first, with import cycles reported rather than silently producing
  undefined bindings.
- The build then parses the result with `vm.Script` (non-module grammar) and fails if
  any `import`/`export` survives.
- `tests/packaging.test.js` repeats both checks against the **packaged zip**, then
  boots the packaged bytes and asserts that all seven studios render.

The readable `src/` tree still ships inside `plugin/` for reference. It is inert: the
panel never loads it.

## Permissions

The manifest requests exactly one permission:

```json
"requiredPermissions": { "localFileSystem": "fullAccess" }
```

`localFileSystem` is needed because committing a stage writes temporary PNGs via
`uxp.storage.localFileSystem.getTemporaryFolder()` before `placeEvent` places them.

An earlier revision also declared `"network": { "domains": [] }`. Adobe's UXP schema
requires `domains` to be a non-empty `string[]` or `"all"`, so that declaration was both
invalid and unnecessary — the plugin makes no network requests at all. It has been
removed, and `tools/validate-plugin.js` now rejects an empty domain list and also flags
a network permission declared without any network code in `src/`.

## Capture

`src/photoshop/capture.js` uses `imaging.getPixels` in a modal scope, converting
Photoshop's document coordinate space into the plugin's planar `Frame`. It:

- never modifies the document,
- respects the document's colour profile as delivered by the host (no colour-managed
  conversion is invented),
- returns a `scale` so every mask and radius can be mapped back to document pixels,
- throws with a readable message if the document has no pixel data or is 32-bit.

## Commit

`PhotoshopLayerManager.runPipeline(records)` walks the layer records top-down and
creates, per record:

| Record | Photoshop action |
|---|---|
| `group` | `make` layerSection → group, named, opacity and blend mode applied |
| `pixel` | `make` pixel layer + `placeEvent` of the encoded frame (PNG), then blend mode, opacity, clipping |
| `adjustment` | `make` adjustment layer from a descriptor (curves, levels, hue/sat, colour balance, vibrance, selective colour, gradient map) |
| `solid` | `make` solid colour fill layer |
| mask | real layer mask from the coverage mask if the host accepts the descriptor, otherwise the mask is **baked into the layer pixels** |

Baking is a deliberate fallback: a committed layer that does not match the preview
would be worse than no mask at all. The run report says which path was used for each
layer, so the retoucher knows whether the mask is editable.

Everything is wrapped in `executeAsModal` with a single history state
(`Photografix Skin Studio — build layers`), so one Ctrl+Z removes the whole commit.

Hard limits enforced before any Photoshop call:

- **60 layers per run** — a larger stack is refused with an explicit message rather
  than half-built.
- **The original layer is never touched.** Records only ever add groups; no flatten,
  no merge, no delete.
- **Names are unique** across the stack (asserted by tests), so Photoshop's automatic
  renaming never silently merges two layers with the same name.

## The parity contract

The panel preview is *rendered from the same records* the bridge will replay
(`renderStack`). A test requires, for every engine, that
`renderStack(result.layers, input)` equals `result.preview` to within half a level.
Current drift is **0.00** for all eight engines.

That is the only honest way to claim "what you see is what Photoshop will build"
without running Photoshop: the bridge is a second interpreter of a data structure
whose reference interpretation is pinned by tests.

## Blend-mode translation

`image/blend.js` keeps the mode table and its Photoshop enum names side by side, and a
test walks `MODES` against `PHOTOSHOP_BLEND_NAMES` so a mode can never silently fall
back to Normal. The modes the engines actually use are `normal`, `linearLight`,
`softLight`; the rest are supported for future engines and for hand-built stacks.

## What remains unverified until someone opens Photoshop

Be specific about this, because it is where bugs will be:

1. **Mask descriptor acceptance** across Photoshop versions — the bake fallback exists
   for this reason and needs a real run to confirm which path each version takes.
2. **`placeEvent` performance** with large frames and many layers.
3. **Color profile handling** — whether captured pixels round-trip to the document
   without a shift on wide-gamut/32-bit documents.
4. **Panel layout** at the declared minimum size inside Photoshop's docked panel
   chrome (the browser harness and the headless UI tests cover behaviour, not pixels).
5. **Modal execution timing** on very large documents.

Each is listed in `docs/09-testing.md` as an open verification item rather than being
quietly assumed.
