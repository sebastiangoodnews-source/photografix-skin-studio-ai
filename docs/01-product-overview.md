# 01 — Product overview

**Photografix Skin Studio AI, Free Core Edition**
Published by Photografix Academy · Photoshop UXP plugin · id `com.photografix.skinstudio`

## The problem this solves

Retouching deep and melanin-rich skin is where generic beauty tools fail. The three
failure modes are consistent and well documented by retouchers:

1. **Silent lightening.** A "brightness and clarity" pass lifts the skin two or three
   stops, the richness collapses, and the subject no longer looks like themselves.
2. **Plastic skin.** Agents smooth until the pores are gone. On deeper tones the
   texture is what proves the skin is real, so a smooth deep-skin face reads as a
   mannequin immediately.
3. **Broken colour relationships.** The face is corrected but the neck is not, or a
   teal-orange grade is applied uniformly and turns warm brown skin orange.

Skin Studio is built around those three failures. They are not policy statements in
the documentation; each one is a measurable check in the test suite and, for the
third, a live warning in the Final Review panel.

## Design principles

| Principle | What it means in the product |
|---|---|
| **Non-destructive, always** | Every stage emits a group of layers. The original pixel layer is never touched and never flattened. Any stage can be disabled, re-run or deleted later. |
| **Independent tools** | You can open Glossy Skin and use only that. The seven stages suggest an order; they never gate each other. |
| **Melanin-first** | Skin detection is luminance-neutral; the tone engine is chroma-first; deep-skin categories are first in the palette, not an afterthought. |
| **No invented light** | Sculpt and gloss measure the key-light direction from the photograph and refuse to place highlights on the shadow side. |
| **No body reshaping** | There is no liquify, no proportion control, no slimming. Sculpting moves luminance along existing form only. |
| **Deterministic and local** | Every pixel comes from an algorithm in this repository. No model downloads, no API keys, no credits, no subscription, no telemetry. |
| **Honest reporting** | The panel reports what it actually did (radii used, regions treated, directions measured) and the reviewer reports what it actually measured. |

## The six studios

### 1. Frequency Separation — three modes
- **Normal** — a conventional, fully brushable split. Texture and colour on separate
  layers, composited with Linear Light so the pair reconstructs the original exactly.
  This is the mode a retoucher who already knows the technique will reach for.
- **Advanced** — guided separation with a skin-aware gate: flat areas smooth more,
  structured areas are protected, pores are preserved by a dedicated mask.
- **Professional** — three-band (base / structure / form) separation with per-region
  balance, blemish isolation and a diagnostic treatment map.

### 2. Micro Dodge & Burn
Separate highlight, shadow and midtone correction layers with masks. Targets small
tonal unevenness on face *and* body — the under-eye area, the sides of the nose,
patchiness across the cheeks, tone differences across the chest.

### 3. Sculpt Dodge & Burn
Two layers (highlight and shadow) whose masks are derived from the photograph's own
light and the body's silhouette. Presets: subtle, natural (default), dramatic, custom.
The engine never changes proportions; it only changes how light describes the form.

### 4. African Skin Tone Studio
The signature capability.
- **14 tone categories** from deep chocolate through ebony, mahogany, golden brown and
  caramel to fair skin — described as colour *styles*, not classifications.
- **10 editable skin styles** (neutral, rich chocolate glow, warm mahogany, golden
  brown beauty, deep ebony luxury, natural melanin, soft caramel, neutral studio,
  warm tan light, clean fair).
- **Auto-match** reads the photograph and picks the nearest category, telling you the
  match distance so you can overrule it.
- **Face-to-neck and face-to-body matching**, **melanin protection**, warmth,
  saturation and per-style fine tuning.

### 5. Colour Grading
11 looks across four families: neutral, Photografix signature (signature, editorial,
African beauty glow, dark-skin luxury), cinematic (teal-orange, warm film, cool noir)
and wedding (airy, warm gold, classic). Every look is masked off the skin by default,
with a control to grade the skin too when the shot calls for it.

### 6. Photografix Glossy Skin
Four independent parts, each on its own masked layer with its own opacity: glow,
facial highlights, lips and contour. Highlights are only placed where the photograph's
lighting and the anatomy allow, and the engine reports which areas it skipped and why.

### 7. Final Review
Not a look — a safety net. It measures texture loss, melanin drift, introduced edge
halos, clipping and face/body colour relationships against the original, reports each
one, and offers the last small finishing moves (blemish refinement, chroma-only
evenness, face matching, false-colour and difference judgement views).

## What the plugin deliberately does not do

- No body reshaping, slimming, proportion changes or "beauty" geometry.
- No teeth whitening, eye enlargement or face slimming.
- No AI generation, inpainting of missing content, or compositing.
- No cloud rendering, accounts, credits or subscriptions.
- No silent global brightening of dark skin — enforced by test, not by a slider label.
