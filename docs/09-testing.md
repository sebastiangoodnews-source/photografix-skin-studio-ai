# 09 — Testing and verification

## The honest summary

- **102 automated tests pass** (`npm test`), covering the maths, the analysis, all eight
  engines, the workflow session, the panel UI, and the Photoshop *translation* layer.
- **The plugin has not been run inside Photoshop.** No Photoshop host exists in this
  environment. Every test that concerns the host asserts that the bridge *fails
  cleanly* without one, and a dedicated test fails the build if any manifest or shipped
  string ever claims otherwise.
- **102 tests are not 102% coverage of the risk.** The open items at the bottom of this
  page are the ones that only a real Photoshop run can close.

```bash
npm test           # 102 tests
npm run validate   # static UXP pre-flight: manifest, icons, imports, CSP
npm run render     # 8 scenarios × 8 engines, writes artifacts/render-sheet.tsv
npm run harness    # browser harness on :4173 for hands-on checks
```

## What each suite proves

### `tests/core.image.test.js` (13 test blocks)
Frame safety (immutable clone, deep copy, exact RGBA round-trip, resize of flat
fields), blur behaviour, colour-space round-trips within one level (including deep
skin), blend-mode semantics, morphology, and deterministic math.

Two of these are load-bearing for image quality:

- **Linear Light reconstruction:** the pair `(low, (original−low)/2 + 127.5)` rebuilt
  through Linear Light returns the original exactly. This pins the frequency-separation
  maths and the 127.5 neutral point. (128 would introduce a +1 level lift per
  separation layer.)
- **Lab round-trip** on a deep-skin sample, so a colour operation cannot shift the hue
  of melanin-rich skin through conversion error alone.

### `tests/analysis.test.js` (18 test blocks)
Skin detection across eight tones (all above 0.55, all non-skin surfaces below 0.5, and
ebony vs fair confidence within 0.45), the melanin index ordering, exposure statistics,
light-direction estimation from four lighting setups, connected components, silhouette
neck-splitting, face detection and landmarks for every tone, facial zone masks, body
zone detection, region resolution, and the mask-feather non-spill rule.

Two regression tests in this file guard the deep-shadow branch of skin detection: the
b\* axis of a Lab colour collapses in underexposed deep skin, which used to cut every
mask at the shadow line (visible as a diagonal band across the torso). The tests walk a
column down the shadowed side of a deep-skin torso and require the mask to stay
continuous, *and* require dark cool surfaces to stay rejected.

### `tests/engines.test.js` (33 test blocks)
For all eight engines: valid layer trees, exact preview↔layer parity, no clipping on
any tone, plus engine-specific behaviour:

- the normal split reconstructs the original (max Δ < 3) and masks out background;
- advanced smoothing reduces texture but never erases it, and the pore slider is
  monotonic;
- professional separation is conservative by default, scales its bands with
  resolution, and reports per-region treatment;
- micro D&B exposes separate highlight/shadow/midtone layers and is ordered across
  presets;
- sculpt produces two independent masks and its highlight centroid **follows the
  measured key light** in two oppositely-lit portraits;
- the tone studio keeps deep skin within 8 L\* even with the luminance slider at +30,
  never produces orange/muddy chroma, auto-matches the correct category, and reports
  match distances;
- grading families exist and every look stays within a sane mean delta, with skin
  protection measurably reducing the skin shift;
- gloss is subtle by default, preserves texture, orders its presets, and separates
  glow/highlights/lips/contour with masks;
- hostile settings (every slider at maximum) produce no NaN and no out-of-range pixels;
- 24×24, 17×63 and 80×40 frames do not crash any engine;
- the tone studio's total added lightness is capped and the cap tightens toward zero
  at full melanin (regression test for a compounding-brighten bug);
- a sound five-stage deep-skin pass reaches the reviewer with **zero alerts**.

### `tests/finalReview.test.js` (15 test blocks)
The reviewer's checks are tested as *detectors*, not just as code that runs:

- a clean image passes with zero alerts and zero texture loss;
- a deliberately blurred image (plastic skin) is detected as > 55% texture loss, raises
  a high-priority alert, and sets `pass: false`;
- a light softening stays below the alarm;
- a brightening of deep skin is caught as `brightened` with a ΔL above the allowance,
  while a faithful retouch reads `stable`;
- an injected 40-level edge band is caught as an introduced halo, while a naturally
  rim-lit portrait is **not** (this is the check that makes the halo metric meaningful);
- the chroma-only evenness pass moves luminance by less than 2.5 levels at full
  strength;
- a face/body match narrows the face–neck gap without moving any pixel more than 40
  levels;
- the full seven-stage pipeline runs, leaves the original bit-identical, survives a
  mid-stack disable, and returns to the original when every stage is removed.

### `tests/photoshop.test.js` (11 test blocks)
Translation-layer only: host probing is honest outside Photoshop, host calls reject with
readable errors, the layer manager refuses to run without a host, every blend mode the
renderer can composite has a Photoshop name (audited against `MODES`), mask conversion
produces a document-sized RGBA buffer, every adjustment an engine emits has a real
descriptor with the units Photoshop requires, the seven-stage stack stays under the
60-layer creation limit with unique names, and the settings-record layer is hidden.

### `tests/ui.test.js` (12 test blocks)
Runs the real panel against the real `index.html` through a small DOM implementation
(`tests/support/dom.js`): boot produces seven stage tabs and seven workflow items,
every panel renders controls from its engine schema with correct min/max/defaults,
applying a stage updates the session/preview/checklist, the mode switcher changes the
engine that runs, re-applying updates in place, reset restores the original exactly,
compare/mask/split toggles drive the preview, the stage-7 report renders six measured
rows, and re-analysis does not duplicate the safeguard sliders.

That last one and the panel-scoping selector were both **real bugs found by these
tests** during development, which is the argument for having them.

## Invariants the suite enforces continuously

| Invariant | Where |
|---|---|
| Preview == `renderStack(layers, input)` | every engine test, tolerance 0.5 |
| Original frame never mutated | workflow test, exact zero |
| Removing all stages returns the original | workflow test, exact zero |
| No output clips or crushes on any tone | engine matrix |
| No NaN/Infinity escapes into a layer | hostile-settings test |
| Masks never feather outward | analysis test |
| Every blend mode has a Photoshop name | bridge test |
| No claim of Photoshop testing anywhere shipped | bridge test |

## Render harness

`npm run render` renders every engine against eight tone/lighting scenarios and writes
`artifacts/render-sheet.tsv` plus comparison PNGs under `artifacts/renders/`. It prints a
warning if preview↔layer parity drifts above 1.2 mean Δ or if a layer tree fails
validation. Current state: **no warnings, parity 0.00 for all eight engines.**

## Open verification items (require a real Photoshop run)

1. Mask descriptor acceptance per Photoshop version (live mask vs baked fallback).
2. `placeEvent` throughput and memory with many layers on a large document.
3. Wide-gamut / 32-bit document round-trip through capture and commit.
4. Panel layout at 320×480 inside Photoshop's docked chrome.
5. Modal execution timing and history-state behaviour on very large documents.

Until those are executed in Photoshop, the correct statement is: *the plugin is
verified as an image-processing engine, a layer model, a UI, and a Photoshop
translation layer — not as a running Photoshop plugin.*
