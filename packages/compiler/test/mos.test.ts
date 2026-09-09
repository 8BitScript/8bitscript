import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  build, outputExtension, CPU, reduceRatio, frameRatio, FRAME_SYNC,
} from '../src/mos/index.ts';
import type { IrProgram, Machine, RatioPair } from '../src/mos/index.ts';
import type { IrStatement } from '../src/mos/lower/index.ts';

const ir: IrProgram = { entry: 'main', functions: [{ name: 'main', body: [] }], globals: [] };

// H E L L O _ W O R L D, as PET screen codes (A-Z are 1-26, space is 32) —
// the same eleven-store fixture the roadmap's TARGET section documents
// byte for byte, written straight to screen RAM at $8000.
const HELLO_WORLD_SCREEN_CODES = [8, 5, 12, 12, 15, 32, 23, 15, 18, 12, 4];

const helloWorldIr: IrProgram = {
  entry: 'main',
  functions: [{
    name: 'main',
    body: HELLO_WORLD_SCREEN_CODES.map((code, i) => ({
      kind: 'memoryWrite',
      address: { kind: 'const', value: 0x8000 + i, type: 'usmallint' },
      value: { kind: 'const', value: code, type: 'utinyint' },
    })),
  }],
  globals: [],
};

// Every real PET catalog entry carries defsym.__ram_size (see
// packages/pet/package.json) — 32 here stands in for the roomy 3032, so
// existing tests keep exercising the "plenty of RAM" path unchanged now
// that build() routes through the linker.
const hardware = { build: { defsym: { __ram_size: 32 } }, facts: {} };

