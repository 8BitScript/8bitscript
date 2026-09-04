// examples/borders is one file for nine machines, and this is what holds
// that: every machine package exports the same surface — `border`,
// `background`, `applyColors()`, the eight shared colour names in
// `BorderColor` and `BackgroundColor`, and `screen` with ASCII character
// codes and a cell 0 at the top-left inside the border. A package that
// drops any of it breaks the example for that machine only, which is the
// kind of thing that goes unnoticed until someone builds for it — so the
// example is linked here for every machine, against the real pnpm-linked
// packages, and each package's namespaces are checked by name.
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

const packageIr = (machine) => {
  const file = join(PACKAGES, machine, 'src', 'index.8bs');
  const src = readFileSync(file, 'utf8');
  const { tokens } = tokenize(src, file);
  const { ast } = parse(tokens, src, file);
  return lower(ast, file).ir;
};

for (const machine of MACHINES) {
  test(`examples/borders main.8bs links clean for ${machine}`, () => {
    const { ir, diagnostics } = link(readFileSync(BORDERS_MAIN, 'utf8'), BORDERS_MAIN, { machine });
    assert.deepEqual(diagnostics, []);
    assert.ok(ir.functions.some((fn) => fn.name === 'main'));
    assert.ok(ir.functions.some((fn) => fn.name === 'frame'));
  });

  test(`@8bitscript/${machine} exports the eight shared colour names in both namespaces`, () => {
    const ir = packageIr(machine);
    for (const name of ['BorderColor', 'BackgroundColor']) {
      const ns = ir.namespaces.find((n) => n.name === name);
      assert.ok(ns, `${machine} has no ${name} namespace`);
      assert.ok(ns.exported, `${machine}'s ${name} is not exported`);
      for (const colour of SHARED_COLORS) {
        assert.ok(ns.consts.has(colour), `${machine}'s ${name} has no ${colour}`);
      }
    }
    const screen = ir.namespaces.find((n) => n.name === 'screen');
    assert.ok(screen && screen.exported, `${machine} has no exported screen namespace`);
    for (const fn of ['putChar', 'putColor', 'showDigit']) {
      assert.ok(screen.functions.has(fn), `${machine}'s screen has no ${fn}`);
    }
    assert.ok(screen.consts.has('CellCount'), `${machine}'s screen has no CellCount`);
  });
}

// ---- the character codes are ASCII everywhere -----------------------------
//
// 'T' is 84 on every machine. The Commodore packages turn that into screen
// code 20 on the way to screen memory and re-select the upper-case
// character set as they do; the NES, Atari, and X16 take 84 as it is.

const T_CONSUMER = 'import { screen } from "@8bitscript/machine";\nexport function main(): void { screen.putChar(0, 84); }';

test('the Commodore packages map ASCII to screen codes and select the upper-case set', () => {
  const charsetWrite = {
    vic20: /36869 = 240;/,   // $9005 = $F0
    c64: /53272 = 21;/,      // $D018 = $15
    c128: /2604 = 20;[\s\S]*53272 = 20;/, // VM1 $0A2C then $D018, both $14
    mega65: /53272 = 36;/,   // $D018 = $24 (screen at $0800)
    pet: /59468 = 12;/,      // VIA PCR $E84C = $0C, graphics set
  };
  for (const [machine, pattern] of Object.entries(charsetWrite)) {
    const { ir, diagnostics } = link(T_CONSUMER, BORDERS_MAIN, { machine });
    assert.deepEqual(diagnostics, [], machine);
    const c = emitC(ir, { machine });
    assert.match(c, /\(code >= 64\) && \(code < 96\)[\s\S]*return \(code - 64\);/, `${machine}: no ASCII-to-screen-code mapping`);
    assert.match(c, pattern, `${machine}: no upper-case character set selection`);
  }
});

test('the NES screen is the 28x26 area inside the drawn frame', () => {
  const ir = packageIr('nes');
  const screen = ir.namespaces.find((n) => n.name === 'screen');
  assert.equal(screen.consts.get('CellCount'), 728);
  const { ir: linked } = link(T_CONSUMER, BORDERS_MAIN, { machine: 'nes' });
  const c = emitC(linked, { machine: 'nes' });
  // Cell n -> nametable $2042 + (n / 28) * 32 + n % 28: $2042 (8258) is row
  // 2, column 2, the first cell inside the two-tile frame.
  assert.match(c, /setVramAddress\(\(\(8258 \+ \(\(cell \/ 28\) \* 32\)\) \+ \(cell % 28\)\)\);/);
});
