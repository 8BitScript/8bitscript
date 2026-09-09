// @8bitscript/system: one namespace naming every machine, with the number
// #system() folds to on it. The names must match the CLI's targets, the
// numbers must match the compiler's SYSTEMS table, and on every target a
// comparison against the right name must fold to a match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, link, SYSTEMS, FACTS, PROGRAM_FACTS, factConstName } from '../../compiler/index.mjs';
import { loadCatalog, resolveHardware, stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

// The names `8bs build --target` accepts, in the order the CLI lists them.
const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

const index = readFileSync(join(SRC, 'index.8bs'), 'utf8');
const names = Object.fromEntries(
  [...index.matchAll(/const ([A-Z0-9]+): utinyint = (\d+);/g)].map(([, name, n]) => [name, Number(n)]),
);

test('System names every target once, with the number the compiler folds #system() to', () => {
  assert.deepEqual(Object.keys(names).sort(), TARGETS.map((t) => t.toUpperCase()).sort());
  assert.deepEqual([...SYSTEMS.keys()].sort(), TARGETS.slice().sort(), 'the compiler knows the same targets');
  for (const target of TARGETS) {
    assert.equal(names[target.toUpperCase()], SYSTEMS.get(target), `${target}: System.${target.toUpperCase()} is #system()'s number`);
  }
  assert.equal(new Set(Object.values(names)).size, TARGETS.length, 'the numbers are distinct');
});

test('the package is one file: no per-machine versions are needed any more', () => {
  assert.deepEqual(readdirSync(SRC), ['index.8bs']);
});

// Resolved as if it lived in Studio, the workspace's first consumer of this
// package: Studio's pnpm-linked node_modules is how an installed project
// would find @8bitscript/system too.
const PROBE = join(HERE, '..', '..', 'studio', 'src', 'system-probe.8bs');
const program = (name) => `import { System } from "@8bitscript/system";
let hit: utinyint = 0;
export function main(): void {
    if (#system() == System.${name}) {
        hit = 1;
    }
    while (true) {
        waitFrame();
    }
}
`;

test('on every target, #system() == System.<that target> is a comparison of two equal constants', () => {
  for (const target of TARGETS) {
    // The sheet in the same file reads facts, so a build that names a
    // machine hands them over, as 8bs build does.
    const { ir, diagnostics } = link(program(target.toUpperCase()), PROBE, { machine: target, facts: stockFacts(target) });
    assert.deepEqual(diagnostics, [], target);
    const test = ir.functions.find((f) => f.name === 'main').body.find((s) => s.kind === 'if').test;
    assert.deepEqual(test.left, { kind: 'const', value: SYSTEMS.get(target), type: 'utinyint' }, `${target}: #system()`);
    assert.deepEqual(test.right, { kind: 'const', value: names[target.toUpperCase()], type: 'utinyint' }, `${target}: System.${target.toUpperCase()}`);
  }
});

test('with no machine in hand, the program checks clean', () => {
  assert.deepEqual(analyze(program('C64'), PROBE, { resolveImports: true }), []);
});

// The fact sheet: Video, Audio, Input, Storage, Memory. Each program fact
// key in the compiler's table is one const here, named the way
// factConstName() spells it, and every machine's stock sheet — and every
// non-default hardware value's — folds into it without a range error.

const sheet = [...index.matchAll(/const ([A-Z_]+): ([a-z]+) = #fact\(([a-z.A-Z]+)\);/g)]
  .map(([, name, type, key]) => ({ name, type, key }));
const namespaceOf = (key) => {
  const at = index.indexOf(`#fact(${key})`);
  const before = index.slice(0, at);
  return before.match(/export namespace (\w+) \{(?![\s\S]*export namespace)/)?.[1];
};

test('every program fact is one const on the sheet, in the namespace and with the name the compiler spells', () => {
  assert.deepEqual(sheet.map((c) => c.key), PROGRAM_FACTS, 'the sheet lists the keys in the table\'s order, once each');
  for (const { name, type, key } of sheet) {
    const expected = factConstName(key);
    assert.equal(name, expected.name, key);
    assert.equal(namespaceOf(key), expected.namespace, key);
    assert.equal(type === 'bool', FACTS.get(key).type === 'flag', `${key}: a flag is a bool, a count an integer`);
  }
});

const SHEET_PROBE = `import { Video, Audio, Input, Storage, Memory } from "@8bitscript/system";
let a: usmallint = 0;
let b: bool = false;
export function main(): void {
    a = Video.COLUMNS; a = Video.ROWS; a = Video.PALETTE; a = Video.GLYPHS; a = Video.SPRITES; a = Video.SPRITES_PER_LINE;
    a = Video.SPRITE_WIDTH; a = Video.SPRITE_HEIGHT; a = Video.SPRITE_COLORS; a = Video.LAYERS;
    b = Video.BITMAP; b = Video.SCROLL;
    a = Audio.VOICES; b = Audio.NOISE; b = Audio.ENVELOPE; b = Audio.FILTER; b = Audio.PCM; b = Audio.VOLUME; b = Audio.ENTROPY;
    b = Input.KEYBOARD; a = Input.JOYSTICKS; a = Input.PADS; b = Input.MOUSE; b = Input.PADDLES;
    b = Storage.SAVE;
    a = Memory.RAM; b = Memory.BANKED; a = Memory.BANKED_KIB;
    while (true) {
        waitFrame();
    }
}
`;

test('every machine\'s stock sheet, and every hardware value\'s, fits the sheet\'s types', () => {
  for (const target of TARGETS) {
    const catalog = loadCatalog(target);
    const choices = [{}];
    for (const [id, option] of Object.entries(catalog.options)) {
      for (const value of Object.keys(option.values)) if (value !== option.default) choices.push({ [id]: value });
    }
    for (const overrides of choices) {
      const { hardware } = resolveHardware(catalog, { overrides });
      const { diagnostics } = link(SHEET_PROBE, PROBE, { machine: target, tags: hardware.tags, facts: hardware.facts });
      assert.deepEqual(diagnostics, [], `${target} ${hardware.label}`);
    }
  }
});

// The sheet against the code: the grid the fact sheet states is the grid
// the machine's text package draws on, on the stock machine and on the
// 80-column PET — the case that proves a hardware value's facts and its
// file twin arrive together.
const GRID_PROBE = `import { text } from "@8bitscript/text";
import { Video } from "@8bitscript/system";
export function main(): void {
    let textColumns: utinyint = text.COLUMNS;
    let factColumns: utinyint = Video.COLUMNS;
    let textCells: usmallint = text.CELL_COUNT;
    let factRows: utinyint = Video.ROWS;
    while (true) {
        waitFrame();
    }
}
`;

test('Video.COLUMNS and ROWS are text.COLUMNS and CELL_COUNT on every machine, and on the 8032 PET', () => {
  const builds = TARGETS.map((target) => [target, resolveHardware(loadCatalog(target), {}).hardware]);
  builds.push(['pet', resolveHardware(loadCatalog('pet'), { profile: '8032' }).hardware]);
  for (const [target, hardware] of builds) {
    const { ir, diagnostics } = link(GRID_PROBE, PROBE, { machine: target, tags: hardware.tags, facts: hardware.facts });
    assert.deepEqual(diagnostics, [], `${target} ${hardware.label}`);
    const locals = Object.fromEntries(ir.functions.find((f) => f.name === 'main').body
      .filter((s) => s.kind === 'local').map((s) => [s.name, s.init.value]));
    assert.equal(locals.factColumns, locals.textColumns, `${target} ${hardware.label}: columns`);
    assert.equal(locals.factColumns * locals.factRows, locals.textCells, `${target} ${hardware.label}: rows`);
  }
  assert.equal(resolveHardware(loadCatalog('pet'), { profile: '8032' }).hardware.facts['video.columns'], 80);
  assert.equal(stockFacts('pet')['video.columns'], 40);
});
