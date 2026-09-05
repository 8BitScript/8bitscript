// examples/borders is one file for nine machines, and this is what holds
// that: every machine package implements the same two portable surfaces —
// `./screen` (a `screen` namespace with setColors(border, background) and
// the eight shared colour names in `BorderColor` and `BackgroundColor`) and
// `./text` (a `text` namespace with ASCII character codes and a cell 0 at
// the top-left inside the border) — which @8bitscript/screen and
// @8bitscript/text delegate to per machine. A package that drops any of it
// breaks the example for that machine only, which is the kind of thing that
// goes unnoticed until someone builds for it — so the example is linked here
// for every machine, against the real pnpm-linked packages, and each
// package's namespaces are checked by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MACHINES, link, tokenize, parse, lower } from '../index.mjs';
import { emitC } from '../../backend-6502/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BORDERS_MAIN = join(HERE, '..', '..', '..', 'examples', 'borders', 'src', 'main.8bs');
const PACKAGES = join(HERE, '..', '..');

const SHARED_COLORS = ['Black', 'White', 'Red', 'Cyan', 'Purple', 'Green', 'Blue', 'Yellow'];

const moduleIr = (machine, name) => {
  const file = join(PACKAGES, machine, 'src', `${name}.8bs`);
  const src = readFileSync(file, 'utf8');
  const { tokens } = tokenize(src, file);
  const { ast } = parse(tokens, src, file);
  return lower(ast, file).ir;
};

for (const machine of MACHINES) {
  test(`examples/borders main.8bs links clean for ${machine}`, () => {
    const { ir, diagnostics } = link(readFileSync(BORDERS_MAIN, 'utf8'), BORDERS_MAIN, { machine });
    assert.deepEqual(diagnostics, []);
    // One entry, the program; it loops on waitFrame() itself — no frame().
    assert.equal(ir.entry, 'main');
    assert.ok(!ir.functions.some((fn) => fn.name === 'frame'));
  });

  test(`@8bitscript/${machine}/screen exports setColors and the eight shared colour names`, () => {
    const ir = moduleIr(machine, 'screen');
    const screen = ir.namespaces.find((n) => n.name === 'screen');
    assert.ok(screen && screen.exported, `${machine} has no exported screen namespace`);
    assert.deepEqual([...screen.functions.keys()], ['setColors'], `${machine}'s screen surface drifted`);
    assert.equal(screen.consts.size, 0);
    for (const name of ['BorderColor', 'BackgroundColor']) {
      const ns = ir.namespaces.find((n) => n.name === name);
      assert.ok(ns, `${machine} has no ${name} namespace`);
      assert.ok(ns.exported, `${machine}'s ${name} is not exported`);
      for (const colour of SHARED_COLORS) {
        assert.ok(ns.consts.has(colour), `${machine}'s ${name} has no ${colour}`);
      }
    }
  });

  test(`@8bitscript/${machine}/text exports exactly the portable text surface`, () => {
    const ir = moduleIr(machine, 'text');
    const text = ir.namespaces.find((n) => n.name === 'text');
    assert.ok(text && text.exported, `${machine} has no exported text namespace`);
    assert.deepEqual([...text.functions.keys()].sort(), ['putChar', 'putColor', 'showDigit'], `${machine}'s text surface drifted`);
    assert.deepEqual([...text.consts.keys()], ['CellCount'], `${machine}'s text consts drifted`);
    // The helpers (ASCII mapping and the like) are module-private, not
    // members: `text.` is the same set of names on every machine.
    assert.ok(!ir.namespaces.some((n) => n.name === 'screen'), `${machine}'s text.8bs must not define screen`);
  });
}

// ---- the character codes are ASCII everywhere -----------------------------
//
// 'T' is 84 on every machine. The Commodore packages turn that into screen
// code 20 on the way to screen memory and re-select the upper-case
// character set as they do — through the register their index.8bs exports;
// the NES, Atari, and X16 take 84 as it is.

