// @8bitscript/pointer is a capability package, so its tests hold it to what
// that promises: every target has an entry, the surface is the same four
// calls and one const everywhere, a machine that cannot draw an arrow costs
// its programs nothing for the layer, and the one machine that can really
// draws it — checked in pixels, under its own emulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts, loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';
import { pixelAt } from '../../cli/src/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REPO = join(ROOT, '..', '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

// The four calls and the const every layer answers, whatever it answers.
const SURFACE = ['begin', 'setColor', 'update', 'hide'];

test('every target has an entry, and each names a real file in its machine package', () => {
  const entry = pkg['8bitscript'].entry;
  assert.deepEqual(Object.keys(entry).sort(), [...TARGETS].sort());
  for (const [target, specifier] of Object.entries(entry)) {
    // "@8bitscript/c64/pointer" has to be a subpath that machine exports.
    const [, machine, subpath] = specifier.split('/');
    assert.equal(machine, target, `${target} names ${specifier}`);
    const machinePkg = JSON.parse(readFileSync(join(REPO, 'packages', machine, 'package.json'), 'utf8'));
    const file = machinePkg['8bitscript'].exports[`./${subpath}`];
    assert.ok(file, `${machine} does not export ./${subpath}`);
    assert.ok(existsSync(join(REPO, 'packages', machine, file)), `${machine}'s ./${subpath} names ${file}, which does not exist`);
    assert.ok(pkg.dependencies[`@8bitscript/${machine}`], `${machine} is an entry but not a dependency`);
  }
  // A capability package has no source and nothing to import bare: a
  // program writes `import { pointer } from "@8bitscript/pointer"` and the
  // entry map decides which file that is.
  assert.equal(pkg['8bitscript'].exports, undefined);
});

test('every layer answers the same four calls and the same const', () => {
  for (const target of TARGETS) {
    const specifier = pkg['8bitscript'].entry[target];
    const [, machine, subpath] = specifier.split('/');
    const machinePkg = JSON.parse(readFileSync(join(REPO, 'packages', machine, 'package.json'), 'utf8'));
    const source = readFileSync(join(REPO, 'packages', machine, machinePkg['8bitscript'].exports[`./${subpath}`]), 'utf8');
    for (const call of SURFACE) {
      assert.match(source, new RegExp(`function ${call}\\(`), `${target} has no ${call}()`);
    }
    assert.match(source, /const DRAWS: bool = /, `${target} does not declare DRAWS`);
  }
});

// One program using every call: if it links for a target, the whole
// capability compiles there — a layer that does not exist is not a program
// without a cursor, it is a program that does not build.
//
// It lives in examples/pointer rather than in this directory because **a
// package does not resolve its own name**, and a capability package is
// nothing but its name: a probe here could only import the machine layers
// directly, which is the one thing this package exists to stop a program
// doing. The example is a genuine consumer, resolving through node_modules
// the way an outside project will.
const EXAMPLE = join(REPO, 'examples', 'pointer');
const PROBE = join(EXAMPLE, 'src', 'main.8bs');

for (const target of TARGETS) {
  test(`the pointer links clean for ${target}`, () => {
    const source = readFileSync(PROBE, 'utf8');
    const facts = (target === 'c64' || target === 'c128')
      // The C64's and C128's arrows only exist on a build fitted with a
      // mouse, so those are the targets where the interesting code is
      // behind a fact.
      ? resolveHardware(loadCatalog(target), { overrides: { port1: 'mouse1351' } }).hardware.facts
      : stockFacts(target);
    const { ir, diagnostics } = link(source, PROBE, { machine: target, facts });
    assert.deepEqual(diagnostics, []);
    assert.equal(ir.entry, 'main');
  });
}

