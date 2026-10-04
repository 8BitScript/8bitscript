// The @8bitscript/graphics contract (packages/graphics/src/index.8bs, "the
// constants a program folds on" and "the calls"): every machine twin answers
// the same ten constants, folded to literals, and exports the same seven
// calls, so one program links against any of them.
//
// This is the gate for that promise on every target, the way
// rasterline-charset.test.mjs is for Slot.CHARSET. It lives in the compiler's
// tests because the machine packages' own tests are not part of the CI gate
// (scripts/ci-excluded-packages.mjs); the emulator tests that show each twin
// actually drawing (packages/<machine>/test/graphics*.test.mjs) sit beside
// their machines.
//
// Three things are checked, none of them a screenshot:
//   1. a probe that reads every constant and calls every operation links on
//      all thirty-two targets with no diagnostics, and each constant folds to
//      a literal (so `if (graphics.RESTORES)` costs a machine that answers
//      false nothing);
//   2. the value each target answers is the one this table records, which is
//      also the table in docs/project/graphics.md;
//   3. where a twin states a constant as a literal, the source says what the
//      linker folded, and each twin source declares every constant and call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';
import { DEFAULT_MAX_STEPS } from '../src/media/lower-default.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, '..', '..', '..');
const SRC = join(CHECKOUT, 'packages', 'graphics', 'src');

const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web', 'plus4', 'oric', 'apple2', 'bbc', 'atari5200', 'lynx', 'pce', 'supervision', 'atari2600', 'atari7800', 'gb', 'gbc', 'sms', 'gamegear', 'sg1000', 'msx', 'coleco', 'spectrum', 'cpc', 'coco', 'vectrex', 'odyssey2', 'channelf'];

const NUMBERS = ['MAX', 'FRAMES', 'WIDTH', 'HEIGHT', 'COLORS', 'STEP_X', 'STEP_Y'];
const BOOLEANS = ['RECOLORS', 'RESTORES', 'TRANSPARENT'];
const CONSTANTS = [...NUMBERS, ...BOOLEANS];
const CALLS = ['bind', 'meta', 'place', 'hide', 'setFrame', 'animate', 'color', 'update'];

// What each machine with its own twin answers. docs/project/graphics.md
// ("The portable contract") is this table; change both together. A machine
// not named here takes the generic twin, below.
const TWINS = {
  pet: { file: 'index.pet.8bs', MAX: 8, FRAMES: 7, WIDTH: 16, HEIGHT: 16, COLORS: 1, STEP_X: 4, STEP_Y: 4, RECOLORS: false, RESTORES: true, TRANSPARENT: true },
  vic20: { file: 'index.vic20.8bs', MAX: 8, FRAMES: 8, WIDTH: 16, HEIGHT: 16, COLORS: 1, STEP_X: 8, STEP_Y: 8, RECOLORS: true, RESTORES: false, TRANSPARENT: false },
  c64: { file: 'index.c64.8bs', MAX: 24, FRAMES: 4, WIDTH: 24, HEIGHT: 21, COLORS: 1, STEP_X: 1, STEP_Y: 1, RECOLORS: true, RESTORES: true, TRANSPARENT: true },
  cx16: { file: 'index.cx16.8bs', MAX: 8, FRAMES: 2, WIDTH: 64, HEIGHT: 64, COLORS: 15, STEP_X: 1, STEP_Y: 1, RECOLORS: false, RESTORES: true, TRANSPARENT: true },
  web: { file: 'index.web.8bs', MAX: 8, FRAMES: 8, WIDTH: 8, HEIGHT: 8, COLORS: 1, STEP_X: 8, STEP_Y: 8, RECOLORS: true, RESTORES: false, TRANSPARENT: false },
  nes: { file: 'index.nes.8bs', MAX: 8, FRAMES: 4, WIDTH: 16, HEIGHT: 16, COLORS: 3, STEP_X: 1, STEP_Y: 1, RECOLORS: false, RESTORES: true, TRANSPARENT: true },
};

// The glyph path: a cell, tinted where the machine colours cells (RECOLORS
// follows the video.colorPerCell fact), drawn whole, restoring nothing.
const GENERIC = { file: 'index.8bs', MAX: 8, FRAMES: 4, WIDTH: 8, HEIGHT: 8, COLORS: 1, STEP_X: 8, STEP_Y: 8, RESTORES: false, TRANSPARENT: false };

// Reading a constant into a local keeps its folded value in the linked
// program; a bool is read by the `if` it guards, which link() folds the same
// way rasterline-charset.test.mjs relies on.
const PROBE = `import { graphics } from "@8bitscript/graphics";
export function main(): void {
${NUMBERS.map((name) => `    let n_${name}: usmallint = graphics.${name};`).join('\n')}
${BOOLEANS.map((name) => `    if (graphics.${name}) { graphics.hide(0); }`).join('\n')}
    graphics.place(0, 0, 0);
    graphics.hide(0);
    graphics.setFrame(0, 1);
    graphics.animate(0, false);
    graphics.color(0, 1);
    graphics.update();
    return;
}
`;

