// Studio ships with the toolchain, so its tests hold it to the rules that
// implies: its version is the library's, every target links it clean, and
// each machine starts from the tier main.8bs picks for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { loadCatalog, resolveHardware, stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const cli = JSON.parse(readFileSync(join(ROOT, '..', 'cli', 'package.json'), 'utf8'));

const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

const ENTRY = join(SRC, 'main.8bs');

test('Studio declares itself an app, with a title and the shared entry', () => {
  assert.equal(pkg['8bitscript'].app.title, 'Studio');
  assert.equal(pkg['8bitscript'].app.entry, './src/main.8bs');
  assert.ok(existsSync(join(ROOT, '8bs.config.ts')), 'an app is a project: it has the manifest the CLI reads');
});

test("Studio's version is the toolchain's version, in package.json and on screen", () => {
  assert.equal(pkg.version, cli.version, '@8bitscript/studio and @8bitscript/cli share one version');
  const source = readFileSync(join(SRC, 'studio.8bs'), 'utf8');
  assert.match(source, new RegExp(`const VERSION: string = "${pkg.version.replace(/\\./g, '\\\\.')}";`),
    'the VERSION literal Studio prints must be package.json\'s version');
});

test('the CLI depends on Studio, so it ships with the toolchain', () => {
  assert.equal(cli.dependencies['@8bitscript/studio'], 'workspace:*');
});

for (const target of TARGETS) {
  test(`Studio links clean for ${target}`, () => {
    const { ir, diagnostics } = link(readFileSync(ENTRY, 'utf8'), ENTRY, { machine: target, facts: stockFacts(target) });
    assert.deepEqual(diagnostics, []);
    assert.equal(ir.entry, 'main');
  });
}

// Which tier main() hands studio.start() on a machine, read off the linked
// IR: the facts and the Tier names fold to constants, so every test in the
// if-chain is a comparison, a negation or a combination of folded
// constants, which this walks the way the machine would. One entry file,
// and the machine's facts pick the tier.
const TIERS = ['VIEWER', 'BASIC', 'FULL'];
const value = (expr) => {
  assert.equal(expr.kind, 'const', `not folded to a constant: ${JSON.stringify(expr)}`);
  return expr.value;
};
const truthy = (expr) => {
  if (expr.kind === 'const') return expr.value !== 0;
  if (expr.kind === 'unop' && expr.operator === '!') return !truthy(expr.argument);
  if (expr.kind === 'binop') {
    switch (expr.operator) {
      case '&&': return truthy(expr.left) && truthy(expr.right);
      case '||': return truthy(expr.left) || truthy(expr.right);
      case '==': return value(expr.left) === value(expr.right);
      case '!=': return value(expr.left) !== value(expr.right);
      case '<': return value(expr.left) < value(expr.right);
      case '<=': return value(expr.left) <= value(expr.right);
      case '>': return value(expr.left) > value(expr.right);
      case '>=': return value(expr.left) >= value(expr.right);
      default: break;
    }
  }
  assert.fail(`a test main.8bs is not expected to have: ${JSON.stringify(expr)}`);
};
const tierOf = (target, facts = stockFacts(target)) => {
  const { ir, diagnostics } = link(readFileSync(ENTRY, 'utf8'), ENTRY, { machine: target, facts });
  assert.deepEqual(diagnostics, [], target);
  const main = ir.functions.find((f) => f.name === 'main');
  let tier;
  const run = (statements) => {
    for (const s of statements) {
      if (s.kind === 'local' && s.name === 'tier') tier = s.init.value;
      if (s.kind === 'assign' && s.target === 'tier') tier = s.value.value;
      if (s.kind === 'if') run(truthy(s.test) ? s.then : s.else ?? []);
    }
  };
  run(main.body);
  return TIERS[tier];
};

// The sheet a build gets when hardware is chosen for it — `8bs build vic20
// --profile 8k` — so a tier can be asserted for a fitted machine and not
// only for the stock one.
const factsWith = (machine, profile) => {
  const resolved = resolveHardware(loadCatalog(machine), { profile });
  assert.ok(resolved.ok, `${machine} --profile ${profile}: ${resolved.error}`);
  return resolved.hardware.facts;
};

test('each machine starts from the tier its facts pick', () => {
  // No keyboard to edit with: the NES. The web has a keyboard now but
  // nothing to edit (glyphs, sprites and voices are all zero).
  assert.equal(tierOf('nes'), 'VIEWER');
  assert.equal(tierOf('web'), 'VIEWER');
  // A keyboard, but 3583 bytes to live in: read-only until the machine is expanded.
  assert.equal(tierOf('vic20'), 'VIEWER');
  // A keyboard and 31743 bytes, and nothing an editor could change: the PET's
  // font is in ROM, it has no sprites, and its one voice plays but does not
  // compose. RAM is not the PET's gate, so no expansion lifts it.
  assert.equal(tierOf('pet'), 'VIEWER');
  for (const target of ['c64', 'c128', 'atari8', 'cx16', 'mega65']) assert.equal(tierOf(target), 'FULL', target);
});

