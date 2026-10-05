// Reverse video and the live character set on the PET and the VIC-20 wasm pages
// (docs/project/wasm-primary.md, backlog item 1). On both machines a screen
// code with bit 7 set is the same glyph with every pixel inverted, and which of
// the two ROM sets draws is a register the program writes: the PET's VIA control
// register ($E84C, bit 1) and the VIC-20's memory pointer ($9005, low nybble).
// The values below are the ROM's own bytes (VICE's characters-2.901447-10.bin and
// chargen-901460-03.bin), bit-reversed to this renderer's bit-0-leftmost order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { glyphRows, glyphTableLiteral } from '../src/font8x8.mjs';
import { PET_GRAPHICS_B64, PET_2001_GRAPHICS_B64, VIC20_UPPER_B64 } from '../src/font-roms.mjs';
import { renderLoader } from '../src/web-loader.mjs';
import { BORDER_PX, layoutForRealMachine } from '../src/web-layout.mjs';
import { renderFrame, rgbPalette } from '../src/web-scanline.mjs';

const PET_PCR = 0xe84c;
const VIC_POINTER = 0x9005;
const A = [24, 36, 66, 126, 66, 66, 66, 0]; // upper-case A
const LOWER_A = [0, 0, 28, 32, 60, 34, 92, 0];
const A_REVERSED = [231, 219, 189, 129, 189, 189, 189, 255];
const LOWER_A_REVERSED = [255, 255, 227, 223, 195, 221, 163, 255];
const HALF_BLOCK = [0, 0, 0, 0, 255, 255, 255, 255]; // PETSCII screen code 98, the lower half block

const petLayout = (swapped = false) => layoutForRealMachine('pet', {
  facts: { 'video.columns': 40, 'video.rows': 25, 'video.characterSetSwapped': swapped },
});
const vicLayout = () => layoutForRealMachine('vic20', { facts: { 'video.columns': 22, 'video.rows': 23 }, tags: [] });

/** The eight row bytes a cell drew (bit 0 the leftmost pixel), read back from a frame. */
function cellRows(frame, col, row, ink) {
  const rows = [];
  for (let y = 0; y < 8; y += 1) {
    let bits = 0;
    for (let x = 0; x < 8; x += 1) {
      const i = ((BORDER_PX + row * 8 + y) * frame.width + BORDER_PX + col * 8 + x) * 4;
      if (frame.rgba[i] === ink[0] && frame.rgba[i + 1] === ink[1] && frame.rgba[i + 2] === ink[2]) bits |= 1 << x;
    }
    rows.push(bits);
  }
  return rows;
}

/** renderFrame, and the generated loader's paint() over the same memory — which must agree. */
function paintBoth(layout, mem) {
  const palette = rgbPalette(layout.palette);
  const mine = renderFrame(mem, { ...layout, border: BORDER_PX }, palette);
  const self = {};
  runInNewContext(renderLoader({ frameRate: 60, layout }), { self, console });
  let image = null;
  self.EightBitScript.paint({
    canvas: { width: mine.width, height: mine.height },
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (next) => { image = next; },
  }, mem, BORDER_PX);
  assert.ok(image, 'paint() must put an ImageData back');
  assert.ok(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).equals(Buffer.from(mine.rgba)),
    'the page and the screenshot rasterizer must paint identical pixels');
  return { frame: mine, ink: palette[1] };
}

test('font-roms.mjs holds three 1024-byte graphics sets (128 glyphs each)', () => {
  for (const b64 of [PET_GRAPHICS_B64, PET_2001_GRAPHICS_B64, VIC20_UPPER_B64]) {
    assert.equal(Buffer.from(b64, 'base64').length, 1024);
  }
});

test('every named PET and VIC-20 font draws a code with bit 7 set as the glyph of code − 128 inverted', () => {
  for (const font of ['pet-2001-screencode', 'pet-text-screencode', 'pet-2001-graphics-screencode', 'pet-graphics-screencode',
    'vic20-text-screencode', 'vic20-upper-screencode']) {
    for (let code = 0; code < 128; code += 1) {
      const plain = [...glyphRows(code, font)];
      const reversed = [...glyphRows(code + 128, font)];
      assert.deepEqual(reversed, plain.map((b) => b ^ 0xff), `${font} code ${code + 128}`);
    }
    assert.equal(glyphRows(256, font), null, `${font}: past 255 there is nothing`);
  }
});