test('a machine with no arrow to draw pays nothing for the layer', () => {
  // Every answer is a constant, so there is no state and nothing to call:
  // the same zero @8bitscript/input's empty layers measure at.
  const source = readFileSync(PROBE, 'utf8');
  const { ir } = link(source, PROBE, { machine: 'pet', facts: stockFacts('pet') });
  const pointerFns = ir.functions.filter((f) => f.name.startsWith('pointer_'));
  for (const fn of pointerFns) {
    assert.equal(fn.body.length, 0, `pointer.${fn.name} has a body on a machine with no pointer`);
  }
  assert.equal(ir.globals.filter((g) => g.name === 'there').length, 0, 'a machine with no pointer keeps no pointer state');
});

test('the arrow is behind the mouse fact, and the fact is what the catalog says', () => {
  // The fold itself happens below the IR — `if (HAS_MOUSE)` reaches the
  // backend as `if (0)` and clang deletes it — so what is checkable here
  // is that the layer is gated on the fact at all, and that the fact is
  // false on a stock C64, true for a build fitted with a 1351, and true
  // on the stock X16 (the emulator's mouse is always there). The bytes
  // the fold saves are measured, not asserted: see AGENTS.md.
  assert.equal(stockFacts('c64')['input.mouse'], false);
  const fitted = resolveHardware(loadCatalog('c64'), { overrides: { port1: 'mouse1351' } }).hardware;
  assert.equal(fitted.facts['input.mouse'], true);
  assert.equal(stockFacts('cx16')['input.mouse'], true);

  const fittedC128 = resolveHardware(loadCatalog('c128'), { overrides: { port1: 'mouse1351' } }).hardware;
  assert.equal(stockFacts('c128')['input.mouse'], false);
  assert.equal(fittedC128.facts['input.mouse'], true);

  const layer = readFileSync(join(REPO, 'packages', 'c64', 'src', 'pointer.8bs'), 'utf8');
  assert.match(layer, /const HAS_MOUSE: bool = #fact\(input\.mouse\);/);
  // Every function that touches the hardware is inside the fact's branch,
  // so a build without a mouse reaches none of it.
  for (const call of ['sprites.setShape', 'sprites.place', 'sprites.show', 'sprites.hide']) {
    assert.ok(layer.includes(call), `the C64 layer should use ${call}`);
  }
  assert.equal(
    layer.match(/if \(HAS_MOUSE\) \{/g).length,
    SURFACE.length,
    'every call in the surface should gate its body on the mouse fact',
  );

  const c128 = readFileSync(join(REPO, 'packages', 'c128', 'src', 'pointer.8bs'), 'utf8');
  assert.match(c128, /const HAS_MOUSE: bool = #fact\(input\.mouse\);/);
  assert.equal(
    c128.match(/if \(HAS_MOUSE\) \{/g).length,
    SURFACE.length,
    'every call in the C128 surface should gate its body on the mouse fact',
  );
});

// The one that would have caught the bug this package was written against:
// the sprite was enabled and positioned correctly and still never appeared,
// because presence was read twice in a frame and the two reads disagreed.
// Pixels are the only thing that says an arrow is really on the screen.
//
// Absolute coordinates would be a guess at where VICE puts the playfield in
// its window, so this compares two runs of the same program instead: a
// 1351 reads its zero until it is moved, so a fitted build has the arrow in
// the top-left corner and a build with the mouse taken out has nothing
// there. The example keeps its first two rows blank for exactly this.
test('under VICE, the C64 draws an arrow in the corner, and a machine with no mouse draws none', { timeout: 180000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-pointer-'));
  try {
    const cornerWhite = (hardware) => {
      const shot = join(dir, `${hardware}.png`);
      execFileSync(
        join(REPO, 'node_modules', '.bin', '8bs'),
        ['run', 'c64', '--hardware', `port1=${hardware}`, '--screenshot', shot],
        { cwd: EXAMPLE, stdio: 'pipe' },
      );
      const png = readFileSync(shot);
      // The playfield's first two rows, which the example keeps blank.
      // Measured in this window: the top-left pixel of the screen is at
      // (33, 23) — the arrow's tip lands there with the mouse at its zero
      // — and the first text is row 2, at y 39. White is the arrow's
      // colour and nothing else up here is white in either build.
      let count = 0;
      for (let y = 23; y < 39; y++) {
        for (let x = 32; x < 64; x++) {
          const c = pixelAt(png, x, y);
          const [r, g, b] = Array.isArray(c) ? c : [c.r, c.g, c.b];
          if (r > 200 && g > 200 && b > 200) count += 1;
        }
      }
      return count;
    };

    const fitted = cornerWhite('mouse1351');
    const bare = cornerWhite('none');
    assert.equal(bare, 0, `a C64 with no mouse should draw nothing in the corner, found ${bare} white pixels`);
    assert.ok(fitted > 20, `a C64 with a 1351 should draw an arrow in the corner, found only ${fitted} white pixels`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('under VICE, the C128 draws an arrow in the corner, and a machine with no mouse draws none', { timeout: 180000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-pointer-c128-'));
  try {
    const cornerWhite = (hardware) => {
      const shot = join(dir, `${hardware}.png`);
      execFileSync(
        join(REPO, 'node_modules', '.bin', '8bs'),
        ['run', 'c128', '--hardware', `port1=${hardware}`, '--screenshot', shot],
        { cwd: EXAMPLE, stdio: 'pipe' },
      );
      const png = readFileSync(shot);
      // Same rest position as the C64: a 1351's zero is the top-left, and
      // the example keeps the first two rows blank. Measured under x128:
      // the playfield origin is at (32, 23) as on the C64, 58 white
      // pixels with a mouse and 0 without.
      let count = 0;
      for (let y = 23; y < 39; y++) {
        for (let x = 32; x < 64; x++) {
          const c = pixelAt(png, x, y);
          const [r, g, b] = Array.isArray(c) ? c : [c.r, c.g, c.b];
          if (r > 200 && g > 200 && b > 200) count += 1;
        }
      }
      return count;
    };

    const fitted = cornerWhite('mouse1351');
    const bare = cornerWhite('none');
    assert.equal(bare, 0, `a C128 with no mouse should draw nothing in the corner, found ${bare} white pixels`);
    assert.ok(fitted > 20, `a C128 with a 1351 should draw an arrow in the corner, found only ${fitted} white pixels`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}

// The X16's rest position is the centre, not the corner: mouse_config
// parks there, and screen.8bs's 16-pixel inset puts the firmware sprite
// on the screenshot at (335, 254) — (319, 239) plus that inset. The
// example's top two rows are white text, so a corner count would not
// prove an arrow. This box is where the KERNAL arrow actually is.
test(
  'under x16emu, the X16 draws the KERNAL arrow at the centre',
  {
    timeout: 180000,
    skip: (!process.env.LLVM_MOS_HOME && 'LLVM_MOS_HOME not set')
      || (!onPath('x16emu') && 'x16emu not on PATH')
      || (!onPath('ffmpeg') && 'ffmpeg not on PATH (the x16emu screenshot route needs it)'),
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), '8bs-pointer-cx16-'));
    try {
      const shot = join(dir, 'cx16.png');
      execFileSync(
        join(REPO, 'node_modules', '.bin', '8bs'),
        ['run', 'cx16', '--screenshot', shot],
        { cwd: EXAMPLE, stdio: 'pipe' },
      );
      const png = readFileSync(shot);
      let count = 0;
      for (let y = 248; y < 272; y++) {
        for (let x = 328; x < 352; x++) {
          const c = pixelAt(png, x, y);
          const [r, g, b] = Array.isArray(c) ? c : [c.r, c.g, c.b];
          if (r > 200 && g > 200 && b > 200) count += 1;
        }
      }
      assert.ok(count > 20, `the X16 should draw the KERNAL arrow at the centre, found only ${count} white pixels`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
