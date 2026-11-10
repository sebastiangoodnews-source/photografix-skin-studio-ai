# Photografix Skin Studio AI — Free Core Edition v1.0.0

Professional skin retouching and colour grading for Adobe Photoshop, built for deep,
rich and melanin-dense skin across the full African and diaspora range.

## Download

**`Photografix-Skin-Studio-AI-Free-Core-v1.0.0.zip`**

```
Photografix-Skin-Studio-AI-v1.0.0/
├── INSTALL.txt              install, first run, troubleshooting
├── LICENSE
├── RELEASE_NOTES_v1.0.0.md  this file
├── panel-preview.html       open in a browser — no Photoshop needed
├── docs-*.md                tool reference, workflow, skin science,
│                            integration notes, testing notes
└── plugin/                  ← this is what UXP Developer Tool loads
    ├── manifest.json        UXP manifest v5, Photoshop 24.2+
    ├── index.html
    ├── panel.js             whole plugin as one classic script
    ├── icons/               panel icon (23px) + plugin icon (48px), 1x and 2x
    └── src/                 readable module graph, for reference
```

## Installation

1. Install **Adobe UXP Developer Tool** (free, via Creative Cloud).
2. Launch **Photoshop 24.2 or newer**.
3. In UXP Developer Tool: **Add Plugin** → select `plugin/manifest.json` → **Load**.
4. In Photoshop: **Plugins → Photografix Skin Studio AI**.

No account, API key, credits or subscription. The plugin makes **no network requests**
and works fully offline.

## What's included

Seven stages, eight engines:

| Stage | Studio |
|---|---|
| 1 | Frequency Separation — Normal / Advanced / Professional (three-band) |
| 2 | Micro Dodge & Burn |
| 3 | Sculpt Dodge & Burn |
| 4 | African Skin Tone Studio — 14 tone categories, 10 styles, auto-match |
| 5 | Colour Grading — 11 looks, 4 families |
| 6 | Photografix Glossy Skin — glow, highlights, lips, contour |
| 7 | Final Review — texture, melanin, halo, clipping and face/body checks |

Every stage is non-destructive: each run adds masked layers inside its own group, the
original layer is never touched, and any stage can be disabled, re-tuned or deleted.

## Melanin-first engineering

- Skin detection is luminance-neutral and keeps one continuous mask across the shadow
  line (below L\* 9 the Lab b\* axis collapses, which breaks naive hue tests).
- The tone engine caps its **total** added lightness, tightening toward zero as melanin
  rises — deep skin is never auto-brightened.
- Final Review measures median skin lightness against the original and warns on drift,
  with the allowance tightest where melanin is highest.

## What changed in this build

This release was assembled from the merged `main` branch. Because the packaging work
from the earlier session lived only in an unpushed commit, it was regenerated here, and
the audit found three defects worth naming:

1. **The panel would have been blank.** `index.html` shipped
   `<script type="module">` over 43 ES modules. Any host that reads that as a plain
   script throws `SyntaxError: Cannot use import statement outside a module` and
   renders nothing, with no error the user can act on. The build now compiles the
   module graph into one classic script (`panel.js`), fails if any module syntax
   survives, and parses the result with `vm.Script` to prove it loads.
2. **The release zip carried a stray `plugin-files/` directory**, left behind by the
   release script moving directories inside its own output folder.
3. **`manifest.json` declared an invalid permission**, `network.domains: []`. Adobe
   requires a non-empty `string[]` or `"all"`, and this plugin makes no network calls
   at all, so the permission was removed. The validator now rejects an empty domain
   list and flags a network permission declared without network code.

## Verification

- **108 automated tests** pass: colour maths, image analysis, all eight engines, the
  workflow session, the panel UI, the Photoshop translation layer, and the packaged
  zip itself — opened, parsed without module grammar, and booted to confirm all seven
  studios render.
- Preview ↔ layer parity is **0.00** for every engine: the panel preview is rendered
  from the same layer records Photoshop will build.
- Static UXP pre-flight passes: manifest schema and permissions, declared icons, no
  inline scripts, no CommonJS, every import resolves inside the package.

## Known limitations — please read before using on paid work

**The plugin has not been run inside Photoshop.** No Photoshop host exists in the
environment where it was built, and this release does not claim otherwise. These
host-side behaviours remain unverified and should be checked on your machine:

1. Layer-mask descriptor acceptance per Photoshop version (a bake-into-pixels fallback
   exists if a version refuses the descriptor).
2. `placeEvent` throughput and memory with many layers on a large document.
3. Wide-gamut / 32-bit document round-trip through capture and commit.
4. Docked panel layout at the 320×480 minimum size.
5. Modal execution timing and history behaviour on very large documents.

No `.ccx` is included: that format requires an Adobe-issued publisher signing
certificate, which cannot be produced here, and an unsigned `.ccx` is not installable.
You can build one from the `plugin/` folder in UXP Developer Tool → Package using your
own Adobe credentials.

## Licence

Photografix Academy. See `LICENSE` in the package.
