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

test('every Commodore selects a character set rather than inheriting one, and the three that ship draw in the mixed-case one', () => {
  // Selecting is the shared decision: the ROM's boot state, whatever ran
  // before, and a user's SHIFT+C= would each give a different answer, so a
  // text package picks. WHICH set differs, and deliberately. The machines
  // that actually build draw in the mixed-case set, because it is the only
  // one holding both cases of the alphabet and so the only one that can
  // draw a string as it was written (packages/pet/src/text.8bs argues it at
  // length). The mega65 is still parked and still selects the upper-case
  // set; it changes when its own backend lands and a screenshot can prove
  // it.
  const charset = {
    vic20: { global: 'memoryPointer', address: 0x9005, value: 0xF2, lowerCaseAt: 96 },
    c64: { global: 'memoryPointer', address: 0xD018, value: 0x86, lowerCaseAt: 96 },
    c128: { global: 'memoryPointerShadow', address: 0xA2C, value: 0x16, also: { global: 'memoryPointer', value: 0x16 }, lowerCaseAt: 96 },
    mega65: { global: 'memoryPointer', address: 0xD018, value: 36, lowerCaseAt: null },
  };
  for (const [machine, expect] of Object.entries(charset)) {
    const { ir, diagnostics } = link(T_CONSUMER, CONSUMER, { machine, facts: stockFacts(machine) });
    assert.deepEqual(diagnostics, [], machine);
    const ascii = ir.functions.find((f) => f.name === 'asciiToScreenCode');
    assert.ok(ascii, `${machine}: no ASCII-to-screen-code mapping`);
    assert.equal(ascii.body[0].kind, 'if');
    assert.equal(ascii.body[0].test.operator, '&&');
    if (expect.lowerCaseAt === null) {
      // Upper-case set: 'A'-'Z' drop by 64 onto 1-26.
      assert.deepEqual(ascii.body[0].then[0].value.right, { kind: 'const', value: 64, type: 'utinyint' }, machine);
    } else {
      // Mixed-case set: 'a'-'z' drop by 96 onto 1-26, and 'A'-'Z' pass
      // through at their own 65-90.
      assert.deepEqual(ascii.body[0].test.left.right, { kind: 'const', value: 97, type: 'utinyint' }, machine);
      assert.deepEqual(ascii.body[0].then[0].value.right, { kind: 'const', value: expect.lowerCaseAt, type: 'utinyint' }, machine);
      assert.equal(ascii.body[1].kind, 'return', `${machine}: everything else passes through`);
      assert.equal(ascii.body[1].value.kind, 'ref', machine);
    }
    const g = ir.globals.find((x) => x.name === expect.global);
    assert.equal(g.address, expect.address, `${machine}: ${expect.global} address`);
    const prepare = ir.functions.find((f) => f.name === 'prepare');
    const assign = prepare.body.find((s) => s.kind === 'assign' && s.target === expect.global)
      ?? prepare.body.find((s) => s.kind === 'if')?.then.find((s) => s.kind === 'assign' && s.target === expect.global);
    assert.equal(assign.value.value, expect.value, `${machine}: no character set selection`);
    if (expect.also) {
      const other = prepare.body.find((s) => s.kind === 'assign' && s.target === expect.also.global);
      assert.equal(other.value.value, expect.also.value, `${machine}: memoryPointer follows the shadow`);
    }
    const main = ir.functions.find((f) => f.name === 'main');
    assert.equal(main.body[0].name, 'text_putChar');
    assert.deepEqual(main.body[0].args.map((a) => a.value), [0, 84]);
  }
});