test('a RAM expansion lifts the VIC-20 to the basic tier; nothing lifts the PET', () => {
  // The catalog's own presets, resolved the way `8bs build --profile` does.
  assert.equal(tierOf('vic20', factsWith('vic20', 'unexpanded')), 'VIEWER'); // 3583 bytes
  assert.equal(tierOf('vic20', factsWith('vic20', '3k')), 'VIEWER');         // 6655, still under the budget
  assert.equal(tierOf('vic20', factsWith('vic20', '8k')), 'BASIC');          // 11775: characters and music edit
  assert.equal(tierOf('vic20', factsWith('vic20', '16k')), 'BASIC');
  assert.equal(tierOf('vic20', factsWith('vic20', '24k')), 'BASIC');
  // Every PET model, from the 4K 2001 to the 32K 8032, is a viewer.
  for (const model of ['2001', '3008', '3016', '3032', '4016', '4032', '8032']) {
    assert.equal(tierOf('pet', factsWith('pet', model)), 'VIEWER', model);
  }
});

test('the tier follows the facts, not the name: a machine with no facts is the placeholder sheet', () => {
  const { diagnostics } = link(readFileSync(ENTRY, 'utf8'), ENTRY, { machine: 'c64' });
  assert.ok(diagnostics.some((d) => d.code === '8BS1038'), 'a real build without its sheet is refused, not guessed');
});

test('Studio has one entry file: no main.<target>.8bs variants', () => {
  for (const target of TARGETS) assert.ok(!existsSync(join(SRC, `main.${target}.8bs`)), target);
});

test("Studio is set up for all nine machines, with the X16 as its baseline and a mouse as what it is designed for", () => {
  const config = readFileSync(join(ROOT, '8bs.config.ts'), 'utf8');
  assert.match(config, /^  baseline: 'cx16',$/m);
  assert.match(config, /^  input: \{ primary: 'mouse', also: \['keyboard', 'stick', 'pad'\] \},$/m);
  assert.match(config, /^    cx16: \{\},$/m);
  // The two Commodores whose input layer has a pointer ask for a 1351.
  assert.match(config, /^    c64: \{ hardware: \{ port1: 'mouse1351' \} \},$/m);
  assert.match(config, /^    c128: \{ hardware: \{ port1: 'mouse1351' \} \},$/m);
  // The desk needs more than a stock VIC-20 or a 4K PET holds (measured
  // below); the defaults are the machines that hold it.
  assert.match(config, /^    vic20: \{ hardware: \{ ram: '8k' \} \},$/m);
  assert.match(config, /^    pet: \{ hardware: \{ model: '4032', ram: '32' \} \},$/m);
  assert.match(config, /^    'Commander X16': \{ target: 'cx16' \},$/m);
  assert.match(config, /^    'C64 with a mouse': \{ target: 'c64' \},$/m);
  assert.doesNotMatch(config, /Parked until a later release/, 'nothing is parked any more');
});

// ---- the desk, built and driven -------------------------------------------
//
// Linking IR is how the tier tests see every machine, and it is not a
// build: Studio linked clean while every 6502 build of it failed on a
// 2-byte array store the native backend refused (#223). So the desk
// is built for real here, on every machine, from Studio's own directory
// so its config — the mouse, the 8K VIC-20, the 32K PET — is the one
// `8bs build` would use.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { instantiateProgram, FrameLimitReached } from '../../cli/src/wasm-host.mjs';
import { layoutFromHardware, InputEdge } from '../../cli/src/web-layout.mjs';

const run = promisify(execFile);
const BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');

/** `8bs build --target <target>` in Studio's own directory; the artifact's path from its own "built" line. */
async function buildStudio(target, args = []) {
  const { stdout } = await run(process.execPath, [BIN, 'build', '--target', target, ...args], { cwd: ROOT });
  const built = stdout.match(/^built (.+)$/m);
  assert.ok(built, stdout);
  return { outFile: built[1], stdout };
}

for (const target of TARGETS) {
  test(`Studio builds for ${target}, from its own config`, async () => {
    const { outFile } = await buildStudio(target);
    assert.ok(existsSync(outFile), outFile);
  });
}

test('a stock VIC-20 and a 4K PET cannot hold the desk, and the linker says by how much', async () => {
  // Not a floor in `requires`: memory.ram would refuse the NES, whose code
  // is in ROM and whose 1536 bytes of RAM hold the desk's variables fine.
  for (const [target, hardware] of [['vic20', 'ram=none'], ['pet', 'model=2001,ram=4']]) {
    await assert.rejects(
      run(process.execPath, [BIN, 'build', '--target', target, '--hardware', hardware], { cwd: ROOT }),
      (error) => {
        assert.equal(error.code, 1, target);
        assert.match(error.stderr, /byte\(s\) past the .* RAM ceiling/, target);
        return true;
      },
    );
  }
});

