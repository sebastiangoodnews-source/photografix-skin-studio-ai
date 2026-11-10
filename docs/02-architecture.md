# 02 — Architecture

## Layering

```
index.html + src/ui/            panel, preview, forms  (view only)
        │
        ▼
src/core/workflow/orchestrator.js    the session: document, stage stack, composite
        │
        ▼
src/core/engines/*.js                8 engines: pure Frame in → LayerRecord[] + preview
        │
        ├── src/core/image/          frame, colours, filters, morphology, blend modes
        ├── src/core/analysis/       histogram, skin, connected components, regions
        ├── src/core/segmentation/   face + body detection
        ├── src/core/regions/        region resolver (face/neck/chest/arms/legs/custom)
        ├── src/core/masks/          mask algebra and protect-first mask builders
        └── src/core/layers/         layer records + the stack renderer
        │
        ▼
src/photoshop/*                       capture, and the record → batchPlay bridge
```

The important boundary is between `core/engines` and `photoshop/`. Engines never
talk to Photoshop. They return **layer records** — plain data — and both the panel
preview and the Photoshop bridge interpret that same data. There is exactly one
description of what a stage does, which is what makes the preview trustworthy.

## The engine contract

```js
engine.run(frame, settings, context) → {
  layers,        // LayerRecord[] — what Photoshop will build
  preview,       // Frame — ALWAYS renderStack(layers, frame), never an ad-hoc image
  mask,          // the coverage mask, for the overlay and for brushing
  analysis,      // what the engine measured (radii, regions, match distances)
  report,        // what the engine did, in human terms, for the panel
  safeguardReport,
}
```

`ProcessingEngine` (in `engines/common.js`) wraps every engine and guarantees:

1. **Settings are validated against the engine's own schema** before processing, so a
   stale preset or an out-of-range value cannot reach the maths.
2. **No NaN or Infinity can escape** into a layer (`sanitiseFrame`).
3. **The preview is not altered after the fact.** Per-pixel magnitude limits live
   inside each engine, where the meaning of "too much" is known. The wrapper only
   *reports* how far the run moved.

That third point is a deliberate correction of an earlier design: clamping the
composite after the fact silently desynchronised the preview from the layer stack.
See `docs/09-testing.md` for the parity check that now prevents a regression.

## The session

`WorkflowSession` owns:

- the document frame (immutable for the life of the session),
- an ordered list of stages, each with its settings, layer records, output frame,
  analysis and report,
- the shared `RegionResolver` analysis, computed once per document,
- the composite, recomputed lazily.

Guarantees enforced by tests:

- **A stage's input is the composite of the stages below it.** Disabling a stage sends
  its output back to its own source, not to black.
- **`updateStage` re-runs the stage and every stage above it**, so the stack is never
  internally inconsistent.
- **`removeStage` on every stage returns the exact original**, pixel for pixel.
- **The original frame is never mutated** by any engine (each engine clones before
  writing).

## Layer records

A `LayerRecord` is a plain object:

```js
{ type: 'group'|'pixel'|'adjustment'|'solid', id, name, mask, opacity, blendMode,
  visible, children, note }
```

`layers/render.js` is the reference interpreter. `photoshop/layerManager.js` is a
second interpreter of the same records. The test suite asserts that they agree by
requiring every engine's `preview` to equal `renderStack(layers, input)` exactly
(tolerance 0.5 level, currently 0.00 for all eight engines).

## Data flow of one stage

1. Panel collects settings from the schema-driven form.
2. `session.runStage()` validates them against the engine schema.
3. The engine reads the composite of lower stages plus shared analysis.
4. The engine returns layer records; `PreviewView` renders them at preview scale.
5. `commitToPhotoshop()` replays the *same records* as live groups in Photoshop.

## Configuration

- `src/config/settings.js` — core safeguards and preview quality (single source).
- `src/config/presets.js` — mode descriptions, sculpt/gloss/intensity presets, grade
  families, stage order.

No processing value is hard-coded in the UI. Panels render themselves from
`engine.schema`.

## Files that must stay in sync

| Change | Also update |
|---|---|
| New engine | `engines/registry.js`, `config/presets.js` `STAGE_ORDER`, `ui/panel.js` `PANEL_DEFS` |
| New blend mode | `image/blend.js` `MODES` **and** `PHOTOSHOP_BLEND_NAMES` (test asserts both) |
| New adjustment type | `layers/render.js` `ADJUSTMENTS` **and** `layerManager.adjustmentDescriptor` |
| New region | `regions/zones.js` `REGION_IDS` and every engine's region enum |

The registry is the single list the tests iterate, so an engine that is added but not
wired up fails the suite rather than shipping half-connected.
