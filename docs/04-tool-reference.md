# 04 — Tool reference

Every control listed here is defined in the engine's own schema and rendered
automatically by the panel. Ranges are inclusive. "Default" is what a fresh session
starts with — chosen, in every case, to be a conservative first move rather than a
finished look.

All eight engines share these behaviours:

- The **Apply stage** button commits the stage to the session; **Preview** shows it
  without committing.
- Re-applying a stage **updates it in place** (and recomputes any stage above it)
  rather than stacking a second copy.
- Every stage emits layers inside a named group. **Reset** on a panel removes that
  stage; **Reset all** removes every stage and returns the untouched original.
- "Processing region" appears in nearly every panel: Face, Neck, Chest, Arms, Legs,
  Full body, Custom selection.

---

## Stage 1 — Frequency Separation

### Mode: Normal
The conventional split, made correctly and left brushable.

| Control | Range | Default | Notes |
|---|---|---|---|
| Gaussian blur radius | 1–40 px | 6 | The split radius. 4–8 px smooths blemishes only; 8–16 px also blends colour transitions. |
| Texture amount | 0.25–2 | 1 | Detail-layer gain. Above 1.5 skin starts to read gritty. |
| High-pass mode | Linear Light / Overlay | Linear Light | Linear Light reconstructs the original exactly. Overlay (classic High Pass) does not. |
| Suggest radius from analysis | on/off | on | Uses detected face size to pick a radius that means the same thing at any resolution. |
| Processing region | 7 options | Face | |
| Limit to detected skin | on/off | on | Confines the split to skin, so hair and background are untouched. |
| Mask feather | 0–30 px | 6 | Feathering always clips inward — it cannot bleed onto the background. |
| Texture layer opacity | 0–100% | 100 | The first thing to lower if skin reads over-processed. |
| Colour layer opacity | 0–100% | 100 | |
| Add editable tone curves | on/off | on | Adds a masked curves layer so the retoucher can adjust complexion after the fact. |

Output: `Texture (detail)` on Linear Light + `Colour (low frequency)` on Normal, plus
optional curves. Both layers carry masks.

### Mode: Advanced
Guided separation with a skin-aware gate and dedicated pore protection.

| Control | Range | Default | Notes |
|---|---|---|---|
| Texture smoothing | 0–100% | 55 | How much pore-scale detail to remove. **100 genuinely flattens** the detail layer except where features and blemishes are protected. |
| Pore preservation | 0–100% | 55 | Raises the detail threshold: more contrast needed before a feature counts as a pore. |
| Texture restoration | 0–100% | 35 | Re-injects a fraction of the removed detail as micro-contrast, so skin does not go flat. |
| Blemish awareness | 0–100% | 45 | Keeps detected blemish edges out of the smoothing. |
| Colour blending | 0–100% | 30 | Chroma unification toward the local mean (a\*/b\* only). |
| Skin uniformity | 0–100% | 26 | Corrects slow luminance drift. |
| Separation radius | 1–40 px | 10 | |
| Adaptive radius | on/off | on | Scales with face size and resolution. |
| Overall strength | 0–100% | 55 | Global multiplier on every amount above. |
| Group opacity | 0–100% | 100 | |

### Mode: Professional
Three bands (base, structure, form) with per-region balance.

| Control | Range | Default | Notes |
|---|---|---|---|
| Intensity | 6 steps | Natural | Very subtle / Subtle / Natural / Medium / Strong / Custom. |
| Base radius (pore scale) | 2–40 px | 6 | |
| Structure radius | 4–60 px | 14 | |
| Form radius | 8–90 px | 32 | The form band is **preserved**, never flattened: the layer starts from the original pixels and only receives colour corrections. |
| Adaptive band scaling | on/off | on | Scales bands from face height so a 60 MP file splits at the same anatomical scale as a 12 MP one. |
| Structure smoothing | 0–100% | 55 | |
| Pore detail retained | 0–100% | 45 | |
| Texture reconstruction | 0–100% | 40 | Rebuilds pore amplitude rather than blurring it away. |
| Blemish isolation | 0–100% | 45 | |
| Colour transition correction | 0–100% | 45 | Chroma drift toward the local mean, written onto the original pixels only. |
| Uneven complexion correction | 0–100% | 30 | Bounded luminance drift (max ±8 levels). |
| Per-region facial treatment | on/off | on | Forehead, cheeks, nose, lips, chin, under-eye, jaw get different balance from a table in the engine. |
| Overall strength | 0–100% | 55 | |
| Group opacity | 0–100% | 100 | |

Output: Form (safeguarded), Structure (Linear Light), Treatment map (diagnostic,
hidden), Complexion curves (editable, 55% opacity).

