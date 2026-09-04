// The Commander X16 target package: `border` through a VERA active-area
// inset, `background` painted into every cell's attribute byte, and a
// `screen` namespace that speaks ASCII because LLVM-MOS's start-up leaves
// the KERNAL in ISO mode. See packages/cx16/src/index.8bs for the why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';
import { emitC } from '../../backend-6502/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BORDERS_SRC = join(HERE, '..', '..', '..', 'examples', 'borders', 'src');
const ENTRY = join(BORDERS_SRC, 'cx16-consumer.8bs');

test('a screen consumer links for cx16 and drives VERA by its port addresses', () => {
  const consumer = [
    'import { border, background, applyColors, screen } from "@8bitscript/machine";',
    'export function main(): void {',
    '    screen.putChar(162, 84);',
    '    screen.putColor(162, 1);',
    '    border = 6;',
    '    background = 3;',
    '    applyColors();',
    '    screen.showDigit(167, 2);',
    '}',
  ].join('\n');
  const { ir, diagnostics } = link(consumer, ENTRY, { machine: 'cx16' });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.nativeSources, []); // the X16 ships no native files

  const c = emitC(ir, { machine: 'cx16' });
  // ASCII in, unmapped: 'T' is written as 84.
  assert.match(c, /screen_putChar\(162, 84\);/);
  // The VERA address port: $9F20 (40736) low, $9F21 (40737) high, $9F22
  // (40738) bank 1 + step; DATA0 $9F23 (40739) carries the byte.
  assert.match(c, /\*\(volatile uint8_t \*\)40736 = \(low % 256\);/);
  assert.match(c, /\*\(volatile uint8_t \*\)40738 = \(bank \+ \(stepIndex \* 16\)\);/);
  assert.match(c, /\*\(volatile uint8_t \*\)40739 = code;/);
  // The map base is read from L1_MAPBASE ($9F35 = 40757), never assumed:
  // bit 7 is VRAM bit 16, the rest is the address >> 9.
  assert.match(c, /mapBank = \(\(\*\(volatile uint8_t \*\)40757\) \/ 128\);/);
  assert.match(c, /mapLow = \(\(\*\(volatile uint8_t \*\)40757\) % 128\);\n\s+mapLow = \(mapLow \* 512\);/);
  // Cell -> VRAM: base + row*256 + col*2 for the char byte.
  assert.match(c, /setVramAddress\(mapBank, \(\(mapLow \+ \(\(cell \/ 80\) \* 256\)\) \+ \(\(cell % 80\) \* 2\)\), 0\);/);
  assert.doesNotMatch(c, /45056|0xB000|1B000/i); // no hardcoded $1B000 anywhere
  // applyColors: DCSEL=1 ($9F25 = 40741 := 2), the four edges, DCSEL=0,
  // then the border register ($9F2C = 40748) — in that order, so the
  // border write can never land on VSTOP.
  assert.match(c, /40741 = 2;\n\s+\*\(volatile uint8_t \*\)40745 = 4;\n\s+\*\(volatile uint8_t \*\)40746 = 156;\n\s+\*\(volatile uint8_t \*\)40747 = 8;\n\s+\*\(volatile uint8_t \*\)40748 = 232;\n\s+\*\(volatile uint8_t \*\)40741 = 0;\n\s+\*\(volatile uint8_t \*\)40748 = border;/);
  // Layer 1 vertical scroll 510 ($9F39 = 40761 := $FE, $9F3A = 40762 := 1):
  // the two-line correction that puts cell (0,0) on the active area's
  // first line under x16emu — see the package header.
  assert.match(c, /40761 = 254;\n\s+\*\(volatile uint8_t \*\)40762 = 1;/);
  // The attribute repaint covers all 64 map rows: background high nibble,
  // white low; row 63's characters blanked.
  assert.match(c, /while \(\(paintRow < 64\)\)/);
  assert.match(c, /40739 = \(\(background \* 16\) \+ 1\);/);
});

test('examples/borders main.8bs links clean for cx16', () => {
  const file = join(BORDERS_SRC, 'main.8bs');
  const { ir, diagnostics } = link(readFileSync(file, 'utf8'), file, { machine: 'cx16' });
  assert.deepEqual(diagnostics, []);
  assert.ok(ir.functions.some((fn) => fn.name === 'frame'));
});
