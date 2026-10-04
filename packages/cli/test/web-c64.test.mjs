// The C64's wasm build, end to end and pixel for pixel: a real .8bs program
// for the C64 is built through the wasm backend (`--web`), run in Node's
// WebAssembly, and painted by the same compositor and memory map the browser
// page uses (captureScreenshot with `web: true`, which is what `8bs run c64
// --web --screenshot` calls). No emulator is involved, which is why this runs
// in CI where the machine package's own x64sc tests cannot.
//
// The expected pictures are not typed in: every cell is compared with the
// character ROM's own bytes, read out of packages/c64/src/chargen.8bs (the
// data the web twin of setupVideo() copies to the character RAM), so a glyph
// that is wrong by one pixel, in the wrong set, or in the wrong colour fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { pixelAt } from '../src/png.mjs';
import { BORDER_PX, C64_PALETTE, layoutForRealMachine } from '../src/web-layout.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PROBE = join(REPO, 'packages', 'c64', 'test', 'web-text-probe.8bs');

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

/** The character ROM, as the program's data: 4096 bytes, set 0 then set 1. */
async function characterRom() {
  const text = await readFile(join(REPO, 'packages', 'c64', 'src', 'chargen.8bs'), 'utf8');
  const bytes = [...text.slice(text.indexOf('= [')).matchAll(/0x([0-9A-F]{2})/g)].map((m) => Number.parseInt(m[1], 16));
  assert.equal(bytes.length, 4096, 'chargen.8bs holds the whole 4K character ROM');
  return Uint8Array.from(bytes);
}

const RGB = C64_PALETTE.map((hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)));
const sameInk = (px, ink) => px[0] === ink[0] && px[1] === ink[1] && px[2] === ink[2];

/** Builds `source` for the C64 through the wasm backend and returns its screenshot. */
async function shoot(source, { frames = 2 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-c64-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), source);
    process.chdir(dir);
    const result = await silently(() => compile('c64', join(dir, 'main.8bs'), { checkout: REPO, web: true }));
    assert.equal(result.ok, true, 'builds for the C64 through the wasm backend');
    const shot = join(dir, 'out.png');
    await captureScreenshot('c64', result.outFile, shot, { frames, hardware: result.hardware, web: true });
    return await readFile(shot);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether cell (col, row) shows glyph `code` of ROM set `set` in `ink` over `paper`, every pixel of the 8x8. */
function cellIs(png, rom, col, row, code, set, ink, paper) {
  for (let gy = 0; gy < 8; gy += 1) {
    const bits = rom[set * 2048 + code * 8 + gy];
    for (let gx = 0; gx < 8; gx += 1) {
      const want = ((bits >> (7 - gx)) & 1) !== 0 ? ink : paper;
      if (!sameInk(pixelAt(png, BORDER_PX + col * 8 + gx, BORDER_PX + row * 8 + gy), want)) return false;
    }
  }
  return true;
}

/** Like cellIs, with the whole row shifted right by `shift` pixels (a $D016 fine scroll): glyph column gx lands at x + shift. */
function shiftedCellIs(png, rom, col, row, code, set, ink, paper, shift) {
  for (let gy = 0; gy < 8; gy += 1) {
    const bits = rom[set * 2048 + code * 8 + gy];
    for (let gx = 0; gx < 8; gx += 1) {
      const want = ((bits >> (7 - gx)) & 1) !== 0 ? ink : paper;
      if (!sameInk(pixelAt(png, BORDER_PX + col * 8 + gx + shift, BORDER_PX + row * 8 + gy), want)) return false;
    }
  }
  return true;
}

/** The mixed-case set's screen code for an ASCII character, as text.8bs maps it. */
const screenCode = (ch) => {
  const c = ch.charCodeAt(0);
  return c >= 97 && c <= 122 ? c - 96 : c;
};

test('the layout the page paints the C64 from names the real VIC-II registers and the character RAM', () => {
  const layout = layoutForRealMachine('c64', { facts: { 'video.columns': 40, 'video.rows': 25 } });
  assert.equal(layout.charBase, 0xe000, 'the screen matrix is where geometry.8bs puts it');
  assert.equal(layout.colorBase, 0xd800, 'colour RAM is fixed at $D800');
  assert.deepEqual(layout.vic, {
    charsetBase: 0xc000, setStride: 0x800, selectRegister: 0xd018, selectMask: 0x02,
    borderRegister: 0xd020, backgroundRegister: 0xd021, scrollRegister: 0xd016,
  });
  assert.equal(layout.colorPerCell, true);
  assert.deepEqual(layout.reservedRanges, [{ start: 0xc000, end: 0xd000, label: "the C64's character RAM" }]);
});

