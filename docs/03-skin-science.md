# 03 — Skin science for African and melanin-rich skin

This document explains the *engineering* decisions behind the tool's behaviour. It is
the reason several sliders feel different from their equivalents in mainstream
plugins.

## 1. Why brightness-based skin detection fails

Most skin detectors threshold on luminance ("skin is bright and warm") or on a fixed
RGB box (for example R>95, G>40). Both fail on deep skin, where the whole face can sit
below 60 in every channel, and the warm ratio changes shape as melanin increases.

This plugin scores skin from **four luminance-neutral signals**:

| Signal | What it captures |
|---|---|
| Hue angle in Lab/HSV space | The family of the colour, independent of lightness |
| Chroma | How saturated the colour is, normalised for the tone |
| Red-to-green ratio | The warm axis that melanin preserves across the range |
| Blue deficit | Rejects cool backgrounds and clothing |

The result is a probability field, not a binary mask, and it is smoothed before
thresholding so a single noisy pixel cannot punch a hole in the mask.

**Tested:** all eight fixture tones from `dark-ebony` to `fair-skin` score above 0.9,
background/clothing/neutral/cool surfaces score below 0.4, and the difference between
ebony and fair confidence is under 0.45 — the detector does not "like" light skin more
than dark skin.

### The deep-shadow branch

Below L\* ≈ 9 the blue-yellow axis of Lab has almost no signal left, so a hue-angle test
reads underexposed deep skin as "wrong hue" and the mask stops dead at the shadow line.
In a real photograph that produces the most embarrassing possible artefact: a retouch
that covers the lit half of the torso and abandons the shadowed half.

The detector therefore switches rules in deep shadow, judging on **a\*** (which survives
the compression) and on the **sign and size of b\*** (shadowed skin stays on the yellow
side of neutral, while a dark purple or a dark grey does not). A dark purple at
`(40, 20, 45)` scores 0.36; the shadowed half of a deep-skin torso scores 1.00.

### Compounding lightness, and why the cap is on the total

The tone engine can raise L\* from four places at once: the palette anchor, the
luminance slider, the style's own luminance, and the style's shadow lift. Bounding each
one individually is not enough — their sum still walked deep skin upward by several
levels per run, and a five-stage pass compounds it. The engine now caps the **total**
added lightness and tightens that cap toward zero as melanin rises
(`LUMINANCE_CAP_MAX × (1 − melanin)`), so at full melanin a single run may add no
lightness at all. Darkening is never capped.

## 2. Melanin drift is a measurable defect

Retouchers describe "the skin went grey" or "she looks lighter than she is". The Final
Review stage turns that into a number: the **median L\*** of the reviewed skin, before
and after the retouch, inside the skin mask.

- ΔL below 1.0 → *stable*
- ΔL above the allowance → an alert naming the direction

The allowance scales with measured melanin: at the deepest tones it is the 4.0 L\*
default, and it relaxes toward ~8 L\* for light skin, where dodge/burn and gloss
legitimately add real light. The rule is never relaxed in the direction that matters —
brightening deep skin is exactly what the check exists to catch.

Deep skin is given no special code path here — the point is that the check applies to
every tone equally and cannot be argued away by a slider. The tone engine additionally
caps the amount of luminance it will move at all (`protectMelanin`), and the evenness
pass in stage 7 is **chroma-only**: it cannot change L by construction, and a test
asserts that luminance moves less than 2.5 levels even at 100% strength.

## 3. Texture is identity on deep skin

A fair-skinned face with a soft focus still reads as a face. A deep-skinned face with
the same soft focus reads as a mannequin, because the contrast that defines the form is
carried by the pore-scale variation, not by colour alone.

Consequences in the maths:

- Every smoothing operation in Advanced and Professional FS is multiplied by a
  **pore-preservation mask** derived from a high-frequency detail map.
- Professional separation keeps the **form band intact** and only reconstructs
  structure, so large-scale modelling (the shape of a cheek) is never flattened.
- The reviewer measures high-frequency energy inside the skin before and after and
  warns above 38% loss (medium) and 55% (the point where skin reads plastic).

**Calibration note:** the tool's own maximum smoothing setting measures 34–51% loss on
the test fixtures depending on tone. That is intentionally near the alarm — the maximum
should be a decision, not a default — while the shipped default lands around 10–29%.

## 4. Face-to-body colour relationships

A retouched face that no longer matches its neck is the most common giveaway in
amateur beauty work. The plugin treats the face, the neck and the chest as three
measurable regions and reports ΔL and Δchroma for each pair.

Two deliberate choices:

- The **neck is weighted above the chest** when matching, because it is the visible
  bridge between the two.
- Matching is a **nudge with hard limits** (a\*/b\* ±6, L\* ±3.5), regardless of the
  strength slider. Face matching cannot re-grade a face; it can only close a gap.

## 5. Highlights are anatomy plus light, not a preset

A glossy highlight dropped on a cheekbone is wrong if the key light is behind the
subject. The gloss engine therefore:

1. estimates the key-light direction from the bright-pixel centroid of the face,
2. locates anatomical highlight areas (cheekbones, nose bridge, cupid's bow, chin,
   collarbone, shoulders),
3. scores each area by available headroom and orientation relative to the light,
4. **skips** areas in shadow, already-specular, not on skin, or too small, and says so
   in the report.

The sculpt engine uses the same measured direction to decide which side of the face
gets the highlight layer and which gets the shadow layer. A test builds two synthetic
portraits lit from opposite sides and asserts that the highlight centroid follows.

## 6. Why the frequency split uses Linear Light and 127.5

A correct two-layer split reconstructs the original exactly:

```
low  = blur(original, r)
high = (original - low) * 0.5 + 127.5
LinearLight(low, high) = low + 2 * (high - 127.5) = original
```

Two details matter:

- **Linear Light, not Overlay.** Overlay is not linear, so a split composited with
  Overlay cannot reconstruct the original — the error is small but systematic.
- **127.5, not 128.** With an 8-bit range the neutral point is half of 255. Using 128
  adds a constant +1 level per separation layer, which accumulates across stages into
  visible brightness creep. This was a real bug in this codebase, found by the test
  suite.

The first `docs/09-testing.md` parity failure was an early implementation that used
Overlay for one mode; the test suite now pins both facts.

## 7. Mask polarity: the halo trap

A skin-feature protection mask is **1 on skin / 1 on fine detail members that must be
preserved**. Combining it with a smoothing weight is easy to get backwards, and the
classic symptom is a bright halo on hair and background.

Two rules are enforced in the code and in tests:

- Feathering a mask must clip **inward** (`featherMask` never expands coverage), so a
  mask can never spill onto the background.
- Blur-based mask refinement is followed by a `min(out, clip)` step; without it, a
  20px feather on a jawline paints 20px of correction onto the hair behind it.

The stage-7 halo check measures the *change* in edge contrast rather than absolute
brightness, so a naturally rim-lit portrait is not reported as broken.
