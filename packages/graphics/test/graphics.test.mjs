import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

test('every twin exports graphics.bind, meta, place, and update', () => {
  for (const name of ['index.8bs', 'index.c64.8bs', 'index.nes.8bs', 'index.pet.8bs', 'index.vic20.8bs']) {
    const src = readFileSync(join(SRC, name), 'utf8');
    assert.match(src, /function bind\(/, name);
    assert.match(src, /function meta\(/, name);
    assert.match(src, /function place\(/, name);
    assert.match(src, /function update\(/, name);
  }
});

test('every twin, the web and X16 included, exports the contract calls and all ten constants', () => {
  for (const name of ['index.8bs', 'index.c64.8bs', 'index.cx16.8bs', 'index.nes.8bs', 'index.pet.8bs', 'index.vic20.8bs', 'index.web.8bs']) {
    const src = readFileSync(join(SRC, name), 'utf8');
    for (const fn of ['hide', 'setFrame', 'animate', 'color']) {
      assert.match(src, new RegExp(`function ${fn}\\(`), `${name}: ${fn}`);
    }
    for (const constant of ['MAX', 'FRAMES', 'WIDTH', 'HEIGHT', 'COLORS', 'RECOLORS', 'STEP_X', 'STEP_Y', 'RESTORES', 'TRANSPARENT']) {
      assert.match(src, new RegExp(`^    const ${constant}: (?:utinyint|bool) = `, 'm'), `${name}: graphics.${constant}`);
    }
  }
});

// ---- web (packages/web/media/index.cjs + src/index.web.8bs) ----------------

test('the web twin exports graphics.bind, meta, place, and update', () => {
  const src = readFileSync(join(SRC, 'index.web.8bs'), 'utf8');
  for (const fn of ['bind', 'meta', 'place', 'update']) {
    assert.match(src, new RegExp(`function ${fn}\\(`), fn);
  }
});

test('the web twin holds exactly as many animation steps as the web lowering keeps', async () => {
  const src = readFileSync(join(SRC, 'index.web.8bs'), 'utf8');
  const steps = Number(/const STEPS: utinyint = (\d+);/.exec(src)?.[1]);
  const { default: web } = await import('../../web/media/index.cjs');
  assert.equal(steps, web.MAX_STEPS);
  // codes is MAX pictures × STEPS steps, indexed (slot << 3) + step.
  const max = Number(/^const SLOTS: utinyint = (\d+);/m.exec(src)?.[1]);
  assert.equal(Number(/let codes: array<u8, (\d+)>;/.exec(src)?.[1]), max * steps);
  assert.equal(steps, 8, 'the (slot << 3) indexing assumes eight steps');
});

// --- C64 twin: capacity and colour (packages/c64/test/graphics.test.mjs runs it) ---

test('the C64 twin holds as many graphics sprites as the multiplexer has virtual ones, and colours each from its kind byte', () => {
  const src = readFileSync(join(SRC, 'index.c64.8bs'), 'utf8');
  assert.match(src, /import \{ multiplex \} from "@8bitscript\/c64\/multiplex";/);
  assert.match(src, /const SLOTS: utinyint = multiplex\.MAX;/);
  assert.match(src, /const MAX: utinyint = SLOTS;/);
  assert.match(src, /let frameCount: array<u8, 24>;/);
  assert.match(src, /sprites\.setColor\(slot, kind >> 4\);/);
  assert.doesNotMatch(src, /sprites\.setColor\(slot, 1\);/, 'the colour is no longer white for every sprite');
});

// ---- Commander X16 (index.cx16.8bs) ----------------------------------------
// The driver and packages/cx16/media/index.cjs are two halves of one format;
// packages/cx16/test/graphics.test.mjs runs it under x16emu. These pin the
// numbers the halves share, so changing one without the other fails here.

test('cx16 twin exports the four graphics members, with a 16-bit bind index', () => {
  const src = readFileSync(join(SRC, 'index.cx16.8bs'), 'utf8');
  assert.match(src, /function bind\(slot: utinyint, index: usmallint, value: utinyint\)/);
  for (const fn of ['meta', 'place', 'update']) assert.match(src, new RegExp(`function ${fn}\\(`));
});

test('cx16 driver and media lowering agree on the palette header, the window, and the sprite kind', () => {
  const driver = readFileSync(join(SRC, 'index.cx16.8bs'), 'utf8');
  const media = readFileSync(join(HERE, '..', '..', 'cx16', 'media', 'index.cjs'), 'utf8');
  // 16 entries x 2 bytes, then pixels.
  assert.match(driver, /const PALETTE_BYTES: utinyint = 32;/);
  assert.match(media, /new Array\(32\)\.fill\(0\)/);
  // A sprite's window of video memory.
  assert.match(driver, /const WINDOW: usmallint = 0x1000;/);
  assert.match(media, /const WINDOW_BYTES = 4096;/);
  // The kind meta() is called with.
  assert.match(driver, /const KIND_CX16: utinyint = 5;/);
  assert.match(media, /const KIND_CX16 = 5;/);
});

test('cx16 sprites keep clear of sprite 0 (the KERNAL mouse cursor) and of the palette below entry 128', () => {
  const src = readFileSync(join(SRC, 'index.cx16.8bs'), 'utf8');
  assert.match(src, /\(wide \+ 1\) \* 8/, 'slot N is VERA sprite N + 1');
  assert.match(src, /const PALETTE_LOW: usmallint = 0xFB00;/, 'palette entry 128 is $1FB00');
  assert.match(src, /const FIRST_PALETTE_OFFSET: utinyint = 8;/, 'attribute palette offset 8 is entry 128');
});
