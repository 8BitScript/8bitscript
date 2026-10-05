// The C64's sprites in its wasm build, end to end and pixel for pixel: real
// programs built through the wasm backend (`--web`), run in Node's WebAssembly
// and painted by the page's own compositor (captureScreenshot with `web: true`,
// what `8bs run c64 --web --screenshot` calls). No emulator is involved, which is
// why this runs in CI where the machine package's x64sc tests cannot.
//
// Three things are held here:
//   - the hardware sprites (@8bitscript/c64/sprites): position with the ninth X
//     bit, colour, expansion, multicolour — read back at exact pixels;
//   - the multiplexer (@8bitscript/c64/multiplex, wasm twin multiplex.c64.web.8bs):
//     the native layers.test.mjs multiplexer probe, unchanged, whose twenty
//     virtual sprites from eight hardware ones must land on the same screen
//     lines in the same colours as under x64sc, so sprite REUSE works through
//     the list the page applies;
//   - the five programs the sprite layer used to stop (fancy, joystick,
//     media-walk, swarm, Studio) build for the C64's wasm backend and draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { pixelAt } from '../src/png.mjs';
import { BORDER_PX, C64_PALETTE } from '../src/web-layout.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const RGB = C64_PALETTE.map((hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)));
const is = (px, colour) => px[0] === RGB[colour][0] && px[1] === RGB[colour][1] && px[2] === RGB[colour][2];

const CLI_LINE = /^(built |memory: |size breakdown|web bundle: |8bs build: |warning |\s+at |.*\.8ba:)/;
function silently(fn) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => (CLI_LINE.test(String(chunk)) ? true : out(chunk, ...rest));
  process.stderr.write = (chunk, ...rest) => (CLI_LINE.test(String(chunk)) ? true : err(chunk, ...rest));
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  });
}

