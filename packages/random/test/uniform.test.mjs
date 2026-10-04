// `range()` and `bits()` are exactly uniform, and the compiled code does what
// the algorithm in src/index.8bs says.
//
// The old `range()` was `next() % bound`, which favours the first `256 %
// bound` outcomes (7 chances in 256 against 6 on a 37-pocket wheel). These
// tests count rather than sample: the generator's high byte hits every value
// exactly 256 times over its 65,536-state period and the table's 256 bytes
// are every value once, so the number of times each outcome comes up over a
// whole period is a fact to assert, not a statistic to eyeball.
//
// Three layers, each catching what the one before cannot:
//   1. the model — the rejection rule worked out in plain JS for every bound
//      from 1 to 255 (the algorithm is uniform);
//   2. the compiled web program against that model, value for value (the
//      code is the algorithm);
//   3. the compiled web program over one whole period, counting outcomes
//      (the two together, end to end, with nothing taken on trust).
// The 6502 builds run the same IR; test/random.test.mjs links them for every
// target and the PR that added this file compared screenshots of the
// compiled draws on the C64, PET and VIC-20 with the model's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from '../../cli/src/build.mjs';
import { instantiateProgram } from '../../cli/src/wasm-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const LCG = join(SRC, 'index.8bs');
const TABLE = join(SRC, 'table.8bs');

// ---- the model -------------------------------------------------------------

/** The default generator: state = state * 25173 + 13849 (mod 65536), high byte out. */
function lcg(seed) {
  let state = seed & 0xffff;
  return () => {
    state = (state * 25173 + 13849) & 0xffff;
    return state >> 8;
  };
}

/** A byte is kept when the block it falls in is complete: v - v % n <= 256 - n. */
const accepted = (v, bound) => v - (v % bound) <= 256 - bound;

/** What `range(bound)` returns, drawing bytes from `next`. */
function modelRange(next, bound) {
  for (;;) {
    const v = next();
    if (accepted(v, bound)) return v % bound;
  }
}

test('the rule keeps exactly the bytes of whole blocks: 256 - 256 % bound of them, every residue equally', () => {
  for (let bound = 1; bound <= 255; bound += 1) {
    const perResidue = new Array(bound).fill(0);
    let kept = 0;
    for (let v = 0; v < 256; v += 1) {
      if (accepted(v, bound)) {
        perResidue[v % bound] += 1;
        kept += 1;
      }
    }
    assert.equal(kept, 256 - (256 % bound), `bound ${bound}: bytes kept`);
    assert.ok(perResidue.every((n) => n === Math.floor(256 / bound)), `bound ${bound}: every outcome gets ${Math.floor(256 / bound)} bytes`);
  }
});

test('the old `next() % bound` was not uniform: 37 pockets, 7 chances in 256 against 6', () => {
  const perResidue = new Array(37).fill(0);
  for (let v = 0; v < 256; v += 1) perResidue[v % 37] += 1;
  assert.equal(Math.max(...perResidue), 7);
  assert.equal(Math.min(...perResidue), 6);
  assert.equal(perResidue.filter((n) => n === 7).length, 34);
});

test('the generator hits every byte exactly 256 times per period — the fact the counts below stand on', () => {
  const next = lcg(1);
  const counts = new Array(256).fill(0);
  for (let i = 0; i < 65536; i += 1) counts[next()] += 1;
  assert.ok(counts.every((n) => n === 256));
});

// ---- compiling and running a web program -----------------------------------

/** Compile `source` for the web target and run it; the memory afterwards. */
async function runWeb(source) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-uniform-'));
  const prev = process.cwd();
  const log = console.log;
  try {
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, source);
    process.chdir(dir);
    console.log = () => {};
    const result = await compile('web', entry);
    console.log = log;
    assert.equal(result.ok, true, JSON.stringify(result));
    const program = await instantiateProgram(await readFile(result.outFile));
    program.entry();
    return new Uint8Array(program.memory.buffer).slice();
  } finally {
    console.log = log;
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
}

const OUT = 0x1000;

/** A program that writes `calls` draws of `draw` (an expression) to OUT.. */
const drawing = (imports, seed, draw, calls) => `${imports}
export function main(): void {
    ${seed}
    for (let i: usmallint = 0; i < ${calls}; i++) {
        memory.write(${OUT} + i, ${draw});
    }
}
`;

const BOUNDS = [1, 2, 3, 6, 7, 37, 52, 100, 128, 150, 200, 255];

test('compiled range() draws the same values as the model, for bounds from 1 to 255', async () => {
  for (const bound of BOUNDS) {
    const memory = await runWeb(drawing(`import { random } from ${JSON.stringify(LCG)};`, 'random.seed(777);', `random.range(${bound})`, 300));
    const next = lcg(777);
    const want = Array.from({ length: 300 }, () => modelRange(next, bound));
    assert.deepEqual(Array.from(memory.slice(OUT, OUT + 300)), want, `bound ${bound}`);
    assert.ok(want.every((v) => v < bound), `bound ${bound}: always below the bound`);
  }
});

test('compiled bits(k) is the top k bits of the next byte, for k from 1 to 8', async () => {
  for (let k = 1; k <= 8; k += 1) {
    const memory = await runWeb(drawing(`import { random } from ${JSON.stringify(LCG)};`, 'random.seed(31);', `random.bits(${k})`, 200));
    const next = lcg(31);
    const want = Array.from({ length: 200 }, () => next() >> (8 - k));
    assert.deepEqual(Array.from(memory.slice(OUT, OUT + 200)), want, `bits(${k})`);
    assert.ok(want.every((v) => v < 1 << k));
  }
});

