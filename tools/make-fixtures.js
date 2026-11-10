import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPortrait, SCENARIOS } from './lib/portrait.js';
import { frameToPNG } from './lib/png.js';

/**
 * Writes the synthetic test portraits used by the visual review sheets.
 * Fixtures are generated, never committed (see .gitignore).
 */
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'fixtures');

const main = async () => {
  await fs.mkdir(OUT, { recursive: true });
  for (const scenario of SCENARIOS) {
    const frame = createPortrait({ width: 400, height: 540, ...scenario });
    await fs.writeFile(path.join(OUT, `${scenario.id}.png`), frameToPNG(frame));
    console.log(`wrote ${scenario.id}.png`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