---

## Stage 2 — Micro Dodge & Burn

| Control | Range | Default | Notes |
|---|---|---|---|
| Target | Face / Body / Face + body | Face + body | |
| Intensity | 6 steps | Very subtle | Very subtle / Subtle / Natural / Medium / Strong / Custom. |
| Processing region | 7 options | Face | |
| Strength | 0–100% | 45 | |
| Layer opacity | 0–100% | 100 | |
| Highlight / shadow intensity | 0–100% | 40 / 40 | Separate control of the two directions. |
| Midtone correction | 0–100% | 30 | |
| Correction radius | 4–120 px | 40 | The scale of unevenness being corrected — not a blur. |
| Edge preservation | 0–100% | 60 | Keeps nose edges, lip borders and jawlines out of the correction. |
| Zone sliders | 0–100% each | varies | Under-eye lift, forehead, nose highlight, cheeks, lip area, neck, arms, legs, body balance. Set a zone to 0 to leave it alone. |
| Mask refinement / feather | 0–100%, 0–30 px | 50, 8 | |
| Brush size / softness / flow | 5–400 px, 0–100%, 1–100% | — | Recorded on the layer note so the retoucher can brush the mask by hand with matching settings. |

Output: Highlight, Shadow and Midtone layers, each with its own mask.

---

## Stage 3 — Sculpt Dodge & Burn

| Control | Range | Default | Notes |
|---|---|---|---|
| Preset | Subtle / Natural / Dramatic / Custom | Natural | Sets the strength and level values together. |
| Sculpt strength | 0–100% | 60 | |
| Highlight / shadow strength | 0–100% | 70 / 64 | |
| Highlight / shadow softness | 0–100% | 80 / 84 | |
| Feathering | 0–100% | 70 | |
| Mask intensity | 0–100% | 55 | |
| Target | Face / Body / Face + body | Face | |
| Processing region | 7 options | Face | |
| Follow existing light direction | on/off | on | **Recommended on.** When off, the engine uses a default three-quarter key. |
| Face emphasis | 4 options | Balanced | Balanced / Bone structure / Cheekbones / Jawline. |
| Body emphasis | 4 options | Balanced | Balanced / Shoulders / Collarbone / Torso. |
| Layer opacity | 0–100% | 100 | |
| Mask feather | 0–40 px | 12 | |

Output: `Highlights (sculpt)` and `Shadows (sculpt)` with independent masks, derived
from the measured key-light direction and the body silhouette. No geometry is altered.

---

## Stage 4 — African Skin Tone Studio

| Control | Range | Default | Notes |
|---|---|---|---|
| Skin tone category | 14 options | Rich chocolate | Deep chocolate, rich chocolate, dark ebony, deep mahogany, warm dark brown, natural dark brown, medium brown, golden brown, caramel, honey, warm tan, neutral medium, light skin, fair skin. |
| Auto-match category | on/off | on | Reads the photograph (median skin Lab) and picks the nearest category; the report prints the match distance. |
| Skin style | 10 options | Natural melanin | Neutral, rich chocolate glow, warm mahogany, golden brown beauty, deep ebony luxury, natural melanin, soft caramel, neutral studio, warm tan light, clean fair. |
| Hue / saturation / luminance | −30…30 / −50…50 / −30…30 | 0 | Luminance is capped internally by melanin protection. |
| Warmth | −30…30 | 0 | |
| Redness, yellow, green, orange balance | −30…30 each | 0 | Axis-level control for undertone. |
| Highlight / midtone / shadow colour + tint | colour, 0–100% | neutral, 0 | Tonal colour, like a split-tone that respects skin. |
| Face-to-neck matching | 0–100% | 40 | |
| Face-to-body matching | 0–100% | 20 | |
| Reference matching | 0–100% | 0 | Match toward a supplied reference Lab (available to integrations). |
| Complexion refinement | 0–100% | 30 | |
| Melanin protection | 0–100% | 85 | Caps how much luminance the stage may move at all. |
| Highlight protection | 0–100% | 80 | |
| Overall strength / group opacity | 0–100% | 60 / 100 | |
| Mask feather | 0–30 px | 8 | |

**Tested guarantees:** on dark ebony at full protection, luminance moves less than
8 L\* even when the luminance slider is pushed to +30; chroma never reaches an orange
cast; the auto-match picks the correct category within a distance of 30 for every
fixture tone.

---

## Stage 5 — Colour Grading

