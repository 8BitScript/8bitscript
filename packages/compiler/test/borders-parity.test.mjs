// Every machine package implements the same two portable surfaces —
// `./screen` (a `screen` namespace with setColors(border, background) and
// the eight shared color names in `BorderColor` and `BackgroundColor`) and
// `./text` (a `text` namespace with ASCII character codes and a cell 0 at
// the top-left inside the border) — which @8bitscript/screen and
// @8bitscript/text delegate to per machine. A package that drops any of it
// breaks that machine only, which is the kind of thing that goes unnoticed
// until someone builds for it — so each package's namespaces are checked
// here by name, against the real pnpm-linked packages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MACHINES, link, tokenize, parse, lower } from '../index.mjs';
import { loadCatalog, resolveHardware, stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSUMER = join(HERE, '..', '..', 'studio', 'src', 'main.8bs');
const PACKAGES = join(HERE, '..', '..');
const NATIVE_BACKEND_PENDING = 'Bare Metal: waiting on the native backend';

const SHARED_COLORS = ['BLACK', 'WHITE', 'RED', 'CYAN', 'PURPLE', 'GREEN', 'BLUE', 'YELLOW'];

const moduleIr = (machine, name) => {
  const file = join(PACKAGES, machine, 'src', `${name}.8bs`);
  const src = readFileSync(file, 'utf8');
  const { tokens } = tokenize(src, file);
  const { ast } = parse(tokens, src, file);
  return lower(ast, file).ir;
};

for (const machine of MACHINES) {
  // TODO: restore once a multi-target screen-and-text probe exists.
  test(`a shared screen-and-text program links clean for ${machine}`, { skip: NATIVE_BACKEND_PENDING }, () => {});

  test(`@8bitscript/${machine}/screen exports blank, setBackground, setBorder, setColors, and the eight shared color names`, () => {
    const ir = moduleIr(machine, 'screen');
    const screen = ir.namespaces.find((n) => n.name === 'screen');
    assert.ok(screen && screen.exported, `${machine} has no exported screen namespace`);
    assert.deepEqual([...screen.functions.keys()].sort(), ['blank', 'setBackground', 'setBorder', 'setColors'], `${machine}'s screen surface drifted`);
    assert.equal(screen.consts.size, 0);
    for (const name of ['BorderColor', 'BackgroundColor']) {
      const ns = ir.namespaces.find((n) => n.name === name);
      assert.ok(ns, `${machine} has no ${name} namespace`);
      assert.ok(ns.exported, `${machine}'s ${name} is not exported`);
      for (const color of SHARED_COLORS) {
        assert.ok(ns.consts.has(color), `${machine}'s ${name} has no ${color}`);
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
    const { ir, diagnostics } = link(src, CONSUMER, { machine, facts: stockFacts(machine) });
    assert.deepEqual(diagnostics, []);
    const main = ir.functions.find((f) => f.name === 'main');
    const [cells, columns] = main.body.map((s) => s.value.value);
    assert.ok(columns > 0, `${machine}'s text.COLUMNS is ${columns}`);
    assert.equal(cells % columns, 0, `${machine}: ${cells} cells is not a whole number of ${columns}-cell rows`);
  });
}

// ---- the character codes are ASCII everywhere -----------------------------
//
// 'T' is 84 on every machine. vic20/c64/c128/mega65 turn that into screen
// code 20 on the way to screen memory and re-select the upper-case-only
// character set as they do — through the register their index.8bs exports;
// the NES, Atari, and X16 take 84 as it is. The PET is different since its
// own milestone-10-era mixed-case rework (below): its own text character
// set holds both cases at once, so 'T' (already inside its own upper-case
// range there) needs no offset at all — see the dedicated PET test below.

const T_CONSUMER = 'import { text } from "@8bitscript/text";\nexport function main(): void { text.putChar(0, 84); }';

test('vic20/c64/c128/mega65 map ASCII to screen codes and select the upper-case-only set', () => {
  const charset = {
    vic20: { global: 'memoryPointer', address: 0x9005, value: 240 },
    c64: { global: 'memoryPointer', address: 0xD018, value: 132 },
    c128: { global: 'memoryPointerShadow', address: 0xA2C, value: 20, also: { global: 'memoryPointer', value: 20 } },
    mega65: { global: 'memoryPointer', address: 0xD018, value: 36 },
  };
  for (const [machine, expect] of Object.entries(charset)) {
    const { ir, diagnostics } = link(T_CONSUMER, CONSUMER, { machine, facts: stockFacts(machine) });
    assert.deepEqual(diagnostics, [], machine);
    const ascii = ir.functions.find((f) => f.name === 'asciiToScreenCode');
    assert.ok(ascii, `${machine}: no ASCII-to-screen-code mapping`);
    assert.equal(ascii.body[0].kind, 'if');
    assert.equal(ascii.body[0].test.operator, '&&');
    assert.deepEqual(ascii.body[0].then[0].value.right, { kind: 'const', value: 64, type: 'utinyint' });
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

// The PET draws for the character set the machine is already in and never
// selects one — a real design divergence from the other four Commodore
// packages above, not a bug. The charset bit is one register for the whole
// screen and it is retroactive (it picks the ROM the video hardware reads
// *now*, for cells already drawn), so a package that switched it could not
// put it back without re-rendering the text it had just written. Which set
// the ROM booted into is a per-model constant instead —
// #fact(video.bootsInTextMode), true only for the business-keyboard editor
// ROMs — so asciiToScreenCode() addresses whichever set is already live.
// The fold pass folds the fact to a literal but does not eliminate the
// untaken branch's statements from the IR, so the body is one outer `if`
// wrapping both shapes on every profile.
//
// Graphics set (every model here but the 8032): one case of the alphabet,
// at 1-26, so 'A'-'Z' drop by 64 and 'a'-'z' by 96 onto the same glyphs.
// Text set (the 8032): 'a'-'z' at 1-26, 'A'-'Z' already at 65-90.
test('the PET draws for the set the machine booted into, and selects none — graphics on a 3032', () => {
  const graphicsBoot = resolveHardware(loadCatalog('pet'), { profile: '3032' }).hardware.facts;
  const { ir, diagnostics } = link(T_CONSUMER, CONSUMER, { machine: 'pet', facts: graphicsBoot });
  assert.deepEqual(diagnostics, []);
  const ascii = ir.functions.find((f) => f.name === 'asciiToScreenCode');
  assert.ok(ascii, 'pet: no ASCII-to-screen-code mapping');
  assert.equal(ascii.body[0].kind, 'if');
  assert.deepEqual(ascii.body[0].test, { kind: 'const', value: 0, type: 'bool' }, 'video.bootsInTextMode folds to false on a 3032');
  assert.equal(ascii.body[0].else, null, 'the text-set branch always returns — the graphics mapping follows in source order, not in an else');
  const graphics = ascii.body.slice(1);
  assert.equal(graphics[0].kind, 'if');
  assert.equal(graphics[0].test.operator, '&&');
  assert.deepEqual(graphics[0].test.left.right, { kind: 'const', value: 65, type: 'utinyint' });
  assert.deepEqual(graphics[0].test.right.right, { kind: 'const', value: 91, type: 'utinyint' });
  assert.equal(graphics[0].then[0].value.operator, '-');
  assert.deepEqual(graphics[0].then[0].value.right, { kind: 'const', value: 64, type: 'utinyint' }, 'A-Z drops by 64 to reach the graphics set\'s 1-26');
  assert.equal(graphics[1].kind, 'if');
  assert.deepEqual(graphics[1].test.left.right, { kind: 'const', value: 97, type: 'utinyint' });
  assert.deepEqual(graphics[1].test.right.right, { kind: 'const', value: 123, type: 'utinyint' });
  assert.equal(graphics[1].then[0].value.operator, '-');
  assert.deepEqual(graphics[1].then[0].value.right, { kind: 'const', value: 96, type: 'utinyint' }, 'a-z lands on the same glyphs — the graphics set has one case');

  const main = ir.functions.find((f) => f.name === 'main');
  assert.equal(main.body[0].name, 'text_putChar');
  assert.deepEqual(main.body[0].args.map((a) => a.value), [0, 84]);
});

// The point of the rework, and the thing that keeps a program from
// re-rendering BASIC's own screen out from under it: no route through this
// package writes $E84C at all any more. Asserted over every function in
// the linked program rather than over the one that used to do it, so
// putting the write back anywhere fails here.
test('nothing in a linked PET program writes the character-set register, on any model', () => {
  for (const profile of ['2001', '3032', '8032']) {
    const facts = resolveHardware(loadCatalog('pet'), { profile }).hardware.facts;
    const { ir, diagnostics } = link(T_CONSUMER, CONSUMER, { machine: 'pet', facts });
    assert.deepEqual(diagnostics, []);
    assert.equal(ir.functions.find((f) => f.name === 'prepare'), undefined, `${profile}: prepare() is gone, not merely empty`);
    const writesPcr = (node) => {
      if (Array.isArray(node)) return node.some(writesPcr);
      if (node && typeof node === 'object') {
        if (node.kind === 'assign' && node.target === 'viaPeripheralControl') return true;
        if (node.kind === 'memoryWrite' && node.address?.value === 0xe84c) return true;
        return Object.values(node).some(writesPcr);
      }
      return false;
    };
    assert.equal(writesPcr(ir.functions), false, `${profile}: something still selects a character set`);
  }
});

test('the 8032 boots into the text set, so its own mapping is the one that folds in', () => {
  const textBoot = resolveHardware(loadCatalog('pet'), { profile: '8032' }).hardware.facts;
  const { ir, diagnostics } = link(T_CONSUMER, CONSUMER, { machine: 'pet', facts: textBoot });
  assert.deepEqual(diagnostics, []);
  const ascii = ir.functions.find((f) => f.name === 'asciiToScreenCode');
  assert.deepEqual(ascii.body[0].test, { kind: 'const', value: 1, type: 'bool' }, 'video.bootsInTextMode folds to true on the 8032');
  const textSet = ascii.body[0].then;
  assert.equal(textSet[0].kind, 'if');
  assert.deepEqual(textSet[0].test.left.right, { kind: 'const', value: 97, type: 'utinyint' });
  assert.equal(textSet[0].then[0].value.operator, '-');
  assert.deepEqual(textSet[0].then[0].value.right, { kind: 'const', value: 96, type: 'utinyint' }, 'a-z drops by 96 — the text set keeps lower case at 1-26');
  assert.equal(textSet[1].value.kind, 'ref', 'A-Z passes through: the text set already holds it at 65-90');
});

// The 2001's 901447-08 ROM swaps the *text* set's two cases relative to
// every later model's -10 (packages/pet/src/text.8bs's header). It boots
// into graphics, though, so this package never addresses its text set and
// the swap cannot reach the mapping — the 2001 and the 3032 produce the
// same offsets. video.characterSetSwapped stays on the sheet because it is
// true of the hardware; it is simply not what decides this.
test('the 2001 maps exactly as a 3032 does: it boots into graphics, where its ROM does not differ', () => {
  const offsetsFor = (profile) => {
    const facts = resolveHardware(loadCatalog('pet'), { profile }).hardware.facts;
    const { ir } = link(T_CONSUMER, CONSUMER, { machine: 'pet', facts });
    const ascii = ir.functions.find((f) => f.name === 'asciiToScreenCode');
    return ascii.body.slice(1).filter((s) => s.kind === 'if').map((s) => s.then[0].value.right?.value);
  };
  assert.equal(resolveHardware(loadCatalog('pet'), { profile: '2001' }).hardware.facts['video.characterSetSwapped'], true, 'the 2001 really is the swapped ROM');
  assert.deepEqual(offsetsFor('2001'), [64, 96]);
  assert.deepEqual(offsetsFor('2001'), offsetsFor('3032'), 'the swap is in the text set, which a graphics-booting model never reaches');
});

test('the NES text grid is the 28x26 area inside the drawn frame', () => {
  const ir = moduleIr('nes', 'text');
  const text = ir.namespaces.find((n) => n.name === 'text');
  assert.equal(text.consts.get('CELL_COUNT'), 728);
  assert.equal(text.consts.get('COLUMNS'), 28);
  const { ir: linked } = link(T_CONSUMER, CONSUMER, { machine: 'nes' });
  const locate = linked.functions.find((f) => f.name === 'locate');
  assert.deepEqual(locate.body[0].init.right, { kind: 'const', value: 4, type: 'utinyint' });
  assert.equal(locate.body[1].init.operator, '+');
  assert.deepEqual(locate.body[1].init.left.right, { kind: 'const', value: 8, type: 'utinyint' });
  assert.deepEqual(locate.body[1].init.right.right, { kind: 'const', value: 64, type: 'utinyint' });
  const col = locate.body.find((s) => s.kind === 'local' && s.name === 'col');
  assert.deepEqual(col.init.left.right, { kind: 'const', value: 4, type: 'utinyint' });
  const run = locate.body.find((s) => s.kind === 'call' && s.name === 'queueRun');
  assert.deepEqual(run.args[0].left.left, { kind: 'const', value: 8258, type: 'usmallint' });
  assert.deepEqual(run.args[0].left.right.right, { kind: 'const', value: 32, type: 'utinyint' });
});

// ---- a screen-only or text-only program links on every machine -----------
//
// The two capabilities are separate packages, so a program may import one
// without the other; the NES's text.8bs and screen.8bs share PPU helpers
// through their package's index, not through each other.

test('a program that imports only @8bitscript/screen links for every machine', () => {
  const src = 'import { screen, BorderColor, BackgroundColor } from "@8bitscript/screen";\nexport function main(): void { screen.setColors(BorderColor.BLUE, BackgroundColor.BLACK); }';
  for (const machine of MACHINES) {
    const { ir, diagnostics } = link(src, CONSUMER, { machine, facts: stockFacts(machine) });
    assert.deepEqual(diagnostics, [], machine);
    assert.ok(!ir.functions.some((f) => f.name === 'text_putChar'), `${machine}: text was linked without being imported`);
  }
});

test('a program that imports only @8bitscript/text links for every machine', () => {
  for (const machine of MACHINES) {
    const { ir, diagnostics } = link(T_CONSUMER, CONSUMER, { machine, facts: stockFacts(machine) });
    assert.deepEqual(diagnostics, [], machine);
    assert.ok(!ir.functions.some((f) => f.name === 'screen_setColors'), `${machine}: screen was linked without being imported`);
  }
});
