# 08 — Performance

## Measured engine cost

Every engine run against the 320×420 fixture set, averaged across eight tone/lighting
scenarios, measured with `node tools/render-samples.js` (raw `artifacts/render-sheet.tsv`
is committed):

| Engine | Mean time | Peak Δ vs original | Notes |
|---|---|---|---|
| Frequency Separation — Normal | 127 ms | 0.0* | Split is exact by construction |
| Final Review | 136 ms | 0.0 | No finish tools enabled |
| Micro Dodge & Burn | 205 ms | 0.6 | |
| Colour Grading | 274 ms | 4.7 | |
| Sculpt Dodge & Burn | 330 ms | 0.2 | |
| African Skin Tone Studio | 357 ms | 2.1 | |
| Frequency Separation — Advanced | 381 ms | 0.2 | |
| Glossy Skin | 537 ms | 0.8 | Most layers (7) |
| Frequency Separation — Professional | 565 ms | 0.1 | Three bands, per-region balance |

\* the parity column in the sheet is preview-vs-layer drift, which is 0.00 for every
engine; max Δ against the original is reported separately per scenario.

A full seven-stage pass on a 320×420 frame is roughly **2.5 s** of computation; the
same work on a real document at preview scale is the same order because capture already
downsamples to `previewMaxEdge` (1200 px default).

## Where the time goes

1. **Gaussian blurs** dominate. Professional FS performs three multi-scale splits plus
   guided refinement; Advanced performs a guided filter.
2. **Per-pixel Lab round-trips** in the tone and grading engines.
3. **Mask refinement** (feather, smooth, speckle removal) — several separable passes per
   mask.

## Design decisions that keep it usable

- **Analysis is computed once per document** and cached in the `RegionResolver`; every
  stage reuses it. Re-running a slider does not re-detect the face.
- **Preview scale is capped** (`previewMaxEdge`, default 1200; the harness uses 900).
  Radii and masks are computed at preview resolution, then mapped back by the capture
  `scale` factor.
- **Debounced previews.** Schema forms commit on change with a debounce, so dragging a
  slider does not queue a run per pixel of movement.
- **Stages recompute only above the edited one.** Changing stage 2 recomputes 2–7, never
  1.
- **The composite is cached** and invalidated explicitly, not recomputed per query.
- **No web workers, no threads.** UXP's threading model makes workers unreliable across
  Photoshop versions; instead every engine is single-pass over `Float32Array`s with no
  allocation inside inner loops beyond the output buffers.

## Memory

A 1200×1600 preview frame is ~23 MB as three Float32 planes. Peak usage during a
Professional FS run is that plus three band buffers, two low passes and the mask set —
roughly **200–250 MB** for a large preview. On a 1400 px capture (the panel default) it
is well under half that. `previewMaxEdge` is the control if memory is tight.

## What is not optimised (and why)

- **No SIMD / WASM.** Both are possible under UXP and would give 2–4×, but neither is
  available in the Node test environment, so the fast path could never be tested here.
  Correct-and-tested beats fast-and-unverified.
- **No incremental mask caching** across stages. Masks differ per stage by design;
  caching them would trade a small win for a correctness risk.
- **No downsampled preview for the draft interaction.** A 200 ms run at 1200 px is
  already interactive on the target hardware.

## Reproducing these numbers

```bash
npm run render       # regenerates artifacts/render-sheet.tsv (8 scenarios × 8 engines)
```

The runner prints a warning if preview↔layer parity drifts above 1.2 mean Δ, or if a
layer tree fails validation. Both currently pass for every row.
