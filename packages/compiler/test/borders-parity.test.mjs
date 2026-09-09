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

const HERE = dirname(fileURLToPath(import.meta.url));
const BORDERS_MAIN = join(HERE, '..', '..', '..', 'examples', 'borders', 'src', 'main.8bs');
const PACKAGES = join(HERE, '..', '..');

const SHARED_COLORS = ['BLACK', 'WHITE', 'RED', 'CYAN', 'PURPLE', 'GREEN', 'BLUE', 'YELLOW'];

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

  test(`@8bitscript/${machine}/screen exports blank, setBackground, setBorder, setColors, and the eight shared colour names`, () => {
    const ir = moduleIr(machine, 'screen');
    const screen = ir.namespaces.find((n) => n.name === 'screen');
    assert.ok(screen && screen.exported, `${machine} has no exported screen namespace`);
    assert.deepEqual([...screen.functions.keys()].sort(), ['blank', 'setBackground', 'setBorder', 'setColors'], `${machine}'s screen surface drifted`);
    assert.equal(screen.consts.size, 0);
    for (const name of ['BorderColor', 'BackgroundColor']) {
      const ns = ir.namespaces.find((n) => n.name === name);
      assert.ok(ns, `${machine} has no ${name} namespace`);
      assert.ok(ns.exported, `${machine}'s ${name} is not exported`);
      for (const colour of SHARED_COLORS) {
        assert.ok(ns.consts.has(colour), `${machine}'s ${name} has no ${colour}`);
      }
      assert.equal(ns.consts.get('KEEP'), 255, `${machine}'s ${name}.KEEP is not the value blank() tests for`);
    }
  });

  test(`@8bitscript/${machine}/text exports exactly the portable text surface`, () => {
    const ir = moduleIr(machine, 'text');
    const text = ir.namespaces.find((n) => n.name === 'text');
    assert.ok(text && text.exported, `${machine} has no exported text namespace`);
    assert.deepEqual([...text.functions.keys()].sort(), ['print', 'printNumber', 'putChar', 'putColor', 'setColor', 'setReverse'], `${machine}'s text surface drifted`);
    assert.deepEqual([...text.consts.keys()], ['CELL_COUNT', 'COLUMNS'], `${machine}'s text consts drifted`);
    const colors = ir.namespaces.find((n) => n.name === 'TextColor');
    assert.ok(colors && colors.exported, `${machine} has no exported TextColor namespace`);
    assert.deepEqual([...colors.consts.keys()], ['BLACK', 'WHITE', 'RED', 'CYAN', 'PURPLE', 'GREEN', 'BLUE', 'YELLOW'], `${machine}'s TextColor drifted`);
    // The helpers (ASCII mapping and the like) are module-private, not
    // members: `text.` is the same set of names on every machine.
    assert.ok(!ir.namespaces.some((n) => n.name === 'screen'), `${machine}'s text.8bs must not define screen`);
  });
}

