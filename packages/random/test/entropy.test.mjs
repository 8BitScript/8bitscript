// @8bitscript/random/entropy: one subpath, three implementations, chosen
// by the resolver's twin rule and never by the program. Checked three
// ways — the subpath itself resolves to the right file per machine; the
// probe links clean on all nine with the hardware module's `random_byte`
// on the C64 and the Atari 8-bit and the LCG's `random_next` on the other
// seven, never both; and on the web target the program is built and run,
// with its output checked against the LCG stepped independently here.
//
// The byte counts the source headers cite come from 2048, the consumer
// this subpath was extracted from: every one of its nine builds is
// byte-identical to the three twin files it replaced (2763 on the 4K PET
// 2001, 3490 on the unexpanded VIC-20, 4599 C64, 3720 Atari 8-bit, at
// 0.11.0). That is measured there, not here — this file proves the
// mechanism; the game proves the cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link, resolveSpecifier } from '../../compiler/index.mjs';
import { build } from '../../compiler/src/wasm/index.ts';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');
const CHECKOUT = resolve(ROOT, '..', '..');

const HARDWARE = ['c64', 'atari8'];
const SOFTWARE = ['vic20', 'pet', 'c128', 'nes', 'cx16', 'mega65', 'web'];
const TARGETS = [...HARDWARE, ...SOFTWARE];

const PROBE = join(HERE, 'entropy-probe.8bs');

test('the package exports ./entropy, and it depends on the two machine packages its twins import', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg['8bitscript'].exports['./entropy'], './src/entropy.8bs');
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@8bitscript/atari8', '@8bitscript/c64']);
});

test('the subpath resolves to a twin on the two machines with an entropy source, and to the portable file everywhere else', () => {
  // From a consumer's file, through the checkout, the way `8bs build
  // --checkout` resolves it — a package does not resolve its own name.
  const consumer = join(CHECKOUT, 'packages', 'examples', 'hello-world', 'src', 'hello-world.8bs');
  for (const machine of TARGETS) {
    const resolved = resolveSpecifier('@8bitscript/random/entropy', consumer, { machine, checkout: CHECKOUT });
    assert.ok(resolved && !resolved.code, `${machine}: ${resolved?.message ?? 'unresolved'}`);
    const expected = HARDWARE.includes(machine) ? `entropy.${machine}.8bs` : 'entropy.8bs';
    assert.equal(resolved.path, join(SRC, expected), machine);
  }
});

test('without a machine — 8bs check, the editor — the subpath still resolves, to the portable file', () => {
  const consumer = join(CHECKOUT, 'packages', 'examples', 'hello-world', 'src', 'hello-world.8bs');
  const resolved = resolveSpecifier('@8bitscript/random/entropy', consumer, { checkout: CHECKOUT });
  assert.ok(resolved && !resolved.code, resolved?.message);
  assert.equal(resolved.path, join(SRC, 'entropy.8bs'));
});

for (const target of TARGETS) {
  test(`entropy links clean for ${target}, with the whole surface in the IR`, () => {
    const source = readFileSync(PROBE, 'utf8');
    const { ir, diagnostics } = link(source, PROBE, { machine: target, facts: stockFacts(target) });
    assert.deepEqual(diagnostics, []);
    assert.equal(ir.entry, 'main');
    const names = new Set(ir.functions.map((f) => f.name));
    for (const call of ['entropy_begin', 'entropy_tick', 'entropy_next', 'entropy_range', 'entropy_bits']) {
      assert.ok(names.has(call), `${call} is missing from the linked program`);
    }
  });
}

for (const target of HARDWARE) {
  test(`on the ${target} the twin is taken: the hardware module's byte(), no LCG`, () => {
    const source = readFileSync(PROBE, 'utf8');
    const { ir } = link(source, PROBE, { machine: target, facts: stockFacts(target) });
    const names = new Set(ir.functions.map((f) => f.name));
    assert.ok(names.has('random_byte'), 'the machine package\'s random.byte() is linked');
    assert.ok(!names.has('random_next'), 'the software generator is not linked');
    // Only the C64 has anything to claim; POKEY's counter is free-running.
    assert.equal(names.has('random_begin'), target === 'c64', 'random.begin() is the C64\'s alone');
  });
}