test('hello-world on the C64 wasm build draws "Hello World!" in the ROM\'s own mixed-case glyphs on a black screen', async () => {
  const rom = await characterRom();
  const png = await shoot([
    'import { screen } from "@8bitscript/screen";',
    'import { text } from "@8bitscript/text";',
    '',
    'export function main(): void {',
    '    screen.blank();',
    '    text.print(0, "Hello World!");',
    '    text.releaseCursor();',
    '}',
    '',
  ].join('\n'));
  const black = RGB[0];
  const white = RGB[1];
  [...'Hello World!'].forEach((ch, col) => {
    assert.ok(cellIs(png, rom, col, 0, screenCode(ch), 1, white, black), `cell ${col} draws '${ch}' from the lower/upper-case set`);
  });
  // Every other cell is a blank: screen.blank() filled all 1000 with the space code
  // (the index `i + 250` must not wrap at 8 bits, or rows 7 and below are screen code 0, '@').
  for (const [col, row] of [[12, 0], [39, 0], [0, 1], [39, 6], [0, 7], [20, 12], [0, 24], [39, 24]]) {
    assert.ok(cellIs(png, rom, col, row, 32, 1, white, black), `cell (${col}, ${row}) is a blank`);
  }
  assert.ok(sameInk(pixelAt(png, 2, 2), black), 'the border is black');
});

test('border, background, ink, reverse video, a redefined glyph and the upper-case set all come from the program\'s own registers and memory', async () => {
  const rom = await characterRom();
  const png = await shoot(await readFile(PROBE, 'utf8'));
  const lightBlue = RGB[14];
  const blue = RGB[6];
  assert.ok(sameInk(pixelAt(png, 2, 2), lightBlue), 'the border is $D020: light blue');
  assert.ok(sameInk(pixelAt(png, 2, 100), lightBlue), 'on every side');
  assert.ok(cellIs(png, rom, 30, 12, 32, 0, RGB[1], blue), 'a blank cell is $D021: blue');

  // The probe ends with charset.useUppercase(): $D018 bit 1 clear, so set 0.
  // "Hello World!" in white — screen codes of the mixed-case mapping, drawn from set 0.
  [...'Hello World!'].forEach((ch, col) => {
    assert.ok(cellIs(png, rom, col, 0, screenCode(ch), 0, RGB[1], blue), `row 0 col ${col}: '${ch}' in white, from the upper-case set`);
  });
  // "Mixed Case abc" in yellow (cell 40 = row 1) — except the 'a's, which are glyph 1, redefined below.
  const GLYPH_1 = [0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55];
  const mixed = [...'Mixed Case abc'];
  mixed.forEach((ch, col) => {
    const code = screenCode(ch);
    if (code === 1) return;
    assert.ok(cellIs(png, rom, col, 1, code, 0, RGB[7], blue), `row 1 col ${col}: '${ch}' in yellow`);
  });
  // Reverse: "REVERSE" in red is screen code | 128 — the ROM's reversed copies.
  [...'REVERSE'].forEach((ch, col) => {
    assert.ok(cellIs(png, rom, col, 2, screenCode(ch) + 128, 0, RGB[2], blue), `row 2 col ${col}: reversed '${ch}' in red`);
  });
  // printNumber(120, 12345, 5) in green; fill(160, 4, 45) = four '-' in green.
  [...'12345'].forEach((ch, col) => {
    assert.ok(cellIs(png, rom, col, 3, screenCode(ch), 0, RGB[5], blue), `row 3 col ${col}: '${ch}' in green`);
  });
  for (let col = 0; col < 4; col += 1) assert.ok(cellIs(png, rom, col, 4, 45, 0, RGB[5], blue), `row 4 col ${col}: '-' in green`);
  // The redefined glyph: screen code 1, three cyan cells at row 5, drawn from the character RAM
  // the program wrote (charset.define), not from the ROM.
  for (let col = 0; col < 3; col += 1) {
    for (let gy = 0; gy < 8; gy += 1) {
      for (let gx = 0; gx < 8; gx += 1) {
        const want = ((GLYPH_1[gy] >> (7 - gx)) & 1) !== 0 ? RGB[3] : blue;
        assert.ok(sameInk(pixelAt(png, BORDER_PX + col * 8 + gx, BORDER_PX + 5 * 8 + gy), want), `row 5 col ${col} pixel (${gx}, ${gy}) is the redefined checkerboard`);
      }
    }
  }
  // And the same redefinition shows on the 'a's of row 1 (cells 11 and 12 of "Mixed Case abc" hold 'a').
  const aCol = mixed.indexOf('a');
  assert.notEqual(aCol, -1);
  assert.ok(!cellIs(png, rom, aCol, 1, 1, 0, RGB[7], blue), "row 1's 'a' is not the ROM's A any more");
});

