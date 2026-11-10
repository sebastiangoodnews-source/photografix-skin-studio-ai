# 07 — Non-destructive layer model

## Why records instead of direct Photoshop calls

If each engine wrote straight into Photoshop, three things would be impossible:
testing without Photoshop, previewing without writing to the document, and guarantee-
ing that the preview matches the commit. Instead, every engine returns plain
`LayerRecord` objects and two interpreters consume them:

- `src/core/layers/render.js` — composites them for the panel preview and is the test
  oracle;
- `src/photoshop/layerManager.js` — replays them as live Photoshop layers.

## Record shape

```js
{
  type: 'group' | 'pixel' | 'adjustment' | 'solid',
  id: 'grp-12',
  name: 'Photografix — Skin Studio · Frequency Separation (Normal)',
  mask: Float32Array | null,      // 0..1 per pixel, document sized
  opacity: 0..100,
  blendMode: 'normal' | 'linearLight' | 'softLight' | 'passThrough' | ...,
  visible: true,
  children: [...],                 // groups only
  frame: Frame,                    // pixel layers only, planar Float32 RGB
  adjustment: { type, ... },       // adjustment layers only
  note: 'human-readable explanation',
  safeguard: false,                // pixel layers: may identity clamping apply?
  blendIf: null | {...},
  clipping: false,
}
```

Records are JSON-serialisable apart from the `frame`/`mask` buffers, which is what
makes the session snapshot (`session.serialize()`) possible: settings and structure are
saved, pixels are recomputed.

## Rules the engines follow

1. **Only add.** No engine returns a flattened frame as a layer, deletes a layer, or
   returns a stack that replaces the document.
2. **One group per run**, named after the stage, so the retoucher can see and toggle
   whole stages.
3. **Every enhancement layer has its own mask** and its own opacity. A stage you cannot
   partially disable is not non-destructive.
4. **Diagnostic layers start hidden or at 0 opacity** (treatment maps, difference maps,
   safety levels) so they contribute nothing until asked.
5. **`preview` must equal `renderStack(layers, input)`** — no exceptions, enforced by
   tests at 0.5 level tolerance.
6. **`safeguard: true` marks a layer that replaces the document's content** (a full
   colour/form reconstruct). Those layers are the only ones subject to identity
   clamping; a dodge/burn or glow layer authored around neutral grey must never be
   clamped, because clamping a 127.5-offset layer to "neutral" destroys it.

Rule 6 is the fix for a real bug: an early version applied magnitude limits to every
pixel layer, which silently flattened sculpt and highlight layers to flat grey.

## Stage composition

```
Session composite = original → stage 1 output → stage 2 output → … → stage 7 output
```

Each stage's input is the composite of the stages below it. Consequences:

- Disabling stage 3 sends stage 3's output back to stage 2's output; stages 4–7
  recompute from there.
- Removing every stage returns the original **bit-exactly** (tested).
- Running a single stage on a fresh document is a supported, tested path — no stage
  requires another to have run first.

## Layer stack shape

```
Photografix — Skin Studio · Final Review        (group)
Photografix — Skin Studio · Photografix Glossy Skin (group)
   Glow, Facial highlights, Body highlights, Lips, Contour
Photografix — Skin Studio · Colour Grading      (group)
   curves / colour balance / hue-sat / gradient map
Photografix — Skin Studio · African Skin Tone Studio (group)
Photografix — Skin Studio · Sculpt Dodge & Burn (group)
Photografix — Skin Studio · Micro Dodge & Burn  (group)
Photografix — Skin Studio · Frequency Separation (Normal) (group)
   Texture (detail), Colour (low frequency), Complexion curves
[ original document layers, untouched ]
```

## Masks

- All masks are `Float32Array` at document size, 0..1.
- `refineMask` applies feather / expand / smooth / speckle removal.
- `featherMask` **clips inward only** — it can shrink coverage but never grow it
  beyond the original mask. This is what stops a corrected mask halo from painting
  brightness onto hair and background.
- Mask algebra (`unionMasks`, `intersectMasks`, `scaleMask`, `invertMask`, `addMasks`,
  `rectMask`, `dabMask`, `tonalMask`) is pure and tested.

## Brushability

Every engine records the brush size, softness and flow it would use, on the layer note.
The masks are real masks, so a retoucher can paint them with those settings — or with
their own — without re-running anything.

## Session snapshots

`session.serialize()` stores core settings plus, per stage: id, order, stage, tool,
engine id, label, enabled, group opacity and settings. `session.restore(snapshot)`
re-runs the pipeline against whatever document is loaded. Pixels are never stored, so a
snapshot is a few kilobytes and cannot go stale.