test('the boot sets are the ROMs\' graphics and upper-case halves, screen-code indexed', () => {
  // The upper-case A is code 1 in the boot set and code 65 in the text set; code 1 of the text set is a lower-case a.
  for (const font of ['pet-graphics-screencode', 'pet-2001-graphics-screencode', 'vic20-upper-screencode']) {
    assert.deepEqual([...glyphRows(1, font)], A, `${font}: code 1 is A`);
    assert.deepEqual([...glyphRows(129, font)], A_REVERSED, `${font}: code 129 is A reversed`);
  }
  assert.deepEqual([...glyphRows(1, 'pet-text-screencode')], LOWER_A);
  assert.deepEqual([...glyphRows(129, 'pet-text-screencode')], LOWER_A_REVERSED);
  // The PETSCII lower-half block (screen code 98) — what the quadrant objects draw — is a real glyph of the boot set.
  assert.deepEqual([...glyphRows(98, 'pet-graphics-screencode')], HALF_BLOCK);
  assert.deepEqual([...glyphRows(98, 'vic20-upper-screencode')], HALF_BLOCK);
  // Reversed space is a solid cell, which the page's table must keep (only all-zero glyphs are left out of it).
  assert.ok(glyphTableLiteral('pet-graphics-screencode').includes('160:[255,255,255,255,255,255,255,255]'));
});

test('a PET boots in the graphics set, switches to text with $E84C bit 1, and draws screen codes ≥ 128 inverted', () => {
  const layout = petLayout();
  const mem = new Uint8Array(65536);
  mem[layout.charBase + 0] = 1; // A / a
  mem[layout.charBase + 1] = 129; // ...reversed
  mem[layout.charBase + 2] = 98; // the lower half block
  const cell = (frame, ink, col) => cellRows(frame, col, 0, ink);

  let { frame, ink } = paintBoth(layout, mem); // PCR = 0: the set the machine boots in
  assert.deepEqual(cell(frame, ink, 0), A, 'boot set: code 1 is a capital A');
  assert.deepEqual(cell(frame, ink, 1), A_REVERSED, 'code 129 is A with every pixel inverted');
  assert.deepEqual(cell(frame, ink, 2), HALF_BLOCK, 'code 98 is the lower half block');

  mem[PET_PCR] = 14; // POKE 59468,14: lower and upper case
  ({ frame, ink } = paintBoth(layout, mem));
  assert.deepEqual(cell(frame, ink, 0), LOWER_A, 'text set: code 1 is a lower-case a');
  assert.deepEqual(cell(frame, ink, 1), LOWER_A_REVERSED);

  mem[PET_PCR] = 12; // POKE 59468,12: back to graphics
  ({ frame, ink } = paintBoth(layout, mem));
  assert.deepEqual(cell(frame, ink, 0), A);
});

test('a 2001 draws its own ROM\'s sets, switched the same way', () => {
  const layout = petLayout(true);
  const mem = new Uint8Array(65536);
  mem[layout.charBase] = 1;
  let { frame, ink } = paintBoth(layout, mem);
  assert.deepEqual(cellRows(frame, 0, 0, ink), A, 'the 2001 also boots in its graphics and upper-case set');
  mem[PET_PCR] = 14;
  ({ frame, ink } = paintBoth(layout, mem));
  assert.deepEqual(cellRows(frame, 0, 0, ink), [...glyphRows(1, 'pet-2001-screencode')], 'text set: the 2001 ROM\'s own');
});

test('a VIC-20 boots in the upper-case and graphics set, switches with the low nybble of $9005, and draws reverse video', () => {
  const layout = vicLayout();
  const mem = new Uint8Array(65536);
  mem[layout.charBase + 0] = 1;
  mem[layout.charBase + 1] = 129;
  mem[layout.charBase + 2] = 98;
  for (let i = 0; i < 3; i += 1) mem[layout.colorBase + i] = 1; // white ink
  mem[VIC_POINTER] = 0xf0; // screen $1E00, chargen $8000: what text.8bs stores (MEMORY_POINTER_UPPERCASE)
  let { frame, ink } = paintBoth(layout, mem);
  assert.deepEqual(cellRows(frame, 0, 0, ink), A, 'boot set: code 1 is a capital A, not the lower-case a the old page drew');
  assert.deepEqual(cellRows(frame, 1, 0, ink), A_REVERSED);
  assert.deepEqual(cellRows(frame, 2, 0, ink), HALF_BLOCK);

  mem[VIC_POINTER] = 0xf2; // chargen $8800: lower and upper case
  ({ frame, ink } = paintBoth(layout, mem));
  assert.deepEqual(cellRows(frame, 0, 0, ink), LOWER_A, 'nybble 2: code 1 is a lower-case a');
  assert.deepEqual(cellRows(frame, 1, 0, ink), LOWER_A_REVERSED);
});