for (const target of SOFTWARE) {
  test(`on the ${target} the portable file is taken: the LCG, nothing read from hardware`, () => {
    const source = readFileSync(PROBE, 'utf8');
    const { ir } = link(source, PROBE, { machine: target, facts: stockFacts(target) });
    const names = new Set(ir.functions.map((f) => f.name));
    assert.ok(names.has('random_next'), 'the software generator is linked');
    assert.ok(!names.has('random_byte'), 'no hardware module is linked');
  });
}

test('the software entropy forwards range() and bits() to the default generator — one copy of the rejection loop, measured free', () => {
  // A `return f(x);` delegate costs nothing now (the entropy probe is 231
  // bytes of program on the PET with the loop written out and with this
  // forward); before the compiler folded those it cost 8 bytes a target.
  const source = readFileSync(join(SRC, 'entropy.8bs'), 'utf8');
  assert.match(source.split('function range')[1], /return random\.range\(bound\);/);
  assert.match(source.split('function bits')[1], /return random\.bits\(count\);/);
});

test('the two hardware twins carry their own rejection loop over the register, not the modulo bias', () => {
  // A twin reads a register rather than the software generator, so it cannot
  // forward; what it must not do is take `byte % bound` and call that a
  // range — the first `256 % bound` outcomes would be favoured.
  for (const file of ['entropy.c64.8bs', 'entropy.atari8.8bs']) {
    const source = readFileSync(join(SRC, file), 'utf8');
    const body = source.split('function range')[1].split('function bits')[0];
    assert.match(body, /let limit: utinyint = 0 - bound;/, `${file}: the block limit`);
    assert.match(body, /while \(value - rest > limit\)/, `${file}: rejects the incomplete last block`);
    assert.equal((body.match(/random\.byte\(\)/g) ?? []).length, 2, `${file}: reads the register for the first draw and each redraw`);
    const bitsBody = source.split('function bits')[1];
    assert.match(bitsBody, /let value: utinyint = random\.byte\(\);/, `${file}: bits() reads one byte`);
    assert.match(bitsBody, /for \(let i: utinyint = count; i < 8; i\+\+\)/, `${file}: bits() shifts it down to the top bits, a bit at a time`);
    assert.doesNotMatch(bitsBody, />> \(/, `${file}: no run-time shift amount (the 6502 backend refuses one)`);
  }
});

// The generator itself: state = state * 25173 + 13849 (mod 65536), the
// result is the new state's high byte — ../src/index.8bs, stepped from
// its initializer of 1 because the subpath never seeds it.
function referenceLcg(seed) {
  let state = seed & 0xffff;
  return () => {
    state = (state * 25173 + 13849) & 0xffff;
    return state >> 8;
  };
}

test('built and run for the web, the software path is the LCG from state 1, with tick() stepping it', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-random-entropy-'));
  try {
    const entry = join(HERE, 'entropy-values-main.8bs');
    const { ir, diagnostics } = link(readFileSync(entry, 'utf8'), entry, { machine: 'web', facts: stockFacts('web') });
    assert.deepEqual(diagnostics, []);
    const result = await build(ir, { outFile: join(scratch, 'entropy.wasm'), frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const { instance } = await WebAssembly.instantiate(result.bytes, {});
    instance.exports.main();
    const memory = new Uint8Array(instance.exports.memory.buffer);

    const next = referenceLcg(1);
    // range(n): draw until the byte falls in a complete block of n (the
    // incomplete last block is thrown away — see ../src/index.8bs).
    const range = (n) => {
      for (;;) {
        const v = next();
        if (v - (v % n) <= 256 - n) return v % n;
      }
    };
    next();                                       // tick()
    assert.equal(memory[0x1100], next());         // next()
    assert.equal(memory[0x1101], next());         // next()
    assert.equal(memory[0x1102], range(6));       // range(6)
    next();                                       // tick()
    assert.equal(memory[0x1103], range(10));      // range(10)
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
