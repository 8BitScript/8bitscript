// The Commander X16's wasm build, end to end and pixel for pixel: a real .8bs
// program for the X16 is built through our own wasm backend (`--web`), run in
// Node's WebAssembly, and painted by the same compositor and memory map the
// browser page uses (captureScreenshot with `web: true`, which is what `8bs run
// cx16 --web --screenshot` calls). No emulator is involved, which is why this
// runs in CI where the X16 package's own x16emu tests cannot.
//
// What this pins, each of which was wrong before:
//   - the colours are VERA's own default palette, not the C64's (blue is
//     #0000aa, which is what x16emu draws for BorderColor.BLUE);
//   - a picture (`.8bg`) is drawn at all: the wasm model has no VERA sprites, so
//     it is carried as a glyph in the redefinable table the layout now has;
//   - the address the graphics twin writes that table at is the address the page
//     reads it from;
//   - Studio, the app the editor's Studio button opens in a tab, renders: the
//     blue border and its 8x8 mark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { encodePNG, pixelAt } from '../src/png.mjs';
import { BORDER_PX, C64_PALETTE, GLYPH_COUNT, GLYPH_FIRST, VERA_PALETTE, layoutForRealMachine } from '../src/web-layout.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const CX16_FACTS = { 'video.columns': 76, 'video.rows': 56 };

const CLI_LINE = /^(built |memory: |size breakdown|web bundle: |8bs build: )/;
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

/** The three hex channels of '#rrggbb'. */
const rgb = (hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
const same = (px, want) => px[0] === want[0] && px[1] === want[1] && px[2] === want[2];

/** Builds `entry` (a file in `dir`) for the X16 through the wasm backend and returns its screenshot. */
async function shoot(dir, entry, { frames = 4 } = {}) {
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const result = await silently(() => compile('cx16', join(dir, entry), { checkout: REPO, web: true }));
    assert.equal(result.ok, true, 'builds for the X16 through the wasm backend');
    const shot = join(dir, 'out.png');
    await captureScreenshot('cx16', result.outFile, shot, { frames, hardware: result.hardware, web: true });
    return await readFile(shot);
  } finally {
    process.chdir(prev);
  }
}

test("VERA's default palette is VERA's: the C64's names in the C64's order, with VERA's own colours", () => {
  assert.equal(VERA_PALETTE.length, 16);
  // $RGB, every nibble n -> n * 17, from the power-on values of palette entries 0-15.
  assert.deepEqual(VERA_PALETTE, [
    '#000000', '#ffffff', '#880000', '#aaffee', '#cc44cc', '#00cc55', '#0000aa', '#eeee77',
    '#dd8855', '#664400', '#ff7777', '#333333', '#777777', '#88ff66', '#0088ff', '#bbbbbb',
  ]);
  assert.notEqual(VERA_PALETTE[6], C64_PALETTE[6], "blue is not the C64's #40318d");
  const layout = layoutForRealMachine('cx16', { facts: CX16_FACTS });
  assert.deepEqual(layout.palette, VERA_PALETTE, 'the page paints the X16 from it');
  assert.deepEqual(layoutForRealMachine('c64', { facts: {} }).palette, C64_PALETTE, 'and the C64 still from its own');
});

test('the X16 layout carries the redefinable glyph table the graphics twin writes at the address it reads', async () => {
  const layout = layoutForRealMachine('cx16', { facts: CX16_FACTS });
  assert.ok(layout.glyphBase > layout.rasterBase, 'after the raster list');
  assert.equal(layout.glyphFirst, GLYPH_FIRST);
  assert.equal(layout.glyphCount, GLYPH_COUNT);
  assert.ok(layout.reservedEnd >= layout.glyphBase + GLYPH_COUNT * 8, 'and the program data starts above it');
  const twin = await readFile(join(REPO, 'packages', 'graphics', 'src', 'index.cx16.web.8bs'), 'utf8');
  const constant = (name) => Number(new RegExp(`const ${name}: \\w+ = (\\d+);`).exec(twin)?.[1]);
  assert.equal(constant('GLYPH_BASE'), layout.glyphBase, 'GLYPH_BASE in index.cx16.web.8bs is where the page reads the table (web-layout.mjs agreementFor)');
  assert.equal(constant('GLYPH_FIRST'), layout.glyphFirst);
  assert.equal(constant('GLYPH_COUNT'), layout.glyphCount);
  // The machines with their own ROM or RAM glyphs keep no such table.
  for (const target of ['c64', 'vic20', 'pet']) assert.equal(layoutForRealMachine(target, { facts: {} }).glyphBase, -1, `${target} has none`);
});