/**
 * Run Studio's web build headlessly with a script of key presses — each
 * held three frames with three idle frames between, the edge detector's
 * own rhythm — and hand back the screen as text, and whether the program
 * returned on its own (QUIT) or was stopped at the frame bound.
 */
async function drive(wasm, keys) {
  const layout = layoutFromHardware(resolveHardware(loadCatalog('web'), {}).hardware);
  const plan = new Map();
  keys.forEach((key, i) => {
    const at = 5 + i * 6;
    for (const f of [at, at + 1, at + 2]) plan.set(f, InputEdge[key]);
  });
  const total = 5 + keys.length * 6 + 6;
  let frame = 0;
  let mem;
  const program = await instantiateProgram(wasm, {
    waitFrame: () => {
      frame += 1;
      if (frame > total) throw new FrameLimitReached(total);
      mem[layout.inputOffset] = plan.get(frame) ?? 0;
    },
  });
  mem = new Uint8Array(program.memory.buffer);
  let returned = true;
  try {
    program.entry();
  } catch (error) {
    if (!(error instanceof FrameLimitReached)) throw error;
    returned = false;
  }
  const rows = [];
  for (let r = 0; r < layout.rows; r += 1) {
    let line = '';
    for (let c = 0; c < layout.cols; c += 1) {
      const code = mem[layout.charBase + r * layout.cols + c];
      // Reverse rides in bit 7 of the cell's color byte on this host
      // (packages/web/src/text.8bs): the highlight, shown in lower case.
      const reverse = (mem[layout.colorBase + r * layout.cols + c] & 0x80) !== 0;
      const glyph = code >= 32 && code < 127 ? String.fromCharCode(code) : '.';
      line += reverse ? glyph.toLowerCase() : glyph;
    }
    rows.push(line.replace(/\s+$/, ''));
  }
  return { rows, returned };
}

test('the desk works: keys walk the bar, open a menu, take an entry, close it, and QUIT returns', async () => {
  const built = await buildStudio('web');
  const wasm = readFileSync(built.outFile);

  // Untouched: the bar, deselected, over the front door.
  const door = await drive(wasm, []);
  assert.equal(door.rows[0], ' 8  FILE  CHARACTERS  SPRITES  MUSIC');
  assert.equal(door.rows[1], '8BITSCRIPT STUDIO');
  assert.equal(door.rows[4], 'VIEWER TIER');
  assert.equal(door.returned, false);

  // RIGHT from nothing lights the first item (the mark); CONFIRM opens its
  // menu, whose first entry is lit — shown here in lower case.
  const about = await drive(wasm, ['RIGHT', 'CONFIRM']);
  assert.equal(about.rows[0], ' 8  FILE  CHARACTERS  SPRITES  MUSIC', 'the mark is lit: a reverse "8" is still an 8');
  assert.match(about.rows[1], /^ about {6}TUDIO$/, 'the menu covers the door, its lit entry inverted');

  // Two RIGHTs reach FILE; the web has no storage, so its menu is QUIT
  // alone; CONFIRM takes it and the program returns.
  const quit = await drive(wasm, ['RIGHT', 'RIGHT', 'CONFIRM', 'CONFIRM']);
  assert.equal(quit.returned, true, 'QUIT returns from the program');

  // CHARACTERS > VIEW: the characters screen, on a host whose font is fixed.
  const chars = await drive(wasm, ['RIGHT', 'RIGHT', 'RIGHT', 'CONFIRM', 'CONFIRM']);
  assert.deepEqual(chars.rows.slice(0, 8), [
    ' 8  FILE  CHARACTERS  SPRITES  MUSIC',
    'CHARACTERS',
    'FONT IN ROM',
    '',
    '0123456789',
    'ABCDEFGHIJKLM',
    'NOPQRSTUVWXYZ',
    '! , - . : ?',
  ]);
  assert.equal(chars.rows[0], ' 8  FILE  CHARACTERS  SPRITES  MUSIC', 'taking an entry lets the bar go');

  // CANCEL closes an open menu and the screen under it comes back whole.
  const closed = await drive(wasm, ['LEFT', 'CONFIRM', 'CANCEL']);
  assert.equal(closed.rows[1], '8BITSCRIPT STUDIO');
  assert.match(closed.rows[0], /music$/, 'the bar item stays lit after CANCEL');

  // LEFT with a menu open closes it and opens the neighbour's.
  const walked = await drive(wasm, ['LEFT', 'LEFT', 'CONFIRM', 'LEFT']);
  assert.match(walked.rows[1], /^8BITSCRIP view$/, "SPRITES' menu closed, CHARACTERS' opened under its item");
});
