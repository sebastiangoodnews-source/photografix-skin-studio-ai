# 05 — Workflow guide

The seven stages are a recommended order, not a cage. Every studio works on its own,
and you can run the same studio several times (different regions, different settings)
— each run adds its own group.

## The default pass

A normal professional portrait retouch, in order:

| # | Stage | Default move | Why here |
|---|---|---|---|
| 0 | — | Open the document, press **Analyse** | Detection is cached for the session; every stage reuses one analysis. |
| 1 | Frequency Separation | **Normal**, radius 6–10, texture opacity 70–85 | Even out skin without touching form. Start conservative: you can always raise the texture layer. |
| 2 | Micro Dodge & Burn | Very subtle, face + body | Fix what is *left* after step 1 — the under-eye area, the sides of the nose, patchy cheeks, uneven chest. |
| 3 | Sculpt Dodge & Burn | Natural preset, follow light **on** | Only now add dimension. Sculpting before the skin is even amplifies the unevenness. |
| 4 | African Skin Tone Studio | Auto-match, natural melanin style, protection 85 | Unify complexion and match the face to the neck/chest *before* grading, because a grade multiplies whatever mismatch exists. |
| 5 | Colour Grading | Signature or a family look, skin protection 80 | Grade the environment and the wardrobe; keep the skin out of it unless the look is meant to be inclusive. |
| 6 | Glossy Skin | Subtle glow | Finish: glow, highlights, lips, contour. |
| 7 | Final Review | Everything off, read the checks | Confirm nothing broke. Then, if needed, use the finishing moves. |

## Choosing a frequency-separation mode

| You want | Use |
|---|---|
| A classic, fully brushable split you will retouch by hand | **Normal** |
| A mostly automatic pass that keeps pores | **Advanced** |
| Per-region control, three bands, a diagnostic map | **Professional** |

All three can coexist: run Normal for the face and Professional for the body if that
is what the image needs.

## Working on deep skin

1. **Never start with brightness.** Run stage 4 with auto-match on and look at the
   report's match distance before touching any slider.
2. **Watch the texture number.** Final Review's texture row should read well under
   38% at delivery. If it does not, lower the texture layer opacity in stage 1 — that
   is a single number, not a re-run.
3. **Keep sculpt subtle.** On deep skin, form is already defined by the light; the
   dramatic preset is for heavily shadowed studio setups, not for adding contrast to a
   flat-lit face.
4. **Check face/neck first, then face/body.** A face that is 8 chroma units away from
   its neck reads as a different person, no matter how good the skin is.

## Working on light skin

The same pipeline works, with two adjustments: texture loss is visually less obvious,
so the review's texture alarm is the only honest signal — do not trust the eye. And
the skin-tone stage is usually unnecessary; grade inclusive instead if the look
requires it.

## Re-tuning after the fact

- **Re-apply** a panel to update its stage. Stages above it are recomputed
  automatically, because their input changed.
- **Toggle** a stage from the workflow checklist (the ◐ button) to compare with and
  without it. Nothing is deleted.
- **Reset** on a panel deletes only that stage.
- **Group opacity** — every engine exposes one, and it is the cheapest correction:
  `opacity 50` on a stage that went too far is usually better than re-running it.

## Common recipes

**Beauty close-up:** FS Advanced (smoothing 55, pores 60) → Micro D&B (very subtle,
face only) → Skin tone (auto-match) → Glossy skin (beauty gloss) → Review.

**Editorial with a strong grade:** FS Normal (radius 8, texture 75%) → Sculpt (natural,
follow light) → Colour grading (editorial, skin protection 90) → Review.

**Wedding, mixed skin tones in one frame:** Skin tone (auto-match **off**, pick the
category per subject using a custom selection — run the stage twice with two custom
rectangles) → Colour grading (wedding airy, skin protection 85) → Review, and check the
face/body row for every subject.

**Dark-skin luxury look:** Skin tone (dark ebony, deep ebony luxury style, protection
100) → Sculpt (subtle) → Colour grading (dark-skin luxury, skin protection 95) →
Glossy skin (premium gloss, texture protection 90) → Review with melanin allowance
lowered to 2 L\*.

## When the review argues with you

The review is allowed to be wrong — it measures the frame, not your intent. Two rules
of thumb:

- If a **texture** alert appears but the image looks right, look again at 100%. Plastic
  skin on deep tones is hard to see on a small preview.
- If a **melanin** alert appears and the subject *should* be lighter (a deliberate
  grade), raise the allowance for that delivery rather than deleting the check.