/** An X, as eight rows of eight bits (bit 7 the leftmost pixel): asymmetric enough that a flip or a shift shows. */
const PICTURE = [0b10000001, 0b01000011, 0b00100101, 0b00011001, 0b00011000, 0b00100100, 0b01000010, 0b10000001];

async function writePicture(dir) {
  const rgba = new Uint8Array(8 * 8 * 4);
  PICTURE.forEach((bits, y) => {
    for (let x = 0; x < 8; x += 1) {
      const at = (y * 8 + x) * 4;
      if ((bits >> (7 - x)) & 1) rgba.set([255, 255, 255, 255], at);
    }
  });
  await writeFile(join(dir, 'dot.png'), encodePNG(8, 8, rgba));
  await writeFile(join(dir, 'dot.8bg'), 'sprite dot {\n  source "./dot.png"\n  size 8x8\n  transparent auto\n}\n');
}

test('a .8bg picture on the X16 wasm build is drawn, pixel for pixel, in VERA blue over black', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-cx16-'));
  try {
    await writePicture(dir);
    await writeFile(join(dir, 'main.8bs'), [
      'import { screen, BorderColor, BackgroundColor } from "@8bitscript/screen";',
      'import { graphics } from "@8bitscript/graphics";',
      'import { dot } from "./dot.8bg";',
      '',
      'export function main(): void {',
      '    screen.blank(BorderColor.BLUE, BackgroundColor.BLACK);',
      '    graphics.place(dot, 0, 0);',
      '    while (true) {',
      '        waitFrame();',
      '        graphics.update();',
      '    }',
      '}',
      '',
    ].join('\n'));
    const png = await shoot(dir, 'main.8bs');
    const blue = rgb(VERA_PALETTE[6]);
    const white = rgb(VERA_PALETTE[1]);
    const black = rgb(VERA_PALETTE[0]);
    assert.ok(same(pixelAt(png, 4, 4), blue), 'the border is VERA blue (#0000aa), not the C64 blue');
    assert.ok(same(pixelAt(png, 300, 240), black), 'the screen is black');
    for (let gy = 0; gy < 8; gy += 1) {
      for (let gx = 0; gx < 8; gx += 1) {
        const want = (PICTURE[gy] >> (7 - gx)) & 1 ? white : black;
        assert.ok(same(pixelAt(png, BORDER_PX + gx, BORDER_PX + gy), want), `picture pixel (${gx}, ${gy}) is ${want === white ? 'lit' : 'dark'}`);
      }
    }
    // Nothing else drawn: the cell to its right and the one below are blanks.
    for (let k = 0; k < 8; k += 1) {
      assert.ok(same(pixelAt(png, BORDER_PX + 8 + k, BORDER_PX + k), black), 'the next cell is blank');
      assert.ok(same(pixelAt(png, BORDER_PX + k, BORDER_PX + 8 + k), black), 'and the row below');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Studio renders on the X16 wasm build: VERA blue border, black screen, its mark at the corner', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-studio-'));
  try {
    await cp(join(REPO, 'packages', 'studio', 'src'), join(dir, 'src'), { recursive: true });
    const png = await shoot(dir, join('src', 'main.8bs'), { frames: 8 });
    assert.ok(same(pixelAt(png, 4, 4), rgb(VERA_PALETTE[6])), 'the border is BorderColor.BLUE as x16emu draws it');
    assert.ok(same(pixelAt(png, 300, 240), rgb(VERA_PALETTE[0])), 'the screen is black');
    // The mark is mark.png, 8x8, at cell (0, 0): it lights something there and nothing outside that cell.
    const lit = (x0, y0) => {
      let n = 0;
      for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) if (same(pixelAt(png, BORDER_PX + x0 + x, BORDER_PX + y0 + y), rgb(VERA_PALETTE[1]))) n += 1;
      return n;
    };
    assert.ok(lit(0, 0) > 4, 'the mark is drawn in its cell');
    assert.equal(lit(8, 0) + lit(0, 8) + lit(8, 8), 0, 'and only there');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
