// The VIC-20's portable raster list on its wasm build, end to end and pixel for
// pixel: a real .8bs program for the VIC-20 is built through the wasm backend
// (`--web`), run in Node's WebAssembly, and painted by the same compositor and
// memory map the browser page uses (captureScreenshot with `web: true`, which is
// what `8bs run vic20 --web --screenshot` calls). No emulator is involved, which
// is why this runs in CI where the machine package's own xvic tests cannot.
//
// The VIC-20 has no interrupt: natively `waitFrame()` calls a machine-code hook
// that busy-waits down the frame and writes $900F at each planned line. The wasm
// backend never lowers machine code, so the package links a `.web` twin of
// rasterline.8bs (packages/vic20/src/rasterline.vic20.web.8bs) that writes the
// page's picture-line list instead, and the page reads the border, background
// and character set from $900F and $9005 the way the chip does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { glyphRows } from '../src/font8x8.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { pixelAt } from '../src/png.mjs';
import { BORDER_PX, VIC20_PALETTE, layoutForRealMachine } from '../src/web-layout.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const FONT = 'vic20-text-screencode';
const VICE_ROM = '/opt/homebrew/share/vice/VIC20/chargen-901460-03.bin';

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

const RGB = VIC20_PALETTE.map((hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)));
const sameInk = (px, ink) => px[0] === ink[0] && px[1] === ink[1] && px[2] === ink[2];