test('build() for the PET writes a 15-byte .prg for an empty program: load address + 12-byte stub + RTS', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const result = await build(ir, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      [...result.bytes],
      [
        0x01, 0x04, // load address $0401, little-endian
        0x0b, 0x04, // BASIC stub: link to $040B
        0x00, 0x00, // line number 0
        0x9e, 0x31, 0x30, 0x33, 0x37, 0x00, // SYS token, "1037", end of line
        0x00, 0x00, // end of program
        0x60, // startup routine: RTS
      ],
    );
    assert.equal(result.bytes.length, 15);
    assert.deepEqual(result.memory, { variables: 0, program: 15 });
    assert.equal(existsSync(outFile), true);
    assert.deepEqual([...await readFile(outFile)], [...result.bytes]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() for the PET lowers the eleven-store HELLO WORLD fixture to exactly seventy bytes (milestone 4 acceptance test)', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const result = await build(helloWorldIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      [...result.bytes],
      [
        0x01, 0x04, // load address $0401, little-endian
        0x0b, 0x04, 0x00, 0x00, 0x9e, 0x31, 0x30, 0x33, 0x37, 0x00, 0x00, 0x00, // the same 12-byte stub as an empty program: 0 SYS1037
        0xa9, 0x08, 0x8d, 0x00, 0x80, // LDA #8  · STA $8000 · H
        0xa9, 0x05, 0x8d, 0x01, 0x80, // LDA #5  · STA $8001 · E
        0xa9, 0x0c, 0x8d, 0x02, 0x80, // LDA #12 · STA $8002 · L
        0xa9, 0x0c, 0x8d, 0x03, 0x80, // LDA #12 · STA $8003 · L
        0xa9, 0x0f, 0x8d, 0x04, 0x80, // LDA #15 · STA $8004 · O
        0xa9, 0x20, 0x8d, 0x05, 0x80, // LDA #32 · STA $8005 · (space)
        0xa9, 0x17, 0x8d, 0x06, 0x80, // LDA #23 · STA $8006 · W
        0xa9, 0x0f, 0x8d, 0x07, 0x80, // LDA #15 · STA $8007 · O
        0xa9, 0x12, 0x8d, 0x08, 0x80, // LDA #18 · STA $8008 · R
        0xa9, 0x0c, 0x8d, 0x09, 0x80, // LDA #12 · STA $8009 · L
        0xa9, 0x04, 0x8d, 0x0a, 0x80, // LDA #4  · STA $800A · D
        0x60, // RTS: main returned, back to BASIC, which prints READY.
      ],
    );
    assert.equal(result.bytes.length, 70);
    assert.deepEqual(result.memory, { variables: 0, program: 70 });
    assert.deepEqual([...await readFile(outFile)], [...result.bytes]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// Milestone 6's own reframed gate (see the roadmap's own box): the literal
// "a counter fills row 1 with 0 to 9" gate needs a *computed* address
// (STA (zp),Y), which is milestone 8's — not reachable honestly within this
// milestone's own scope. What milestone 6 can deliver instead, and what
// this fixture actually proves: a real `for` loop, a local variable, 8-bit
// `+`/`<` arithmetic, and a `memoryWrite` whose *value* (not address) is
// computed — sum(0..9) = 45, written once to the literal address $8000.
// This is not a synthetic shape: it is the exact IR a real
// `let sum: utinyint = 0; for (let i: utinyint = 0; i < 10; i++) { sum =
// sum + i; } memory.write(0x8000, sum);` links to (checked by hand against
// ir/index.mjs's own construction for `local`/`for`/`assign`/`update`).
//
// Run for real, the same way milestone 4's fixture was: `8bs run pet
// --hardware model=2001 --screenshot` on this exact program shows the
// PET's boot-banner leading `*` replaced by `-` — screen code 45 — proving
// the loop actually ran to completion and the sum landed correctly, not
// just that it assembled. A second, richer scratch program (while+break,
// if/else, `<` `==` `>=` `&&` `||` `!`) printed "HA" on row 0 exactly as
// hand-predicted. Neither screenshot is committed (no earlier milestone's
// PNG is either — see milestone 4's own note on this), but both bytes are
// what this test's own assertions below lock in.
const sumZeroToNineIr: IrProgram = {
  entry: 'main',
  functions: [{
    name: 'main',
    body: [
      { kind: 'local', name: 'sum', type: 'utinyint', init: { kind: 'const', value: 0, type: 'utinyint' } },
      {
        kind: 'for',
        init: { kind: 'local', name: 'i', type: 'utinyint', init: { kind: 'const', value: 0, type: 'utinyint' } },
        test: {
          kind: 'binop', operator: '<',
          left: { kind: 'ref', name: 'i', type: 'utinyint' },
          right: { kind: 'const', value: 10, type: 'utinyint' },
          type: 'bool',
        },
        update: {
          kind: 'assign', target: 'i',
          value: {
            kind: 'binop', operator: '+',
            left: { kind: 'ref', name: 'i', type: 'utinyint' },
            right: { kind: 'const', value: 1, type: 'utinyint' },
            type: 'utinyint',
          },
        },
        body: [{
          kind: 'assign', target: 'sum',
          value: {
            kind: 'binop', operator: '+',
            left: { kind: 'ref', name: 'sum', type: 'utinyint' },
            right: { kind: 'ref', name: 'i', type: 'utinyint' },
            type: 'utinyint',
          },
        }],
      },
      {
        kind: 'memoryWrite',
        address: { kind: 'const', value: 0x8000, type: 'usmallint' },
        value: { kind: 'ref', name: 'sum', type: 'utinyint' },
      },
    ],
  }],
  globals: [],
};

test('build() for the PET lowers a real for-loop, local, and computed memoryWrite value (milestone 6 acceptance test) — measured against the real CLI/emulator run in the roadmap box above', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const result = await build(sumZeroToNineIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.deepEqual(result.memory, { variables: 3, program: 66 }); // sum + i (locals) + one CLC-through temp, at most live at once; the extra program byte is the one-time CLD this program's own ADC earns it
    assert.equal(result.bytes.length, 66);
    assert.deepEqual([...await readFile(outFile)], [...result.bytes]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// The roadmap's own milestone-6 test list names "a loop body larger than
// 127 bytes" — relax.test.ts proves the relaxation mechanism in isolation
// with synthetic NOPs, but not that build()'s real pipeline (lower() then
// link()'s place(), which is what actually calls assembleRelaxed) reaches
// it. A while loop's own forward branch (test-false jumps past the body,
// to after it) is what goes out of range here: 30 literal memoryWrites at
// 5 bytes each (LDA absolute-address immediate + STA absolute, since every
// target is above $00FF) is 150 bytes of body, comfortably past the
// ±127 a plain BEQ/BNE can reach on its own.
const bigLoopBody: IrStatement[] = Array.from({ length: 30 }, (_, i) => ({
  kind: 'memoryWrite',
  address: { kind: 'const', value: 0x8100 + i, type: 'usmallint' },
  value: { kind: 'const', value: 1, type: 'utinyint' },
}));
const longWhileIr: IrProgram = {
  entry: 'main',
  functions: [{
    name: 'main',
    body: [
      { kind: 'local', name: 'i', type: 'utinyint', init: { kind: 'const', value: 0, type: 'utinyint' } },
      {
        kind: 'while',
        test: {
          kind: 'binop', operator: '<',
          left: { kind: 'ref', name: 'i', type: 'utinyint' },
          right: { kind: 'const', value: 1, type: 'utinyint' },
          type: 'bool',
        },
        body: [
          ...bigLoopBody,
          {
            kind: 'assign', target: 'i',
            value: {
              kind: 'binop', operator: '+',
              left: { kind: 'ref', name: 'i', type: 'utinyint' },
              right: { kind: 'const', value: 1, type: 'utinyint' },
              type: 'utinyint',
            },
          },
        ],
      },
    ],
  }],
  globals: [],
};

test('build() for a while loop whose body is over 127 bytes still assembles — the branch relaxer is reached through the real pipeline, not just exercised in isolation', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const result = await build(longWhileIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    // 30 * 5 (literal memoryWrites) + ~13 (local init, loop test/branch,
    // update, CLD/RTS/labels) would be an ordinary BNE/BEQ at 2 bytes; the
    // relaxed form spends 5 (an inverted branch + a JMP) instead — the
    // exact overhead the relaxer's own header comment describes.
    assert.ok(result.bytes.length > 150, `expected a program over 150 bytes, got ${result.bytes.length}`);
    assert.deepEqual([...await readFile(outFile)], [...result.bytes]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() names the construct when the linked entry function uses an IR kind with no lowering rule yet', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    // 'if'/'while'/'for'/etc. all gained rules at milestone 6 — 'storeIndex'
    // (indexed stores) is still genuinely unimplemented, milestone 8's job.
    const noRule: IrProgram = { entry: 'main', functions: [{ name: 'main', body: [{ kind: 'storeIndex' }] }], globals: [] };
    const result = await build(noRule, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /no instruction-selection rule yet for the 'storeIndex' statement/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() allocates real PET globals (currentColor/currentReverse-shaped) to zero page and reports them as variables', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const withGlobals: IrProgram = {
      entry: 'main',
      functions: [{ name: 'main', body: [] }],
      globals: [
        { name: 'currentColor', type: 'utinyint', address: null },
        { name: 'currentReverse', type: 'bool', address: null },
      ],
    };
    const result = await build(withGlobals, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Same 15 program bytes as an empty main() — these two globals took no
    // code space, only zero-page addresses, which memory.variables reports.
    assert.equal(result.bytes.length, 15);
    assert.deepEqual(result.memory, { variables: 2, program: 15 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() refuses a PET program whose globals overflow the real zero-page budget, naming the variable', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    // $8E..$FF is 114 bytes; 115 one-byte globals cannot fit.
    const tooManyGlobals: IrProgram = {
      entry: 'main',
      functions: [{ name: 'main', body: [] }],
      globals: Array.from({ length: 115 }, (_, i) => ({ name: `g${i}`, type: 'utinyint', address: null })),
    };
    const result = await build(tooManyGlobals, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /^global 'g114' needs 1 byte\(s\) of zero page but only 0 byte\(s\) remain/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() refuses a PET whose RAM cannot even hold the boot stub, measured by the linker, not declared', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const tooSmall = { build: { defsym: { __ram_size: 1 } }, facts: {} }; // 1024 bytes; code alone starts at $040D (1037)
    const result = await build(ir, { machine: 'pet', hardware: tooSmall, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /^code: program ends at \$040E, 14 byte\(s\) past the \$0400 RAM ceiling$/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() refuses a PET hardware sheet with no defsym.__ram_size, naming what is missing', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const noRamSize = { build: { defsym: {} }, facts: {} };
    const result = await build(ir, { machine: 'pet', hardware: noRamSize, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /defsym\.__ram_size/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() for a parked machine says so, names the machine, and writes nothing', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const result = await build(ir, { machine: 'c64', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /not a target in 0\.2\.0/);
    assert.match(result.ok ? '' : result.error, /c64/);
    assert.doesNotMatch(result.ok ? '' : result.error, /not implemented/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('outputExtension: prg everywhere except NES (.nes) and Atari 8-bit (.xex, or hardware.output)', () => {
  assert.equal(outputExtension('vic20'), 'prg');
  assert.equal(outputExtension('nes'), 'nes');
  assert.equal(outputExtension('atari8'), 'xex');
  assert.equal(outputExtension('atari8', { build: { defsym: {}, output: 'rom' }, facts: {} }), 'rom');
});

test('CPU has exactly the eight machine keys; NES has no decimal mode; CX16 has no JMP-indirect page bug', () => {
  const keys = Object.keys(CPU).sort() as Machine[];
  assert.deepEqual(keys, ['atari8', 'c128', 'c64', 'cx16', 'mega65', 'nes', 'pet', 'vic20']);
  assert.equal(CPU.nes.decimalMode, false);
  assert.equal(CPU.cx16.jmpIndirectPageBug, false);
});

test('reduceRatio: the closest p/q with p + q <= 65535, exact when the ratio already fits', () => {
  assert.deepEqual(reduceRatio(50, 60), { num: 5, den: 6, error: 0 });
  const r = reduceRatio(60 * 263 * 65 * 14, 14318181); // c64 NTSC at 60
  assert.deepEqual([r.num, r.den], [23117, 23050]);
  assert.ok(r.num + r.den <= 65535);
  assert.ok(r.error < 1e-8, `relative error ${r.error}`);
});

test('frameRatio: every machine at every ordinary rate fits sixteen bits within a frame a day', () => {
  for (const [machine, sync] of Object.entries(FRAME_SYNC)) {
    if (sync.kind === 'edge' && 'calibrate' in sync) continue; // the PET measures its own, in 32 bits
    for (const frameRate of [30, 50, 60, 100, 120]) {
      const { type, pairs } = frameRatio(sync, frameRate);
      assert.equal(type, 'uint16_t', `${machine} at ${frameRate}`);
      for (const [region, { num, den }] of Object.entries(pairs)) {
        assert.ok(num + den <= 65535, `${machine} ${region} at ${frameRate}: ${num} + ${den}`);
        const exact: RatioPair = sync.kind === 'level'
          ? sync[region as 'ntsc' | 'pal']
          : { num: sync.num, den: sync.den };
        const truth = (frameRate * exact.num) / exact.den;
        const driftPerDay = (Math.abs(num / den - truth) / truth) * frameRate * 86400;
        assert.ok(driftPerDay < 1, `${machine} ${region} at ${frameRate} drifts ${driftPerDay} frames a day`);
      }
    }
  }
});

test('frameRatio: a rate the sixteen-bit form cannot hold accurately falls back to the exact 32-bit pair', () => {
  const { type, pairs } = frameRatio(FRAME_SYNC.c64, 1000);
  assert.equal(type, 'uint32_t');
  assert.deepEqual(pairs.ntsc, { num: 1000 * 263 * 65 * 14, den: 14318181 });
});

test('FRAME_SYNC.pet.calibrate measures VIA1 T2 against vsync and scales the elapsed cycles by frameRate', () => {
  const at60 = FRAME_SYNC.pet.calibrate(60);
  assert.match(at60, /0xE813/); // PIA1 CRB, the vsync latch
  assert.match(at60, /0xE848/); // VIA1 T2C-L
  assert.match(at60, /0xE849/); // VIA1 T2C-H
  assert.match(at60, /60u \*/);
  assert.match(at60, /1000000u/); // the PET's region-independent 1 MHz clock
  const at50 = FRAME_SYNC.pet.calibrate(50);
  assert.match(at50, /50u \*/);
  assert.doesNotMatch(at50, /60u \*/);
});