const T_CONSUMER = 'import { text } from "@8bitscript/text";\nexport function main(): void { text.putChar(0, 84); }';

test('the Commodore packages map ASCII to screen codes and select the upper-case set', () => {
  const charsetWrite = {
    vic20: [/#define memoryPointer \(\*\(volatile uint8_t \*\)0x9005\)/, /memoryPointer = 240;/],   // $9005 = $F0
    c64: [/#define memoryPointer \(\*\(volatile uint8_t \*\)0xD018\)/, /memoryPointer = 21;/],      // $D018 = $15
    c128: [/#define memoryPointerShadow \(\*\(volatile uint8_t \*\)0xA2C\)/, /memoryPointerShadow = 20;\n\s+memoryPointer = 20;/], // VM1 then $D018, both $14
    mega65: [/#define memoryPointer \(\*\(volatile uint8_t \*\)0xD018\)/, /memoryPointer = 36;/],   // $D018 = $24 (screen at $0800)
    pet: [/#define viaPeripheralControl \(\*\(volatile uint8_t \*\)0xE84C\)/, /viaPeripheralControl = 12;/], // VIA PCR = $0C, graphics set
  };
  for (const [machine, patterns] of Object.entries(charsetWrite)) {
    const { ir, diagnostics } = link(T_CONSUMER, BORDERS_MAIN, { machine });
    assert.deepEqual(diagnostics, [], machine);
    const c = emitC(ir, { machine });
    assert.match(c, /\(code >= 64\) && \(code < 96\)[\s\S]*return \(code - 64\);/, `${machine}: no ASCII-to-screen-code mapping`);
    for (const pattern of patterns) {
      assert.match(c, pattern, `${machine}: no upper-case character set selection through the package's register`);
    }
    assert.match(c, /text_putChar\(0, 84\);/, `${machine}: 'T' must reach putChar as ASCII 84`);
  }
});

test('the NES text grid is the 28x26 area inside the drawn frame', () => {
  const ir = moduleIr('nes', 'text');
  const text = ir.namespaces.find((n) => n.name === 'text');
  assert.equal(text.consts.get('CellCount'), 728);
  const { ir: linked } = link(T_CONSUMER, BORDERS_MAIN, { machine: 'nes' });
  const c = emitC(linked, { machine: 'nes' });
  // Cell n -> nametable $2042 + (n / 28) * 32 + n % 28: $2042 (8258) is row
  // 2, column 2, the first cell inside the two-tile frame.
  assert.match(c, /setVramAddress\(\(\(8258 \+ \(\(cell \/ 28\) \* 32\)\) \+ \(cell % 28\)\)\);/);
});

// ---- a screen-only or text-only program links on every machine -----------
//
// The two capabilities are separate packages, so a program may import one
// without the other; the NES's text.8bs and screen.8bs share PPU helpers
// through their package's index, not through each other.

test('a program that imports only @8bitscript/screen links for every machine', () => {
  const src = 'import { screen, BorderColor, BackgroundColor } from "@8bitscript/screen";\nexport function main(): void { screen.setColors(BorderColor.Blue, BackgroundColor.Black); }';
  for (const machine of MACHINES) {
    const { ir, diagnostics } = link(src, BORDERS_MAIN, { machine });
    assert.deepEqual(diagnostics, [], machine);
    assert.ok(!ir.functions.some((f) => f.name === 'text_putChar'), `${machine}: text was linked without being imported`);
  }
});

test('a program that imports only @8bitscript/text links for every machine', () => {
  for (const machine of MACHINES) {
    const { ir, diagnostics } = link(T_CONSUMER, BORDERS_MAIN, { machine });
    assert.deepEqual(diagnostics, [], machine);
    assert.ok(!ir.functions.some((f) => f.name === 'screen_setColors'), `${machine}: screen was linked without being imported`);
  }
});