function probe(target) {
  const entry = join(HERE, 'graphics-contract-consumer.8bs');
  const { ir, diagnostics } = link(PROBE, entry, { machine: target, facts: stockFacts(target), checkout: CHECKOUT });
  assert.deepEqual(diagnostics, [], target);
  const main = ir.functions.find((f) => f.name === 'main');
  const values = {};
  for (const stmt of main.body.filter((s) => s.kind === 'local')) {
    assert.equal(stmt.init.kind, 'const', `${target}: graphics.${stmt.name.slice(2)} folds to a literal`);
    values[stmt.name.slice(2)] = stmt.init.value;
  }
  const guards = main.body.filter((s) => s.kind === 'if');
  assert.equal(guards.length, BOOLEANS.length, `${target}: every boolean guard survives linking`);
  guards.forEach((guard, i) => {
    assert.equal(guard.test.kind, 'const', `${target}: graphics.${BOOLEANS[i]} folds to a constant`);
    values[BOOLEANS[i]] = Boolean(guard.test.value);
  });
  const called = main.body.filter((s) => s.kind === 'call').map((s) => s.name);
  return { values, called };
}

test('every target links a probe that reads all ten constants and calls all seven operations, each constant folded to a literal', () => {
  for (const target of TARGETS) {
    const { values, called } = probe(target);
    for (const name of CONSTANTS) assert.ok(name in values, `${target}: graphics.${name}`);
    for (const call of ['place', 'hide', 'setFrame', 'animate', 'color', 'update']) {
      assert.ok(called.includes(`graphics_${call}`), `${target}: graphics.${call} is called in the linked program`);
    }
  }
});

test('the five release targets (and the NES) answer the values docs/project/graphics.md records', () => {
  for (const [target, expected] of Object.entries(TWINS)) {
    const { values } = probe(target);
    for (const name of CONSTANTS) {
      assert.equal(values[name], expected[name], `${target}: graphics.${name}`);
    }
  }
});

test('every other target answers the glyph path, and RECOLORS follows the machine colouring its cells', () => {
  for (const target of TARGETS.filter((t) => !(t in TWINS))) {
    const { values } = probe(target);
    for (const name of [...NUMBERS, 'RESTORES', 'TRANSPARENT']) {
      assert.equal(values[name], GENERIC[name], `${target}: graphics.${name}`);
    }
    assert.equal(values.RECOLORS, Boolean(stockFacts(target)['video.colorPerCell']), `${target}: graphics.RECOLORS is the colorPerCell fact`);
  }
});

test('a constant a twin states as a literal says in its source what the linker folded', () => {
  for (const target of TARGETS) {
    const file = (TWINS[target] ?? GENERIC).file;
    const source = readFileSync(join(SRC, file), 'utf8');
    const { values } = probe(target);
    for (const name of CONSTANTS) {
      const declaration = new RegExp(`^\\s+const ${name}: (?:utinyint|bool) = ([^;]+);`, 'm').exec(source);
      assert.ok(declaration, `${file}: declares graphics.${name}`);
      const text = declaration[1].trim();
      if (/^(\d+|true|false)$/.test(text)) {
        assert.equal(String(values[name]), text === 'true' ? 'true' : text === 'false' ? 'false' : text, `${file}: ${name} = ${text}`);
      }
    }
  }
});

test('every twin source declares all eight calls, and none of them is a stub that fails to link', () => {
  for (const file of new Set([GENERIC.file, ...Object.values(TWINS).map((t) => t.file)])) {
    const source = readFileSync(join(SRC, file), 'utf8');
    assert.match(source, /export namespace graphics \{/, file);
    for (const call of CALLS) assert.match(source, new RegExp(`function ${call}\\(`), `${file}: graphics.${call}`);
  }
});

test('the glyph path keeps as many animation steps as the default lowering emits', () => {
  const source = readFileSync(join(SRC, GENERIC.file), 'utf8');
  assert.equal(Number(/^const STEPS: utinyint = (\d+);/m.exec(source)[1]), DEFAULT_MAX_STEPS);
  assert.equal(GENERIC.FRAMES, DEFAULT_MAX_STEPS);
});

test('place() takes playfield pixels: the C64 twin adds the sprite layer\'s origin, the others hand the position on as it is', () => {
  const c64 = readFileSync(join(SRC, 'index.c64.8bs'), 'utf8');
  assert.match(c64, /sprites\.place\(slot, x \+ sprites\.ORIGIN_X, y \+ sprites\.ORIGIN_Y\);/);
  for (const file of ['index.8bs', 'index.pet.8bs', 'index.web.8bs']) {
    const code = readFileSync(join(SRC, file), 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /ORIGIN_[XY]/, `${file}: the origin is 0 on a cell machine, nothing to add`);
  }
});
