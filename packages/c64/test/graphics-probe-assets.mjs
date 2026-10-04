// Writes the PNGs graphics-probe.8bg points at, in the C64's own palette
// colours so graphics.test.mjs can say which VIC-II colour each sprite got.
// Run `node packages/c64/test/graphics-probe-assets.mjs` to regenerate.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../../graphics-tools/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Pepto palette entries the lowering maps to: 1 white, 2 red, 5 green, 3 cyan, 7 yellow.
const WHITE = [0xff, 0xff, 0xff];
const RED = [0x81, 0x33, 0x38];
const GREEN = [0x56, 0xac, 0x4d];
const CYAN = [0x75, 0xce, 0xc8];
const YELLOW = [0xed, 0xf1, 0x71];

function png(name, width, height, ink) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = ink(x, y);
      if (!color) continue;
      const o = (y * width + x) * 4;
      rgba.set(color, o);
      rgba[o + 3] = 255;
    }
  }
  writeFileSync(join(HERE, name), encodePng(width, height, rgba));
}

// walker: four 16x16 frames; frame f is a 4-pixel-wide bar at x = 4f.
png('graphics-probe-walker.png', 64, 16, (x) => {
  const f = Math.floor(x / 16);
  const lx = x % 16;
  return lx >= 4 * f && lx < 4 * f + 4 ? WHITE : null;
});
png('graphics-probe-wide.png', 24, 21, () => CYAN);
png('graphics-probe-corner.png', 8, 8, () => YELLOW);
png('graphics-probe-dot-red.png', 8, 8, () => RED);
png('graphics-probe-dot-green.png', 8, 8, () => GREEN);

// graphics-probe.8bg and graphics-probe.8bs are written by hand; the twelve
// dots are dot0..dot11, alternating red and green.