/** Builds the entry through the wasm backend from `cwd` and returns its screenshot after `frames`. */
async function shootEntry(entry, { cwd, frames = 2 } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-web-c64-sprites-'));
  const prev = process.cwd();
  try {
    process.chdir(cwd);
    const result = await silently(() => compile('c64', entry, { checkout: REPO, web: true }));
    assert.equal(result.ok, true, `${entry} builds for the C64 through the wasm backend`);
    const shot = join(scratch, 'out.png');
    await captureScreenshot('c64', result.outFile, shot, { frames, hardware: result.hardware, web: true });
    return await readFile(shot);
  } finally {
    process.chdir(prev);
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A program written to a scratch directory and shot. */
async function shootSource(source, { frames = 2 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-c64-src-'));
  try {
    await writeFile(join(dir, 'main.8bs'), source);
    return await shootEntry(join(dir, 'main.8bs'), { cwd: dir, frames });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A sprite at (X, Y): first pixel at picture column X - 24, first row Y - 50
// (raster line Y + 1; the picture starts at line 51). In the PNG that is
// (BORDER_PX + X - 24, BORDER_PX + Y - 50).
const spriteX = (x) => BORDER_PX + x - 24;
const spriteY = (y) => BORDER_PX + y - 50;

const HARDWARE = `
import { screen, BorderColor, BackgroundColor } from "@8bitscript/screen";
import { sprites } from "@8bitscript/c64/sprites";
import { spriteShapes } from "@8bitscript/c64/video";

export function main(): void {
    screen.blank(BorderColor.BLACK, BackgroundColor.BLUE);
    for (let i: u8 = 0; i < 63; i++) {
        spriteShapes[sprites.blockOffset(sprites.FIRST_BLOCK) + i] = 0xFF;
        spriteShapes[sprites.blockOffset(sprites.FIRST_BLOCK + 1) + i] = 0b01101100;
    }
    sprites.setShape(0, sprites.FIRST_BLOCK);
    sprites.setColor(0, 1);
    sprites.place(0, 100, 100);
    sprites.show(0);
    sprites.setShape(1, sprites.FIRST_BLOCK);
    sprites.setColor(1, 7);
    sprites.place(1, 270, 120);
    sprites.expand(1, true, true);
    sprites.show(1);
    sprites.setShape(2, sprites.FIRST_BLOCK + 1);
    sprites.setColor(2, 2);
    sprites.setSharedColors(5, 13);
    sprites.setMulticolor(2, true);
    sprites.place(2, 60, 180);
    sprites.show(2);
    while (true) {
        waitFrame();
    }
}
`;

test('the hardware sprites draw at the VIC\'s coordinates: X with its ninth bit, colour, expansion and multicolour', async () => {
  const png = await shootSource(HARDWARE);
  const px = (x, y) => pixelAt(png, x, y);
  // Sprite 0, (100, 100), white, 24x21.
  assert.ok(is(px(spriteX(100), spriteY(100)), 1), 'its top-left pixel');
  assert.ok(is(px(spriteX(100) + 23, spriteY(100) + 20), 1), 'its bottom-right pixel');
  assert.ok(is(px(spriteX(100) - 1, spriteY(100)), 6), 'the background left of it');
  assert.ok(is(px(spriteX(100) + 24, spriteY(100)), 6), 'and right of it');
  assert.ok(is(px(spriteX(100), spriteY(100) - 1), 6), 'above it');
  assert.ok(is(px(spriteX(100), spriteY(100) + 21), 6), 'below it');
  // Sprite 1, X 270 (needs $D010), yellow, expanded to 48x42.
  assert.ok(is(px(spriteX(270), spriteY(120)), 7), 'X above 255: the ninth bit');
  assert.ok(is(px(spriteX(270) + 47, spriteY(120) + 41), 7), 'expanded in both directions');
  assert.ok(is(px(spriteX(270) + 48, spriteY(120)), 6));
  assert.ok(is(px(spriteX(270) - 1, spriteY(120)), 6));
  // Sprite 2, multicolour at (60, 180): pairs %01 shared 0 (5), %10 own (2), %11 shared 1 (13), %00 clear.
  const wanted = [5, 5, 2, 2, 13, 13, 6, 6]; // the last pair is %00: the blue background shows
  wanted.forEach((colour, dx) => {
    assert.ok(is(px(spriteX(60) + dx, spriteY(180)), colour), `multicolour pixel ${dx}: colour ${colour}`);
  });
});

test('the multiplexer\'s twenty virtual sprites land on the same lines in the same colours as under x64sc', async () => {
  // packages/c64/test/layers.test.mjs reads this probe's blocks under VICE: four
  // rows of five solid 24x21 blocks 40 lines apart, each row its own colour,
  // the list rebuilt and committed every frame, one sprite hidden. After the
  // 32-pixel drift column c's block starts at X = 40 + 60c + 32.
  const png = await shootEntry(join(REPO, 'packages', 'c64', 'test', 'multiplex-probe.8bs'), { cwd: REPO, frames: 60 });
  const px = (x, y) => pixelAt(png, x, y);
  const colours = [1, 7, 3, 13]; // white, yellow, cyan, light green
  for (let r = 0; r < 4; r += 1) {
    const y = 60 + r * 40;
    for (let c = 0; c < 5; c += 1) {
      const x = 40 + c * 60 + 32;
      assert.ok(is(px(spriteX(x) + 12, spriteY(y) + 10), colours[r]), `row ${r}, column ${c}: the block's centre in colour ${colours[r]}, got ${px(spriteX(x) + 12, spriteY(y) + 10)}`);
      assert.ok(is(px(spriteX(x) + 30, spriteY(y) + 10), 6), `row ${r}, column ${c}: playfield right of it`);
    }
    const x0 = spriteX(40 + 32) + 12;
    assert.ok(is(px(x0, spriteY(y) - 1), 6), `row ${r}: line ${y}, above the block`);
    assert.ok(is(px(x0, spriteY(y)), colours[r]), `row ${r}: its first row`);
    assert.ok(is(px(x0, spriteY(y) + 20), colours[r]), `row ${r}: its last row (21 rows)`);
    assert.ok(is(px(x0, spriteY(y) + 21), 6), `row ${r}: below it`);
  }
  assert.ok(is(px(spriteX(160) + 12, spriteY(100) + 10), 6), 'the hidden sprite is not drawn');
});

/** The connected blobs of non-background pixels below the text rows, to count what a program draws. */
function blobs(png, { top, background }) {
  const seen = new Set();
  let count = 0;
  const key = (x, y) => y * 4096 + x;
  for (let y = top; y < BORDER_PX + 200; y += 1) {
    for (let x = BORDER_PX; x < BORDER_PX + 320; x += 1) {
      if (seen.has(key(x, y)) || is(pixelAt(png, x, y), background)) continue;
      count += 1;
      const stack = [[x, y]];
      while (stack.length > 0) {
        const [cx, cy] = stack.pop();
        if (cx < BORDER_PX || cx >= BORDER_PX + 320 || cy < top || cy >= BORDER_PX + 200) continue;
        if (seen.has(key(cx, cy)) || is(pixelAt(png, cx, cy), background)) continue;
        seen.add(key(cx, cy));
        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1], [cx + 1, cy + 1], [cx - 1, cy - 1], [cx + 1, cy - 1], [cx - 1, cy + 1]);
      }
    }
  }
  return count;
}

const EXAMPLES = join(REPO, 'packages', 'examples');

test('swarm builds for the C64\'s wasm backend and draws its sixteen sprites from eight', async () => {
  const png = await shootEntry(join(EXAMPLES, 'swarm', 'src', 'swarm.8bs'), { cwd: join(EXAMPLES, 'swarm'), frames: 120 });
  // The rings sit below the two text rows (the second at picture rows 8-15).
  const rings = blobs(png, { top: BORDER_PX + 24, background: 0 });
  assert.ok(rings >= 14 && rings <= 16, `sixteen rings (a few may touch), counted ${rings}`);
});

test('fancy, joystick, media-walk and Studio build for the C64\'s wasm backend, and fancy draws its colour bands', async () => {
  const fancy = await shootEntry(join(EXAMPLES, 'fancy', 'src', 'main.8bs'), { cwd: join(EXAMPLES, 'fancy'), frames: 120 });
  // The title's colour band: a different colour from the playfield's black, at a picture row the band covers.
  assert.ok(!is(pixelAt(fancy, BORDER_PX + 160, BORDER_PX + 28), 0), 'fancy: the title band is not the black playfield');
  for (const [name, entry, cwd] of [
    ['joystick', join(EXAMPLES, 'joystick', 'src', 'main.8bs'), join(EXAMPLES, 'joystick')],
    ['media-walk', join(EXAMPLES, 'media-walk', 'src', 'media-walk.8bs'), join(EXAMPLES, 'media-walk')],
    ['Studio', join(REPO, 'packages', 'studio', 'src', 'main.8bs'), join(REPO, 'packages', 'studio')],
  ]) {
    const png = await shootEntry(entry, { cwd, frames: 4 });
    assert.ok(png.length > 100, `${name}: a picture`);
  }
});