test('charset.restore() puts the ROM\'s glyphs back, and a program that never calls useUppercase() draws the lower/upper-case set', async () => {
  const rom = await characterRom();
  const png = await shoot([
    'import { screen } from "@8bitscript/screen";',
    'import { text } from "@8bitscript/text";',
    'import { charset } from "@8bitscript/c64/charset";',
    '',
    'export function main(): void {',
    '    screen.blank();',
    '    text.print(0, "abc");',
    '    charset.useUppercase();',
    '    charset.define(1, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF);',
    '    charset.define(200, 0xFF, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xFF);',
    '    text.setColor(TextColor.WHITE);',
    '    charset.restore();',
    '}',
    '',
  ].join('\n').replace('import { text } from "@8bitscript/text";', 'import { text, TextColor } from "@8bitscript/text";'));
  // restore() recopies both sets, so glyph 1 of set 0 is the ROM's 'A' again, and
  // the set the screen shows is $D018's: useUppercase() left it on set 0.
  [...'abc'].forEach((ch, col) => {
    assert.ok(cellIs(png, rom, col, 0, screenCode(ch), 0, RGB[1], RGB[0]), `cell ${col} is the ROM's glyph ${screenCode(ch)} of set 0 after restore()`);
  });
});

test('the portable raster list on the C64 wasm build applies each slot at its picture line: colours, fine scroll, character set', async () => {
  const rom = await characterRom();
  const png = await shoot(await readFile(join(REPO, 'packages', 'c64', 'test', 'web-raster-probe.8bs'), 'utf8'));
  const green = RGB[5];
  const red = RGB[2];
  const blue = RGB[6];
  const black = RGB[0];
  const white = RGB[1];
  // BORDER at line 40 and back at 160: the border strip changes exactly there.
  assert.ok(sameInk(pixelAt(png, 2, BORDER_PX + 39), green), "border above line 40: the program's green");
  assert.ok(sameInk(pixelAt(png, 2, BORDER_PX + 40), red), 'border from line 40: red');
  assert.ok(sameInk(pixelAt(png, 2, BORDER_PX + 159), red), 'still red on line 159');
  assert.ok(sameInk(pixelAt(png, 2, BORDER_PX + 160), green), 'green again from line 160');
  // BACKGROUND likewise: a blank cell above the band is black, inside it blue, below it black.
  assert.ok(cellIs(png, rom, 30, 4, 32, 1, white, black), 'cell row 4 (lines 32-39): black');
  assert.ok(cellIs(png, rom, 30, 5, 32, 1, white, blue), 'cell row 5 (lines 40-47): blue');
  assert.ok(cellIs(png, rom, 30, 19, 32, 1, white, blue), 'cell row 19 (lines 152-159): blue');
  assert.ok(cellIs(png, rom, 30, 20, 32, 1, white, black), 'cell row 20 (lines 160-167): black again');
  // SCROLL_X 3 on lines 80-99: "scroll" on cell rows 10 and 11 sits three pixels right, its first three columns blue.
  [...'scroll'].forEach((ch, col) => {
    for (const row of [10, 11]) {
      assert.ok(shiftedCellIs(png, rom, col, row, screenCode(ch), 1, white, blue, 3), `row ${row} col ${col}: '${ch}' shifted by 3`);
    }
  });
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      assert.ok(sameInk(pixelAt(png, BORDER_PX + x, BORDER_PX + 80 + y), blue), `a scrolled line opens its first pixels as background (${x}, ${80 + y})`);
    }
  }
  // CHARSET 0 on lines 120-139: the same "abc" is lower case on row 14 (set 1) and capitals on rows 15 and 16 (set 0).
  [...'abc'].forEach((ch, col) => {
    assert.ok(cellIs(png, rom, col, 14, screenCode(ch), 1, white, blue), `row 14: '${ch}' in the lower/upper-case set`);
    assert.ok(cellIs(png, rom, col, 15, screenCode(ch), 0, white, blue), 'row 15: the same code in the upper-case/graphics set');
    assert.ok(cellIs(png, rom, col, 16, screenCode(ch), 0, white, blue), 'row 16: and again');
  });
});

test("the C64 raster twin's list offsets are the ones the page reads for this machine", async () => {
  const layout = layoutForRealMachine('c64', { facts: { 'video.columns': 40, 'video.rows': 25 } });
  const twin = await readFile(join(REPO, 'packages', 'c64', 'src', 'rasterline.c64.web.8bs'), 'utf8');
  const constant = (name) => Number(new RegExp(`const ${name}: usmallint = (\\d+);`).exec(twin)?.[1]);
  assert.equal(constant('LIST_CONTROL'), layout.rasterControlOffset);
  assert.equal(constant('LIST_COUNT'), layout.rasterCountOffset);
  assert.equal(constant('LIST_BASE'), layout.rasterBase);
});