test('a fixed seed gives a fixed sequence: two fresh runs agree with each other and with the model', async () => {
  const source = drawing(`import { random } from ${JSON.stringify(LCG)};`, 'random.seed(2468);', 'random.range(52)', 200);
  const a = await runWeb(source);
  const b = await runWeb(source);
  assert.deepEqual(a.slice(OUT, OUT + 200), b.slice(OUT, OUT + 200));
  const next = lcg(2468);
  assert.deepEqual(Array.from(a.slice(OUT, OUT + 200)), Array.from({ length: 200 }, () => modelRange(next, 52)));
});

// ---- every backend builds the whole surface ---------------------------------
//
// `link()` stops before a backend sees the program, and web's wasm has a
// variable shift the 6502 does not: a `bits()` written `>> (8 - count)` links
// everywhere and runs on the web, and is refused by every 6502 backend ("the
// '>>' operator needs a compile-time shift amount"). Only building shows it.

// The draws must be *used* — written to memory — or the program never calls
// them and a refused construct is optimised out before the backend sees it
// (the package's link probes store into a global nothing reads).

const ENTROPY = join(SRC, 'entropy.8bs');
const SURFACES = {
  random: { imports: `import { random } from ${JSON.stringify(LCG)};`, calls: ['random.range(6)', 'random.range(37)', 'random.bits(3)', 'random.bits(8)', 'random.next()'] },
  table: { imports: `import { table } from ${JSON.stringify(TABLE)};`, calls: ['table.range(6)', 'table.range(37)', 'table.bits(3)', 'table.next()'] },
  entropy: { imports: `import { entropy } from ${JSON.stringify(ENTROPY)};`, calls: ['entropy.range(6)', 'entropy.range(37)', 'entropy.bits(3)', 'entropy.next()'] },
};

for (const target of ['pet', 'vic20', 'c64', 'cx16', 'web']) {
  for (const [name, { imports, calls }] of Object.entries(SURFACES)) {
    test(`the ${name} generator's range() and bits() build for ${target}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), '8bs-uniform-build-'));
      const prev = process.cwd();
      const log = console.log;
      try {
        const entry = join(dir, 'main.8bs');
        const begin = name === 'entropy' ? '    entropy.begin();\n' : '';
        await writeFile(entry, `${imports}\nexport function main(): void {\n${begin}${calls.map((c, i) => `    memory.write(0x0300 + ${i}, ${c});`).join('\n')}\n}\n`);
        process.chdir(dir);
        console.log = () => {};
        const result = await compile(target, entry);
        console.log = log;
        assert.equal(result.ok, true, JSON.stringify(result));
      } finally {
        console.log = log;
        process.chdir(prev);
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

// ---- one whole period, counted ----------------------------------------------

const LO = 0x2000;
const HI = 0x2100;

/**
 * Every accepted draw of one full period of the generator: exactly
 * 256 * (256 - 256 % bound) of them. Calling range() that many times from any
 * seed takes in all of the period's accepted bytes (the draws after the last
 * one are all rejected), so each outcome must come up 256 * floor(256 / bound)
 * times — exactly.
 */
const counting = (imports, seed, bound, calls) => `${imports}
let counts: array<usmallint, 128>;
export function main(): void {
    ${seed}
    for (let i: usmallint = 0; i < ${calls}; i++) {
        let v: utinyint = draw(${bound});
        counts[v] = counts[v] + 1;
    }
    for (let k: utinyint = 0; k < ${bound}; k++) {
        memory.write(${LO} + k, counts[k] & 255);
        memory.write(${HI} + k, counts[k] >> 8);
    }
}
`;

test('over one whole period of the default generator, every outcome of range(n) comes up exactly 256 * floor(256 / n) times', async () => {
  for (const bound of [3, 6, 7, 10, 37, 52, 100]) {
    const calls = 256 * (256 - (256 % bound));
    assert.ok(calls < 65536, 'a loop counter is a usmallint');
    const source = counting(
      `import { random } from ${JSON.stringify(LCG)};\nfunction draw(n: utinyint): utinyint { return random.range(n); }`,
      'random.seed(4242);', bound, calls,
    );
    const memory = await runWeb(source);
    const want = 256 * Math.floor(256 / bound);
    const got = Array.from({ length: bound }, (_, k) => memory[LO + k] + 256 * memory[HI + k]);
    assert.deepEqual(got, new Array(bound).fill(want), `range(${bound}) counts over one period`);
  }
});

test('over one pass of the table (every byte once), every outcome of table.range(n) comes up exactly floor(256 / n) times', async () => {
  for (const bound of [3, 6, 7, 10, 37, 52, 100]) {
    const calls = 256 - (256 % bound);
    const source = counting(
      `import { table } from ${JSON.stringify(TABLE)};\nfunction draw(n: utinyint): utinyint { return table.range(n); }`,
      'table.seed(0);', bound, calls,
    );
    const memory = await runWeb(source);
    const got = Array.from({ length: bound }, (_, k) => memory[LO + k] + 256 * memory[HI + k]);
    assert.deepEqual(got, new Array(bound).fill(Math.floor(256 / bound)), `table.range(${bound}) counts over one pass`);
  }
});

test('table.bits(k) is the top k bits of the next table byte', async () => {
  const memory = await runWeb(drawing(`import { table } from ${JSON.stringify(TABLE)};`, 'table.seed(9);', 'table.bits(5)', 100));
  const source = (await readFile(TABLE, 'utf8')).match(/const TABLE: array<utinyint, 256> = \[([\s\S]*?)\];/)[1];
  const bytes = source.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  assert.deepEqual(Array.from(memory.slice(OUT, OUT + 100)), Array.from({ length: 100 }, (_, i) => bytes[(9 + i) % 256] >> 3));
});