// The PET draws in its *text* character set and selects it when the
// machine is not already there — the one set on this machine that holds
// both cases of the alphabet, and so the only one that can draw a string
// as it was written rather than flattened to capitals. Which set the model
// boots into is still a per-model constant (#fact(video.bootsInTextMode),
// true only for the business-keyboard editor ROMs), but it now decides
// only whether the selecting write is needed at all, not how a character
// is encoded. Nothing puts the old set back: the bit is retroactive, so
// restoring it re-rendered the text the program had just drawn — see
// packages/pet/AGENTS.md and mos/startup/commodore.ts.
//
// The fold pass folds a fact to a literal but does not eliminate the
// untaken branch's statements from the IR, so the body is one outer `if`
// wrapping both mappings on every profile.
//
// Text set, every ROM but the 2001's: 'a'-'z' at 1-26, 'A'-'Z' already at
// 65-90. The 2001's own 901447-08 swaps those halves (below).
test('the PET encodes for the text set — a 3032 uses the later ROM\'s mapping', () => {
  const graphicsBoot = resolveHardware(loadCatalog('pet'), { profile: '3032' }).hardware.facts;
  const { ir, diagnostics } = link(T_CONSUMER, CONSUMER, { machine: 'pet', facts: graphicsBoot });
  assert.deepEqual(diagnostics, []);
  const ascii = ir.functions.find((f) => f.name === 'asciiToScreenCode');
  assert.ok(ascii, 'pet: no ASCII-to-screen-code mapping');
  assert.equal(ascii.body[0].kind, 'if');
  assert.deepEqual(ascii.body[0].test, { kind: 'const', value: 0, type: 'bool' }, 'video.characterSetSwapped folds to false on a 3032');
  assert.equal(ascii.body[0].else, null, 'the swapped branch always returns — the later ROM\'s mapping follows in source order, not in an else');
  const later = ascii.body.slice(1);
  assert.equal(later[0].kind, 'if');
  assert.equal(later[0].test.operator, '&&');
  assert.deepEqual(later[0].test.left.right, { kind: 'const', value: 97, type: 'utinyint' });
  assert.deepEqual(later[0].test.right.right, { kind: 'const', value: 123, type: 'utinyint' });
  assert.equal(later[0].then[0].value.operator, '-');
  assert.deepEqual(later[0].then[0].value.right, { kind: 'const', value: 96, type: 'utinyint' }, 'a-z drops by 96 — the text set keeps lower case at 1-26');
  assert.equal(later[1].kind, 'return');
  assert.equal(later[1].value.kind, 'ref', 'A-Z passes through: the text set already holds it at 65-90');

  const main = ir.functions.find((f) => f.name === 'main');
  assert.equal(main.body[0].name, 'text_putChar');
  assert.deepEqual(main.body[0].args.map((a) => a.value), [0, 84]);
});

// The selecting write, and the one model that does not need it. A program
// that prints on a 2001 or a 3032 has to move the machine to the text set
// first; the 8032 powers on in it, so its guard folds to an early return
// and the store is dead before the backend ever sees it. Asserted on the
// fold rather than the emitted bytes, which packages/pet/test covers.
test('a PET program selects the text set, except on the model that boots in it', () => {
  for (const profile of ['2001', '3032', '8032']) {
    const facts = resolveHardware(loadCatalog('pet'), { profile }).hardware.facts;
    const { ir, diagnostics } = link(T_CONSUMER, CONSUMER, { machine: 'pet', facts });
    assert.deepEqual(diagnostics, []);
    const prepare = ir.functions.find((f) => f.name === 'prepare');
    assert.ok(prepare, `${profile}: prepare() is gone`);
    const [guard, select] = prepare.body;
    assert.equal(guard.kind, 'if');
    assert.equal(select.kind, 'assign');
    assert.equal(select.target, 'viaPeripheralControl');
    assert.deepEqual(select.value, { kind: 'const', type: 'utinyint', value: 0x0e }, `${profile}: selects the text set, $0E`);
    const bootsInTextSet = facts['video.bootsInTextMode'];
    assert.equal(guard.test.value, bootsInTextSet ? 1 : 0, `${profile}: the guard folds to video.bootsInTextMode`);
    assert.equal(guard.then[0].kind, 'return', `${profile}: and a machine already in the text set returns before the store`);
  }
});

// The 2001's 901447-08 ROM swaps the *text* set's two cases relative to
// every later model's -10: upper case stays at 1-26 and lower case moves
// to 65-90 (verified glyph by glyph against the ROM — code 8 is 'H' there
// and 'h' everywhere else). Now that this package addresses the text set
// on every model, that fact reaches the mapping, where it used not to.
test('the 2001\'s swapped ROM gets its own mapping, and the 3032 does not', () => {
  const linkFor = (profile) => {
    const facts = resolveHardware(loadCatalog('pet'), { profile }).hardware.facts;
    const { ir } = link(T_CONSUMER, CONSUMER, { machine: 'pet', facts });
    return ir.functions.find((f) => f.name === 'asciiToScreenCode');
  };
  assert.equal(resolveHardware(loadCatalog('pet'), { profile: '2001' }).hardware.facts['video.characterSetSwapped'], true, 'the 2001 really is the swapped ROM');

  const swapped = linkFor('2001');
  assert.deepEqual(swapped.body[0].test, { kind: 'const', value: 1, type: 'bool' }, 'video.characterSetSwapped folds to true on the 2001');
  const offsets = (statements) => statements.filter((s) => s.kind === 'if').map((s) => s.then[0].value.right?.value);
  assert.deepEqual(offsets(swapped.body[0].then), [64, 32], 'A-Z drops by 64 to 1-26; a-z drops by 32 to 65-90');

  const later = linkFor('3032');
  assert.deepEqual(offsets(later.body.slice(1)), [96], 'the later ROM moves lower case instead, and leaves upper case alone');
  assert.notDeepEqual(offsets(swapped.body[0].then), offsets(later.body.slice(1)), 'the swap has to reach the mapping — the text set is what it swaps');
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
