// Regenerates fixtures/media-bounds.json. Run from the repo root:
//   node crates/media/tests/gen/media-bounds.mjs
// The oracle is `elaborateMedia` itself (`spriteBounds` is not exported): each
// sprite is elaborated with the default lowering and the `bounds` call that
// ends its `__8bs_media_bind_<name>` function is read back.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, sliceFrames } from '../../../../packages/graphics-tools/src/index.mjs';
import { elaborateMedia } from '../../../../packages/compiler/src/media/elaborate.mjs';
import { analyzeMedia, parseMediaModule } from '../../../../packages/compiler/src/media/index.mjs';
import { write } from './util.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const hex = (rgba) => Buffer.from(rgba).toString('hex');

/** All corpus .8bg files, sorted by path (the walk of machine-media.mjs). */
function corpus(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === '.git' || name === 'target') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) corpus(path, out);
    else if (name.endsWith('.8bg')) out.push(path);
  }
  return out;
}

// The same decode as machine-media.mjs.
function decode(sprite, path) {
  const png = join(dirname(path), sprite.source ?? '');
  if (!sprite.source || !existsSync(png)) return [];
  let decoded;
  try { decoded = decodePng(readFileSync(png)); } catch { return []; }
  if (decoded.width < sprite.width || decoded.height < sprite.height) return [];
  return sliceFrames(decoded.rgba, decoded.width, decoded.height, sprite.width, sprite.height)
    .map((rgba) => ({ rgba, width: sprite.width, height: sprite.height }));
}

const rows = [];

/** Elaborates the file and records every sprite's frames and `bounds` call. */
function record(label, path, text) {
  const { gir } = analyzeMedia(text, path, { sourceKind: '.8bg' });
  const module_ = parseMediaModule(path, text, [], '.8bg');
  const { ir } = elaborateMedia(module_, [], {});
  gir.sprites.forEach((sprite) => {
    const fn = ir.functions.find((f) => f.name === `__8bs_media_bind_${sprite.name}`);
    const call = fn.body[fn.body.length - 1];
    if (call.member !== 'bounds') throw new Error(`${label}: last statement is ${call.member}`);
    const frames = decode(sprite, path).map((f) => ({ width: f.width, height: f.height, rgba: hex(f.rgba) }));
    rows.push({ name: label ? `${label} / ${sprite.name}` : sprite.name, frames, bounds: call.args.slice(1).map((a) => a.value) });
  });
}

for (const path of corpus(join(root, 'packages'))) record(relative(root, path), path, readFileSync(path, 'utf8'));

mkdirSync(join(root, 'target'), { recursive: true });
const tmp = mkdtempSync(join(root, 'target', 'bounds-'));
const sheet = (width, height, pixel) => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgba.set(pixel(x, y), (y * width + x) * 4);
  }
  return rgba;
};
const ink = [20, 30, 40, 255];
const clear = [0, 0, 0, 0];
let n = 0;
function synthetic(label, size, width, height, pixel) {
  n += 1;
  const dir = join(tmp, `c${n}`);
  mkdirSync(dir);
  if (pixel) writeFileSync(join(dir, 's.png'), encodePng(width, height, sheet(width, height, pixel)));
  const path = join(dir, 'a.8bg');
  const text = `sprite s { source "s.png" size ${size} }`;
  writeFileSync(path, text);
  record(label, path, text);
}

try {
  synthetic('missing source', '8x8', 0, 0, null);
  synthetic('blank 8x8', '8x8', 8, 8, () => clear);
  synthetic('one pixel at 0,0', '8x8', 8, 8, (x, y) => (x === 0 && y === 0 ? ink : clear));
  synthetic('one pixel at 7,7', '8x8', 8, 8, (x, y) => (x === 7 && y === 7 ? ink : clear));
  synthetic('alpha 15 only', '8x8', 8, 8, () => [1, 2, 3, 15]);
  synthetic('alpha 16 only', '8x8', 8, 8, () => [1, 2, 3, 16]);
  synthetic('full 16x16', '16x16', 16, 16, () => ink);
  synthetic('two frames, two boxes', '8x8', 16, 8, (x, y) => ((x === 1 && y === 2) || (x === 13 && y === 6) ? ink : clear));
  synthetic('12x4', '12x4', 12, 4, (x, y) => (x >= 3 && x < 9 && y >= 1 && y < 3 ? ink : clear));
  synthetic('four frames, ink in the last', '8x8', 32, 8, (x, y) => (x >= 26 && x < 29 && y >= 3 && y < 5 ? ink : clear));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

write('media-bounds', rows);