for (const machine of MACHINES) {
  test(`${machine}: text.CELL_COUNT is a whole number of text.COLUMNS rows`, () => {
    // Through the linker, not lowering alone: a package may take its
    // geometry from another file (the PET's text.CELL_COUNT is
    // `Video.CELL_COUNT`, pending until linked), so the values are read
    // the way a program reads them — inlined into a use.
    const src = 'import { text } from "@8bitscript/text";\n'
      + 'export function main(): void { memory.write(0, text.CELL_COUNT); memory.write(1, text.COLUMNS); }\n';
    const { ir, diagnostics } = link(src, join(dirname(BORDERS_MAIN), 'parity.8bs'), { machine });
    assert.deepEqual(diagnostics, []);
    const main = ir.functions.find((f) => f.name === 'main');
    const [cells, columns] = main.body.map((s) => s.value.value);
    assert.ok(columns > 0, `${machine}'s text.COLUMNS is ${columns}`);
    assert.equal(cells % columns, 0, `${machine}: ${cells} cells is not a whole number of ${columns}-cell rows`);
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
  const charset = {
    vic20: { global: 'memoryPointer', address: 0x9005, value: 240 },
    c64: { global: 'memoryPointer', address: 0xD018, value: 132 },
    c128: { global: 'memoryPointerShadow', address: 0xA2C, value: 20, also: { global: 'memoryPointer', value: 20 } },
    mega65: { global: 'memoryPointer', address: 0xD018, value: 36 },
    pet: { global: 'viaPeripheralControl', address: 0xE84C, value: 12 },
  };
  for (const [machine, expect] of Object.entries(charset)) {
    const { ir, diagnostics } = link(T_CONSUMER, BORDERS_MAIN, { machine });
    assert.deepEqual(diagnostics, [], machine);
    const ascii = ir.functions.find((f) => f.name === 'asciiToScreenCode');
    assert.ok(ascii, `${machine}: no ASCII-to-screen-code mapping`);
    assert.equal(ascii.body[0].kind, 'if');
    assert.equal(ascii.body[0].test.operator, '&&');
    assert.deepEqual(ascii.body[0].then[0].value.right, { kind: 'const', value: 64 });
    const g = ir.globals.find((x) => x.name === expect.global);
    assert.equal(g.address, expect.address, `${machine}: ${expect.global} address`);
    const prepare = ir.functions.find((f) => f.name === 'prepare');
    const assign = prepare.body.find((s) => s.kind === 'assign' && s.target === expect.global)
      ?? prepare.body.find((s) => s.kind === 'if')?.then.find((s) => s.kind === 'assign' && s.target === expect.global);
    assert.equal(assign.value.value, expect.value, `${machine}: no upper-case character set selection`);
    if (expect.also) {
      const other = prepare.body.find((s) => s.kind === 'assign' && s.target === expect.also.global);
      assert.equal(other.value.value, expect.also.value, `${machine}: memoryPointer follows the shadow`);
    }
    const main = ir.functions.find((f) => f.name === 'main');
    assert.equal(main.body[0].name, 'text_putChar');
    assert.deepEqual(main.body[0].args.map((a) => a.value), [0, 84]);
  }
});

test('the NES text grid is the 28x26 area inside the drawn frame', () => {
  const ir = moduleIr('nes', 'text');
  const text = ir.namespaces.find((n) => n.name === 'text');
  assert.equal(text.consts.get('CELL_COUNT'), 728);
  assert.equal(text.consts.get('COLUMNS'), 28);
  const { ir: linked } = link(T_CONSUMER, BORDERS_MAIN, { machine: 'nes' });
  const locate = linked.functions.find((f) => f.name === 'locate');
  assert.deepEqual(locate.body[0].init.right, { kind: 'const', value: 4 });
  assert.equal(locate.body[1].init.operator, '+');
  assert.deepEqual(locate.body[1].init.left.right, { kind: 'const', value: 8 });
  assert.deepEqual(locate.body[1].init.right.right, { kind: 'const', value: 64 });
  const col = locate.body.find((s) => s.kind === 'local' && s.name === 'col');
  assert.deepEqual(col.init.left.right, { kind: 'const', value: 4 });
  const run = locate.body.find((s) => s.kind === 'call' && s.name === 'queueRun');
  assert.deepEqual(run.args[0].left.left, { kind: 'const', value: 8258 });
  assert.deepEqual(run.args[0].left.right.right, { kind: 'const', value: 32 });
});

// ---- a screen-only or text-only program links on every machine -----------
//
// The two capabilities are separate packages, so a program may import one
// without the other; the NES's text.8bs and screen.8bs share PPU helpers
// through their package's index, not through each other.

test('a program that imports only @8bitscript/screen links for every machine', () => {
  const src = 'import { screen, BorderColor, BackgroundColor } from "@8bitscript/screen";\nexport function main(): void { screen.setColors(BorderColor.BLUE, BackgroundColor.BLACK); }';
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
