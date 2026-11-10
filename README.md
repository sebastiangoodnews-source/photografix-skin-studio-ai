# Photografix Skin Studio AI — Free Core Edition

Professional skin retouching and colour grading for Adobe Photoshop, built by
**Photografix Academy**.

Every tool is non-destructive, works on its own, and is designed for the skin that
most retouching software treats as an afterthought: deep, rich, melanin-dense skin
across the full African and diaspora range.

> **Status of verification.** The processing engines, the layer model, the panel
> and the *translation* layer for Photoshop are covered by 103 automated tests
> that run here. The plugin has **not** been executed inside Photoshop in this
> repository's environment — there is no Photoshop host available — so nothing in
> this project claims it was. See [docs/09-testing.md](docs/09-testing.md) for exactly
> what is and is not proven.

---

## What it does

Six tool studios, arranged as a seven-stage workflow. Each stage is optional, each
can be tuned after the fact, and no stage ever flattens the document.

| Stage | Studio | What it changes |
|---|---|---|
| 1 | **Frequency Separation** — Normal / Advanced / Professional | Texture and colour separately, at three different depths of sophistication |
| 2 | **Micro Dodge & Burn** | Small tonal distractions: patchiness, stray shadows, under-eye darkness |
| 3 | **Sculpt Dodge & Burn** | Form and dimension with light, following the photograph's own key light |
| 4 | **African Skin Tone Studio** | Complexion, palette matching, face-to-neck and face-to-body harmony |
| 5 | **Colour Grading** | Cinematic, wedding and Photografix signature looks, masked off the skin |
| 6 | **Photografix Glossy Skin** | Glow, intelligent highlights, lips and contour light |
| 7 | **Final Review** | Objective safety checks and the last finishing controls |

## Why it is different on deep skin

- **Melanin is protected, not "corrected".** No stage lifts luminance globally. The
  tone engine only redistributes tone inside the subject's existing range.
- **Skin detection is luminance-neutral.** It is built on hue, chroma and
  red-to-green ratio rather than brightness, so ebony and fair skin both read as
  skin with comparable confidence (tested across eight tones).
- **Texture beats smoothness.** Every smoothing control is gated by a pore-preservation
  mask, and the reviewer measures texture loss against the original and warns you
  before skin reads plastic.
- **Light is measured, not invented.** Sculpting and gloss read the key-light
  direction from the photograph; the engine will not add a highlight on the shadow
  side of a face.

## Quick start (development)

```bash
npm test              # 103 tests: engines, layers, UI, bridge translation, shipped bundle
npm run validate      # static UXP pre-flight (manifest, icons, imports, CSP)
npm run release       # the downloadable bundle users install
npm run harness       # open http://localhost:4173 to drive the panel in a browser
npm run render        # render every engine against every fixture → artifacts/
```

No dependencies, no build step, no network access. Node 20+.

## Documentation

1. [Product overview](docs/01-product-overview.md)
2. [Architecture](docs/02-architecture.md)
3. [Skin science for African and melanin-rich skin](docs/03-skin-science.md)
4. [Tool reference](docs/04-tool-reference.md)
5. [Workflow guide](docs/05-workflow-guide.md)
6. [Photoshop integration](docs/06-photoshop-integration.md)
7. [Non-destructive layer model](docs/07-layer-model.md)
8. [Performance](docs/08-performance.md)
9. [Testing and verification](docs/09-testing.md)

## Download and install

```bash
npm run release      # builds artifacts/dist/photografix-skin-studio-1.0.0-release.zip
```

The release zip contains everything needed to install and use the plugin:

| Inside the download | What it is |
|---|---|
| `INSTALL.txt` | Step-by-step install, first run, troubleshooting |
| `plugin/photografix-skin-studio/` | The plugin itself — this is what UXP Developer Tool loads |
| `panel-preview.html` | Self-contained preview of the panel; open it in a browser with nothing installed |
| `docs-*.md` | Tool reference, workflow guide, skin science, testing notes |
| `LICENSE` | Terms |

To install: launch Photoshop 24.2+, open [Adobe UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/),
**Add Plugin** → select `plugin/photografix-skin-studio/manifest.json` → **Load**. The panel
appears under *Plugins → Photografix Skin Studio AI*.

`npm run build` produces the plugin-only zip (manifest, `index.html`, `src/`, `icons/`) and
verifies the bundle as Photoshop would load it — every import must resolve *inside* the
archive, which is enforced because a dev-time path that reaches outside `src/` would ship
a plugin that fails to open while every test still passed.

The plugin declares `localFileSystem: fullAccess` for document capture and no network
domains — it never phones home.

## Licence and commercial terms

Code: Photografix Academy. No paid AI services, credits, subscriptions or hosted
infrastructure are required or contacted at any point: every pixel this plugin
produces comes from deterministic, local processing. See `LICENSE` for terms.
