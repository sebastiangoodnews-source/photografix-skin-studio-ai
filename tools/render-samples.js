import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPortrait, SCENARIOS } from './lib/portrait.js';
import { frameToPNG, comparisonPNG } from './lib/png.js';
import { WorkflowSession } from '../src/core/workflow/orchestrator.js';
import { ENGINE_REGISTRY } from '../src/core/engines/registry.js';
import { renderStack } from '../src/core/layers/render.js';
import { validateLayerTree, countLayers } from '../src/core/layers/record.js';

/**
 * Visual review sheet generator.
 *
 * Runs every engine on every skin tone scenario, writes before/after sheets and a
 * quality table. This is the artefact used to eyeball whether results look like
 * retouching - not just whether the code executes.
 */
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'renders');

const ENGINE_IDS = ENGINE_REGISTRY.map((e) => e.id);

const diffStats = (a, b) => {
  let sum = 0;
  let max = 0;
  let changed = 0;
  let clipped = 0;
  for (let i = 0; i < a.pixelCount; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(b.channels[c][i] - a.channels[c][i]);
      sum += d;
      if (d > max) max = d;
      if (d > 1) changed++;
    }
    if (b.r[i] >= 254.5) clipped++;
  }
  const samples = a.pixelCount * 3;
  return {
    meanAbs: sum / samples,
    max,
    changedPct: (changed / samples) * 100,
    clippedPct: (clipped / a.pixelCount) * 100,
  };
};

const main = async () => {
  await fs.mkdir(OUT, { recursive: true });
  const rows = [];
  const only = process.argv[2];
  const scenarios = only ? SCENARIOS.filter((s) => s.id.includes(only)) : SCENARIOS;

  for (const scenario of scenarios) {
    const frame = createPortrait({ width: 320, height: 420, ...scenario });
    await fs.writeFile(path.join(OUT, `${scenario.id}-original.png`), frameToPNG(frame));
    for (const engineId of ENGINE_IDS) {
      const session = new WorkflowSession({});
      session.setDocument(frame);
      const started = Date.now();
      const stage = session.runStage({ tool: ENGINE_REGISTRY.find((e) => e.id === engineId).tool, engineId });
      const ms = Date.now() - started;
      const after = stage.output;
      const stats = diffStats(frame, after);
      const validation = validateLayerTree(stage.layers);
      rows.push({
        scenario: scenario.id,
        engine: engineId,
        ms,
        layers: stage.layers.reduce((acc, g) => acc + countLayers([g]), 0),
        mean: stats.meanAbs.toFixed(2),
        max: stats.max.toFixed(1),
        changed: stats.changedPct.toFixed(2),
        clipped: stats.clippedPct.toFixed(2),
        valid: validation.ok ? 'ok' : validation.errors.join('; '),
      });
      const name = `${scenario.id}__${engineId}`;
      await fs.writeFile(path.join(OUT, `${name}.png`), comparisonPNG(frame, after));
      // layer-stack render parity check: the stack must reproduce the engine preview
      const rendered = renderStack(stage.layers, frame, { respectVisibility: false });
      const parity = diffStats(rendered, after);
      if (parity.meanAbs > 1.2) {
        console.warn(`  ! parity drift ${name}: meanΔ ${parity.meanAbs.toFixed(2)}`);
      }
    }
    console.log(`rendered ${scenario.id}`);
  }

  const header = ['scenario', 'engine', 'ms', 'layers', 'meanΔ', 'maxΔ', 'changed%', 'clipped%', 'layers valid'];
  const lines = [header.join('\t')];
  for (const r of rows) lines.push([r.scenario, r.engine, r.ms, r.layers, r.mean, r.max, r.changed, r.clipped, r.valid].join('\t'));
  await fs.writeFile(path.join(OUT, '..', 'render-sheet.tsv'), lines.join('\n'));
  console.log(lines.join('\n'));
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