/** Builds `source` (or the file `entry`) for the VIC-20 through the wasm backend and returns its screenshot. */
async function shoot({ source = null, entry = null, frames = 2 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-vic20-'));
  const prev = process.cwd();
  try {
    let file = entry;
    if (source !== null) {
      file = join(dir, 'main.8bs');
      await writeFile(file, source);
    }
    process.chdir(dir);
    const result = await silently(() => compile('vic20', file, { checkout: REPO, web: true }));
    assert.equal(result.ok, true, `builds for the VIC-20 through the wasm backend: ${JSON.stringify(result.diagnostics?.slice?.(0, 2))}`);
    const shot = join(dir, 'out.png');
    await captureScreenshot('vic20', result.outFile, shot, { frames, hardware: result.hardware, web: true });
    return await readFile(shot);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether cell (col, row) shows glyph `code` of character set `set` in `ink` over `paper`, every pixel of the 8x8. */
function cellIs(png, col, row, code, set, ink, paper) {
  const rows = glyphRows(code, FONT, set);
  for (let gy = 0; gy < 8; gy += 1) {
    for (let gx = 0; gx < 8; gx += 1) {
      const want = ((rows[gy] >> gx) & 1) !== 0 ? ink : paper;
      if (!sameInk(pixelAt(png, BORDER_PX + col * 8 + gx, BORDER_PX + row * 8 + gy), want)) return false;
    }
  }
  return true;
}

const screenCode = (ch) => {
  const c = ch.charCodeAt(0);
  return c >= 97 && c <= 122 ? c - 96 : c;
};

test('the portable raster list on the VIC-20 wasm build applies each slot at its picture line: colours and character set', async () => {
  const png = await shoot({ entry: join(REPO, 'packages', 'vic20', 'test', 'web-raster-probe.8bs') });
  const green = RGB[5];
  const red = RGB[2];
  const blue = RGB[6];
  const black = RGB[0];
  const white = RGB[1];
  // The base is $900F as the program wrote it: green border, black background, before any entry.
  assert.ok(sameInk(pixelAt(png, 2, 2), green), "above the picture: the border is the program's green ($900F)");
  assert.ok(sameInk(pixelAt(png, 2, BORDER_PX + 39), green), 'border above line 40: green');
  // BORDER at line 40 and back at 160: the border strip changes exactly there.
  assert.ok(sameInk(pixelAt(png, 2, BORDER_PX + 40), red), 'border from line 40: red');
  assert.ok(sameInk(pixelAt(png, 2, BORDER_PX + 159), red), 'still red on line 159');
  assert.ok(sameInk(pixelAt(png, 2, BORDER_PX + 160), green), 'green again from line 160');
  assert.ok(sameInk(pixelAt(png, 2, BORDER_PX + 183), green), 'and on the last picture line');
  // BACKGROUND likewise, on the picture's own rows: black, blue from 40, black from 160.
  assert.ok(sameInk(pixelAt(png, BORDER_PX + 120, BORDER_PX + 39), black), 'background on line 39: black');
  assert.ok(sameInk(pixelAt(png, BORDER_PX + 120, BORDER_PX + 40), blue), 'background from line 40: blue');
  assert.ok(sameInk(pixelAt(png, BORDER_PX + 120, BORDER_PX + 159), blue), 'background on line 159: still blue');
  assert.ok(sameInk(pixelAt(png, BORDER_PX + 120, BORDER_PX + 160), black), 'background from line 160: black again');
  // CHARSET 0 on lines 120-139: the same "abc" is lower case on row 14 (the set text.print selected, 1)
  // and capitals on rows 15 and 16 (set 0, the upper-case/graphics block).
  [...'abc'].forEach((ch, col) => {
    assert.ok(cellIs(png, col, 14, screenCode(ch), 1, white, blue), `row 14: '${ch}' in the mixed-case set`);
    assert.ok(cellIs(png, col, 15, screenCode(ch), 0, white, blue), 'row 15: the same code in the upper-case/graphics set');
    assert.ok(cellIs(png, col, 16, screenCode(ch), 0, white, blue), 'row 16: and again');
  });
  assert.ok(!cellIs(png, 0, 15, screenCode('a'), 1, white, blue), 'row 15 is not the mixed-case glyph');
});

test('a program that never prints keeps the set the machine boots into: $9005 names it, not the page', async () => {
  const png = await shoot({
    source: [
      'import { screen } from "@8bitscript/screen";',
      'import { Video } from "@8bitscript/vic20/geometry";',
      'export function main(): void {',
      '    screen.blank();',
      '    memory.write(Video.SCREEN, 1);',
      '    memory.write(Video.COLOR, 1);',
      '    while (true) {',
      '        waitFrame();',
      '    }',
      '}',
      '',
    ].join('\n'),
  });
  assert.ok(cellIs(png, 0, 0, 1, 0, RGB[1], RGB[0]), "screen code 1 is the upper-case set's capital A: the boot block");
  assert.ok(!cellIs(png, 0, 0, 1, 1, RGB[1], RGB[0]), 'and not the mixed-case set\'s lower-case a');
});

test('a raster list refuses what the chip cannot do, as the native layer does', async () => {
  const png = await shoot({
    source: [
      'import { raster, Slot } from "@8bitscript/raster";',
      'import { screen } from "@8bitscript/screen";',
      'import { text } from "@8bitscript/text";',
      'export function main(): void {',
      '    screen.blank();',
      '    raster.clear();',
      '    let a: bool = raster.at(10, Slot.SCROLL_X, 3);',
      '    let b: bool = raster.at(200, Slot.BORDER, 2);',
      '    let c: bool = raster.at(20, Slot.BORDER, 15);',
      '    let d: bool = raster.at(10, Slot.BORDER, 3);',
      '    let n: utinyint = raster.count();',
      '    if (a) { text.print(40, "a"); }',
      '    if (b) { text.print(41, "b"); }',
      '    if (c) { text.print(42, "c"); }',
      '    if (d) { text.print(43, "d"); }',
      '    if (n == 1) { text.print(44, "n"); }',
      '    raster.enable();',
      '    while (true) {',
      '        waitFrame();',
      '    }',
      '}',
      '',
    ].join('\n'),
  });
  // SCROLL_X is refused (the VIC-20 moves the picture in 4-pixel steps), a line past 183 is refused,
  // a border of 15 is accepted and kept to three bits (7, yellow), and a line below the last entry's
  // is refused: exactly one entry is held, and only the accepted `c` printed.
  assert.ok(cellIs(png, 20, 1, screenCode('c'), 1, RGB[1], RGB[0]), 'the border at line 20 was accepted');
  assert.ok(cellIs(png, 0, 2, screenCode('n'), 1, RGB[1], RGB[0]), 'one entry is held');
  for (const [col, ch] of [[18, 'a'], [19, 'b'], [21, 'd']]) {
    assert.ok(!cellIs(png, col, 1, screenCode(ch), 1, RGB[1], RGB[0]), `'${ch}' was refused, so it never printed`);
  }
  assert.ok(sameInk(pixelAt(png, 2, BORDER_PX + 19), RGB[0]), 'the border above the entry is the program\'s black');
  assert.ok(sameInk(pixelAt(png, 2, BORDER_PX + 20), RGB[7]), 'a border of 15 keeps three bits: yellow from line 20');
});

test("the VIC-20 raster twin's list offsets are the ones the page reads for this machine", async () => {
  const layout = layoutForRealMachine('vic20', { facts: { 'video.columns': 22, 'video.rows': 23, 'video.frameRate': 60 }, tags: [] });
  const twin = await readFile(join(REPO, 'packages', 'vic20', 'src', 'rasterline.vic20.web.8bs'), 'utf8');
  const constant = (name) => Number(new RegExp(`const ${name}: usmallint = (\\d+);`).exec(twin)?.[1]);
  assert.equal(constant('LIST_CONTROL'), layout.rasterControlOffset);
  assert.equal(constant('LIST_COUNT'), layout.rasterCountOffset);
  assert.equal(constant('LIST_BASE'), layout.rasterBase);
  // The expanded profiles move the screen, never the grid: the agreement page is the same.
  const expanded = layoutForRealMachine('vic20', { facts: { 'video.columns': 22, 'video.rows': 23, 'video.frameRate': 60 }, tags: ['expanded'] });
  assert.equal(expanded.rasterBase, layout.rasterBase);
});

test('the layout names the two registers the page reads the VIC-20 picture from', () => {
  const layout = layoutForRealMachine('vic20', { facts: { 'video.columns': 22, 'video.rows': 23, 'video.frameRate': 60 }, tags: [] });
  assert.deepEqual(layout.packedRegisters, {
    colorRegister: 0x900f, borderMask: 0x07, backgroundShift: 4, charsetRegister: 0x9005, charsetMask: 0x0f, charsetAlternate: 2,
  });
  assert.equal(layoutForRealMachine('c64', { facts: { 'video.columns': 40, 'video.rows': 25 } }).packedRegisters, undefined, 'only the VIC-20 packs its registers');
});

test('examples/fancy builds for the VIC-20 through the wasm backend and draws its two colour bands', async () => {
  const png = await shoot({ entry: join(REPO, 'packages', 'examples', 'fancy', 'src', 'main.8bs'), frames: 40 });
  // Down the left border strip, the colour changes where fancy's list says: at least two colours inside the picture.
  const colours = new Set();
  for (let y = BORDER_PX; y < BORDER_PX + 184; y += 1) colours.add(pixelAt(png, 2, y).join());
  assert.ok(colours.size >= 2, `fancy's border splits into bands, not one colour (saw ${colours.size})`);
});

// The two tables are the VIC-20's own character ROM, bit-reversed (the font's bit 0 is the left pixel): hold
// them to VICE's binary when it is installed, so a hand-edited table cannot drift from the chip.
test('both character sets are the real ROM, set by set', { skip: !existsSync(VICE_ROM) }, async () => {
  const rom = await readFile(VICE_ROM);
  const reverse = (b) => { let r = 0; for (let i = 0; i < 8; i += 1) if (b & (1 << i)) r |= 1 << (7 - i); return r; };
  for (const [set, offset] of [[0, 0x000], [1, 0x800]]) {
    for (let code = 0; code < 128; code += 1) {
      const rows = glyphRows(code, FONT, set);
      for (let y = 0; y < 8; y += 1) {
        assert.equal(rows[y], reverse(rom[offset + code * 8 + y]), `set ${set}, code ${code}, row ${y}`);
      }
    }
  }
});

test('the two sets differ where the ROM says they do: code 1 is A in one and a in the other', () => {
  const upper = [...glyphRows(1, FONT, 0)];
  const lower = [...glyphRows(1, FONT, 1)];
  assert.notDeepEqual(upper, lower);
  assert.deepEqual(upper, [0x18, 0x24, 0x42, 0x7e, 0x42, 0x42, 0x42, 0x00], 'the capital A');
});