| Control | Range | Default | Notes |
|---|---|---|---|
| Grade | 11 looks | Photografix signature | Neutral, signature, editorial, African beauty glow, dark-skin luxury, cinematic teal-orange, cinematic warm film, cinematic cool noir, wedding airy, wedding warm gold, wedding classic. |
| Grade intensity | 0–100% | 60 | |
| Contrast / lift | −50…50 / −30…30 | 0 | |
| Highlights / shadows | −50…50 | 0 | |
| Vibrance / saturation | −50…50 | 0 | |
| Clarity | 0–100% | 15 | Local contrast. |
| Temperature / tint | −50…50 | 0 | |
| Skin protection | 0–100% | 80 | Masks the grade off the skin. |
| Apply grade to skin as well | on/off | off | For looks that are meant to be skin-inclusive. |
| Group opacity | 0–100% | 100 | |
| Mask feather | 0–40 px | 20 | |

Output: adjustment layers (curves, colour balance, hue/saturation, gradient map as the
look requires) inside one group, plus the skin mask.

---

## Stage 6 — Photografix Glossy Skin

| Control | Range | Default | Notes |
|---|---|---|---|
| Gloss preset | Subtle glow / Natural gloss / Beauty gloss / Premium gloss / Custom | Subtle glow | |
| Target | Face / Body / Face + body | Face + body | |
| Processing region | 7 options | Full body | |
| Glow intensity | 0–100% | 14 | Luminance-weighted lift composited with Soft Light, so texture survives. |
| Warmth | −30…30 | 0 | |
| Skin reflection | 0–100% | 30 | How much of the glow comes from reflected light rather than added light. |
| Gloss smoothness | 0–100% | 45 | Smoothness of the glow field only — it never touches the pores. |
| Highlight intensity | 0–100% | 18 | |
| Highlight spread | 0–100% | 34 | |
| Highlight softness | 0–100% | 40 | |
| Highlight opacity | 0–100% | 55 | |
| Highlight colour | colour | 255,250,242 | |
| Mask strength | 0–100% | 70 | |
| Lip enhancement | on/off | on | |
| Lip gloss / highlights / contour / brightness | 0–100% | 28 / 24 / 18 / 10 | |
| Preserve lip colour | on/off | on | Holds hue and chroma; only light changes. |
| Bone & contour enhancement | on/off | on | |
| Contour intensity | 0–100% | 16 | |
| Follow existing light direction | on/off | on | |
| Skin texture protection | 0–100% | 80 | The main anti-plastic control. |
| Group opacity | 0–100% | 100 | |
| Mask feather | 0–40 px | 10 | |

Output: separate Glow, Facial highlights, Body highlights, Lips and Contour layers,
each masked. The report lists which highlight areas were used and which were skipped
(and why).

---

## Stage 7 — Final Review

Review settings (they only affect measurement and judgement views):

| Control | Range | Default | Notes |
|---|---|---|---|
| Review region | Face / Full body / Neck / Chest / Custom | Full body | Where every check looks. |
| Texture-loss alarm | 5–80% | 38 | Above this the review raises a texture alert. |
| Halo alarm | 2–40 levels | 8 | Introduced edge contrast that counts as a halo. |
| Melanin drift allowance | 1–20 L\* | 4 | How far median skin lightness may move before it is flagged. |
| False-colour strength | 0–100% | 0 | Judgement view: chroma deviation as a green/red/magenta map. |

Finish tools (all off by default — the review must not change anything unless asked):

| Control | Range | Default | Notes |
|---|---|---|---|
| Refine remaining blemishes | on/off | off | One last restrained pass at 60% of the requested strength. |
| Refine strength / radius | 0–100% / 2–24 px | 22 / 5 | |
| Even remaining skin tone | on/off | off | **Chroma only.** Cannot change luminance. |
| Even strength | 0–100% | 30 | |
| Face/body matching | Off / Neck / Body / Both | Off | Nudges chroma by ≤6 and L\* by ≤3.5 regardless of strength. |
| Match strength | 0–100% | 45 | |
| Comparison overlay | None / Side-by-side / Difference | None | Side-by-side adds a hidden copy of the original layer; Difference adds a change map. |
| Mask feather / group opacity | 0–40 px / 0–100% | 6 / 100 | |

### What the review reports

| Check | Measured on | Alert |
|---|---|---|
| Texture | High-frequency energy inside the skin, original vs current | Loss > alarm (medium), > 1.6× alarm (high) |
| Melanin | Median L\* of reviewed skin | Move > allowance |
| Edge halo | Change in skin/background rim contrast vs original | > alarm |
| Clipping / crushing | Pixels at ≥252 or ≤3 inside the review area | > 0.5% |
| Face / neck | Δchroma between face and neck means | > 8 |
| Face / body | ΔL\* between face and chest means | > 6 |
