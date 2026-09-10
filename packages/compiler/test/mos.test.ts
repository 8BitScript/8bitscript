import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  build, outputExtension, CPU, reduceRatio, frameRatio, FRAME_SYNC,
} from '../src/mos/index.ts';
import type { BuildOptions, IrProgram, Machine, RatioPair } from '../src/mos/index.ts';
import type { IrStatement } from '../src/mos/lower/index.ts';
import { link } from '../index.mjs';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';

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
    // 15 program bytes as an empty main() has, plus 4 bytes each
    // (LDA #init; STA zp) to write each global's own initial value before
    // main() runs — real RAM has no guaranteed content at power-on
    // (discovered building milestone 9's real gate: @8bitscript/pet/text's
    // own currentReverse read whatever boot-time garbage happened to be at
    // its address, on every build before this test's own fixture existed
    // to catch it). The zero-page address these globals get is unaffected;
    // only the program now actually sets what memory.variables always
    // implied it would.
    assert.equal(result.bytes.length, 23);
    assert.deepEqual(result.memory, { variables: 2, program: 23 });
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

// ---- milestone 7: functions and the calling convention ---------------
//
// See packages/compiler/src/mos/AGENTS.md for the design: every parameter
// and local gets a fixed zero-page slot the owning function never shares,
// assigned in two passes so a call site always knows its target's
// addresses regardless of lowering order. What lower/index.test.ts already
// proves in isolation (argument order, a void call as a statement, the
// defensive checks) isn't repeated here — these are the properties only a
// real, linkable, two-and-three-function program through build() can show.

/** `utinyint x -> return x;` — the smallest possible non-trivial function: one parameter read straight back out. */
function identityFn(name: string) {
  return {
    name,
    params: [{ name: 'x', type: 'utinyint' }],
    returnType: 'utinyint',
    body: [{ kind: 'return', value: { kind: 'ref', name: 'x', type: 'utinyint' } }],
  };
}

test('a function called from two sites gets one body, not two — byte count proves it, not just that it links', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const twoCallSitesIr: IrProgram = {
      entry: 'main',
      functions: [
        identityFn('identity'),
        {
          name: 'main',
          params: [],
          returnType: 'void',
          body: [
            { kind: 'memoryWrite', address: { kind: 'const', value: 0x8000, type: 'usmallint' }, value: { kind: 'call', name: 'identity', args: [{ kind: 'const', value: 65, type: 'utinyint' }], type: 'utinyint' } },
            { kind: 'memoryWrite', address: { kind: 'const', value: 0x8001, type: 'usmallint' }, value: { kind: 'call', name: 'identity', args: [{ kind: 'const', value: 66, type: 'utinyint' }], type: 'utinyint' } },
          ],
        },
      ],
      globals: [],
    };
    const result = await build(twoCallSitesIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    // Two call sites (LDA#/STA-param/JSR/STA-abs each, 7+3=10 bytes) plus
    // one shared body (LDA-param/JMP-exit = 5 bytes, then RTS = 1 byte) —
    // 2*10 + 6 = 26 bytes of code, plus the 12-byte BASIC stub, the 2-byte
    // load address, and main's own 1-byte epilogue RTS = 41. A backend
    // that duplicated identity's body per call site would cost 6 more
    // bytes (a second body) — this pins the smaller, correct number.
    assert.equal(result.bytes.length, 41);
    // Just 1 zp byte: identity's own parameter x. A call site stores its
    // argument straight into that fixed address (no temp of its own —
    // callSite() never touches the caller's LocalAllocator), and neither
    // main's body nor identity's own ever declares a local.
    assert.deepEqual(result.memory, { variables: 1, program: 41 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a function that calls a function: main -> outer -> inner, a real two-level JSR chain, addresses resolved regardless of declaration order', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    // outer is declared BEFORE inner, which it calls — proving the
    // parameter pass (mos/AGENTS.md) really does resolve every function's
    // address before any lowering runs, not just in declaration order.
    const chainIr: IrProgram = {
      entry: 'main',
      functions: [
        {
          name: 'outer',
          params: [{ name: 'x', type: 'utinyint' }],
          returnType: 'utinyint',
          body: [{
            kind: 'return',
            value: {
              kind: 'binop', operator: '+', type: 'utinyint',
              left: { kind: 'call', name: 'inner', args: [{ kind: 'ref', name: 'x', type: 'utinyint' }], type: 'utinyint' },
              right: { kind: 'const', value: 1, type: 'utinyint' },
            },
          }],
        },
        {
          name: 'inner',
          params: [{ name: 'y', type: 'utinyint' }],
          returnType: 'utinyint',
          body: [{
            kind: 'return',
            value: { kind: 'binop', operator: '+', type: 'utinyint', left: { kind: 'ref', name: 'y', type: 'utinyint' }, right: { kind: 'const', value: 1, type: 'utinyint' } },
          }],
        },
        {
          name: 'main',
          params: [],
          returnType: 'void',
          body: [{
            kind: 'memoryWrite',
            address: { kind: 'const', value: 0x8000, type: 'usmallint' },
            value: { kind: 'call', name: 'outer', args: [{ kind: 'const', value: 5, type: 'utinyint' }], type: 'utinyint' },
          }],
        },
      ],
      globals: [],
    };
    const result = await build(chainIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    // The point of this test is that it links at all: outer's own call to
    // inner references inner's FunctionSite (label + parameter address),
    // and inner is lowered *after* outer in ir.functions order — if the
    // parameter pass didn't run to completion before any lowering, this
    // would fail with an unresolved label instead of assembling clean.
    assert.equal(result.ok, true, result.ok ? '' : result.error);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a function that calls itself is refused, naming the cycle — not silently miscompiled', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const selfCallIr: IrProgram = {
      entry: 'main',
      functions: [
        { name: 'main', params: [], returnType: 'void', body: [{ kind: 'call', name: 'loopy', args: [] }] },
        { name: 'loopy', params: [], returnType: 'void', body: [{ kind: 'call', name: 'loopy', args: [] }] },
      ],
      globals: [],
    };
    const result = await build(selfCallIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /recursion isn't lowered yet/);
    assert.match(result.error, /loopy -> loopy/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('mutual recursion (a calls b, b calls a) is refused the same way direct self-recursion is', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const mutualIr: IrProgram = {
      entry: 'main',
      functions: [
        { name: 'main', params: [], returnType: 'void', body: [{ kind: 'call', name: 'a', args: [] }] },
        { name: 'a', params: [], returnType: 'void', body: [{ kind: 'call', name: 'b', args: [] }] },
        { name: 'b', params: [], returnType: 'void', body: [{ kind: 'call', name: 'a', args: [] }] },
      ],
      globals: [],
    };
    const result = await build(mutualIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /recursion isn't lowered yet/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a 16-bit parameter gets its own 2-byte zp slot (milestone 8) — a call site copies both bytes in', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const wideParamIr: IrProgram = {
      entry: 'main',
      functions: [
        { name: 'main', params: [], returnType: 'void', body: [{ kind: 'call', name: 'place', args: [{ kind: 'const', value: 999, type: 'usmallint' }] }] },
        { name: 'place', params: [{ name: 'cell', type: 'usmallint' }], returnType: 'void', body: [] },
      ],
      globals: [],
    };
    const result = await build(wideParamIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.equal(result.bytes.length, 35);
    // 4 zp bytes: place's own 2-byte `cell` parameter, plus 2 more that are
    // main's own — a call site's 16-bit argument evaluates into a fresh
    // temp pair (callSite in lower/index.ts) before being copied into the
    // callee's param address, and that temp counts against main's own
    // high-water mark even though it's released the moment the copy is
    // done. Unlike the 8-bit case (milestone 7's own two-call-sites test),
    // a 16-bit call site really does touch the caller's LocalAllocator.
    assert.deepEqual(result.memory, { variables: 4, program: 35 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a 16-bit return type is still refused by name — milestone 8 widens parameters, locals, and assignment, not return values', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const wideReturnIr: IrProgram = {
      entry: 'main',
      functions: [
        { name: 'main', params: [], returnType: 'void', body: [] },
        { name: 'address', params: [], returnType: 'usmallint', body: [{ kind: 'return', value: { kind: 'const', value: 0x8000, type: 'usmallint' } }] },
      ],
      globals: [],
    };
    const result = await build(wideReturnIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /'address' returns 'usmallint' \(2 bytes\)/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('an array parameter is refused by name — not lowered yet', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const arrayParamIr: IrProgram = {
      entry: 'main',
      functions: [
        { name: 'main', params: [], returnType: 'void', body: [] },
        { name: 'sumOf', params: [{ name: 't', type: 'array', elementType: 'utinyint', length: 4 }], returnType: 'void', body: [] },
      ],
      globals: [],
    };
    const result = await build(arrayParamIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /'sumOf\(t\)': array parameters aren't lowered yet/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a parameter wider than 16 bits is refused by name — only 8-bit and 16-bit parameters are lowered', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const wideParamIr: IrProgram = {
      entry: 'main',
      functions: [
        { name: 'main', params: [], returnType: 'void', body: [] },
        { name: 'f', params: [{ name: 'n', type: 'int' }], returnType: 'void', body: [] },
      ],
      globals: [],
    };
    const result = await build(wideParamIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /'f\(n\)' is 'int' \(4 bytes\): only 8-bit and 16-bit parameters are lowered yet/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a 16-bit parameter that only has one byte of zero page left is refused, naming both what is left and what is needed', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    // 113 one-byte globals leave exactly 1 byte of the 114-byte budget —
    // not enough for a usmallint parameter's own 2.
    const almostFullIr: IrProgram = {
      entry: 'main',
      functions: [
        { name: 'main', params: [], returnType: 'void', body: [] },
        { name: 'place', params: [{ name: 'cell', type: 'usmallint' }], returnType: 'void', body: [] },
      ],
      globals: Array.from({ length: 113 }, (_, i) => ({ name: `g${i}`, type: 'utinyint', address: null })),
    };
    const result = await build(almostFullIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /ran out of zero page assigning 'place\(cell\)' its parameter slot \(1 byte\(s\) left, 2 needed\)/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// Milestone 7's own gate: a hand-written putChar(cell, code), called once
// per character of HELLO WORLD from main() — real parameters, a real
// calling convention, JSR/RTS, argument order, all through the real
// pipeline. `cell` stays a utinyint compared against eleven literal
// addresses rather than computing $8000+cell at runtime — a computed
// memoryWrite address is milestone 8's own job (indexed stores), not this
// one's; that's also why this isn't the real @8bitscript/pet/text
// putChar(cell: usmallint, ...) — see mos/AGENTS.md and the roadmap's
// milestone 8 box for why that one still waits.
//
// Run for real: `8bs build --target pet --hardware model=2001` on this
// exact program (packages/compiler's own IR below, reconstructed as
// source) builds to 302 bytes; `8bs run pet --hardware model=2001
// --screenshot` on the harshest real PET (2001, 4K, "3071 BYTES FREE")
// shows HELLO WORLD on row 0, over the boot banner — the same signature
// milestone 4's own gate produced, now reached through eleven real
// function calls instead of eleven inline stores. Neither screenshot is
// committed (no earlier milestone's is either); this test locks in the
// byte count that screenshot was taken against.
function putCharIfChain() {
  return {
    name: 'putChar',
    params: [{ name: 'cell', type: 'utinyint' }, { name: 'code', type: 'utinyint' }],
    returnType: 'void',
    body: Array.from({ length: 11 }, (_, i) => ({
      kind: 'if',
      test: { kind: 'binop', operator: '==', type: 'bool', left: { kind: 'ref', name: 'cell', type: 'utinyint' }, right: { kind: 'const', value: i, type: 'utinyint' } },
      then: [{ kind: 'memoryWrite', address: { kind: 'const', value: 0x8000 + i, type: 'usmallint' }, value: { kind: 'ref', name: 'code', type: 'utinyint' } }],
      else: null,
    })),
  };
}

test('milestone 7 gate: HELLO WORLD through a real putChar(cell, code), called eleven times from main — 302 bytes, matching the real xpet screenshot', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const helloThroughPutCharIr: IrProgram = {
      entry: 'main',
      functions: [
        putCharIfChain(),
        {
          name: 'main',
          params: [],
          returnType: 'void',
          body: HELLO_WORLD_SCREEN_CODES.map((code, cell) => ({
            kind: 'call', name: 'putChar', args: [{ kind: 'const', value: cell, type: 'utinyint' }, { kind: 'const', value: code, type: 'utinyint' }],
          })),
        },
      ],
      globals: [],
    };
    const result = await build(helloThroughPutCharIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.equal(result.bytes.length, 302);
    // putChar's own cell + code (2), plus 1 temp its own `cell == N`
    // comparison needs (comparisonBranch's emitOperands) — main declares
    // no locals of its own.
    assert.deepEqual(result.memory, { variables: 3, program: 302 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ---- milestone 8: 16-bit values and a computed-address store -------------
//
// The real @8bitscript/pet/text package's own `place(cell: usmallint, code:
// utinyint) { memory.write(0x8000 + cell, toScreen(code)); }` — the exact
// function milestone 7's own AGENTS.md named as why that milestone's gate
// couldn't be the real putChar/place() (see mos/AGENTS.md's "still out of
// scope" list). `toScreen()` is left out here (an unrelated lookup, already
// coverable on its own — nothing about it is 16-bit) so this exercises just
// what milestone 8 adds: a 16-bit parameter, 16-bit addition, and a
// computed memoryWrite address, called with cell=999 — past the 8-bit
// boundary, so a backend that quietly truncated the index to one byte would
// write to the wrong page instead of failing outright.
function place16Fn() {
  return {
    name: 'place',
    params: [{ name: 'cell', type: 'usmallint' }, { name: 'code', type: 'utinyint' }],
    returnType: 'void',
    body: [{
      kind: 'memoryWrite',
      address: {
        kind: 'binop', operator: '+', type: 'usmallint',
        left: { kind: 'const', value: 0x8000, type: 'usmallint' },
        right: { kind: 'ref', name: 'cell', type: 'usmallint' },
      },
      value: { kind: 'ref', name: 'code', type: 'utinyint' },
    }],
  };
}

test('milestone 8 acceptance: place(cell: usmallint, code: utinyint) — a real 16-bit parameter, 16-bit addition, and a computed-address store through (zp),Y — 67 bytes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const placeIr: IrProgram = {
      entry: 'main',
      functions: [
        place16Fn(),
        {
          name: 'main',
          params: [],
          returnType: 'void',
          body: [{ kind: 'call', name: 'place', args: [{ kind: 'const', value: 999, type: 'usmallint' }, { kind: 'const', value: 8, type: 'utinyint' }] }],
        },
      ],
      globals: [],
    };
    const result = await build(placeIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.deepEqual(
      [...result.bytes],
      [
        0x01, 0x04, // load address $0401, little-endian
        0x0b, 0x04, 0x00, 0x00, 0x9e, 0x31, 0x30, 0x33, 0x37, 0x00, 0x00, 0x00, // the 12-byte BASIC stub: 0 SYS1037
        0xd8, // CLD — the combined program uses ADC, and decimalMode:true means the D flag isn't assumed clear on SYS entry
        // main: copy cell=999 ($03E7) into place's own param pair $8E/$8F...
        0xa9, 0xe7, 0x85, 0x95, // LDA #$E7 · STA $95 (temp lo)
        0xa9, 0x03, 0x85, 0x96, // LDA #$03 · STA $96 (temp hi)
        0xa5, 0x95, 0x85, 0x8e, // LDA $95  · STA $8E (cell lo)
        0xa5, 0x96, 0x85, 0x8f, // LDA $96  · STA $8F (cell hi)
        // ...and code=8 into place's own param $90...
        0xa9, 0x08, 0x85, 0x90, // LDA #$08 · STA $90 (code)
        0x20, 0x26, 0x04, // JSR $0426 (place)
        0x60, // RTS — main's own epilogue, back to BASIC
        // place: $8000 + cell, into a fresh zp pointer pair $91/$92...
        0xa9, 0x00, 0x85, 0x93, // LDA #$00 · STA $93 (0x8000's lo half, a temp)
        0xa9, 0x80, 0x85, 0x94, // LDA #$80 · STA $94 (0x8000's hi half, a temp)
        0x18, // CLC
        0xa5, 0x93, 0x65, 0x8e, 0x85, 0x91, // LDA $93 · ADC $8E (cell lo) · STA $91 (pointer lo)
        0xa5, 0x94, 0x65, 0x8f, 0x85, 0x92, // LDA $94 · ADC $8F (cell hi) · STA $92 (pointer hi)
        // ...then the store itself, through the pointer, Y forced to 0.
        0xa5, 0x90, // LDA $90 (code)
        0xa0, 0x00, // LDY #$00
        0x91, 0x91, // STA ($91),Y
        0x60, // RTS — place's own return
      ],
    );
    assert.equal(result.bytes.length, 67);
    // 9 zp bytes: place's own cell (2) + code (1); main's own 2-byte temp
    // for copying the 999 literal into cell (released after, but it's the
    // high-water mark that counts — see the milestone 8 parameter test
    // above); place's own pointer pair (2) and its own temp for the 0x8000
    // half of the addition (2).
    assert.deepEqual(result.memory, { variables: 9, program: 67 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// Discovered building the milestone 8 gate for real: `place(999, 8)` above
// builds fine because both literals already happen to be wide enough that
// narrowestIntegerType() picks usmallint/utinyint to match place's own
// declared parameter widths — but the front end never widens a narrower
// literal to match a *wider* declared parameter (verified against
// ir/index.mjs; see exprTo16's own comment in lower/index.ts), so the far
// more ordinary `place(0, 65)` — cell 0 is exactly the shape a real
// `text.putChar(0, ...)` call site would use — needed this test to catch
// it failing before exprTo16 existed. Confirmed live: `8bs run pet
// --hardware model=2001` on this exact program shows 'X' overwriting the
// 'O' in the boot banner's "COMMODORE", at cell 5 (a sibling scratch run
// with cell=5; not committed).
test('a call widens an 8-bit literal argument into a 16-bit parameter — place(0, 65), same byte count as place(999, 8)', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const placeIr: IrProgram = {
      entry: 'main',
      functions: [
        place16Fn(),
        {
          name: 'main',
          params: [],
          returnType: 'void',
          body: [{ kind: 'call', name: 'place', args: [{ kind: 'const', value: 0, type: 'utinyint' }, { kind: 'const', value: 65, type: 'utinyint' }] }],
        },
      ],
      globals: [],
    };
    const result = await build(placeIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    // Same shape and byte count as the acceptance test above: zero-extending
    // a literal costs the same two LDA/STA pairs a genuine 2-byte literal
    // does (LDA #0/STA lo, LDA #0/STA hi, vs. LDA lo/STA, LDA hi/STA).
    assert.deepEqual(result.memory, { variables: 9, program: 67 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ---- milestone 9: strings and const arrays --------------------------------
//
// The real @8bitscript/pet/text's own print(): a string parameter, its
// `.length`, indexing a byte out of it, and cell + i — a mixed-width 16-bit
// addition (milestone 9's own binop16 widening). place16Fn() (above) is the
// real place(); this reproduces print()'s loop around it, the same "byte
// for byte from the real source" discipline milestones 3/6/7/8 already
// hold to.
function printStringFn() {
  return {
    name: 'printString',
    params: [{ name: 'cell', type: 'usmallint' }, { name: 's', type: 'string' }],
    returnType: 'void',
    body: [{
      kind: 'for',
      init: { kind: 'local', name: 'i', type: 'utinyint', init: { kind: 'const', value: 0, type: 'utinyint' } },
      test: {
        kind: 'binop', operator: '<', type: 'bool',
        left: { kind: 'ref', name: 'i', type: 'utinyint' },
        right: { kind: 'stringLength', string: { kind: 'ref', name: 's', type: 'string' }, type: 'utinyint' },
      },
      update: {
        kind: 'assign', target: 'i',
        value: { kind: 'binop', operator: '+', type: 'utinyint', left: { kind: 'ref', name: 'i', type: 'utinyint' }, right: { kind: 'const', value: 1, type: 'utinyint' } },
      },
      body: [{
        kind: 'call', name: 'place',
        args: [
          { kind: 'binop', operator: '+', type: 'usmallint', left: { kind: 'ref', name: 'cell', type: 'usmallint' }, right: { kind: 'ref', name: 'i', type: 'utinyint' } },
          { kind: 'stringByte', string: { kind: 'ref', name: 's', type: 'string' }, index: { kind: 'ref', name: 'i', type: 'utinyint' }, type: 'utinyint' },
        ],
      }],
    }],
  };
}

function printTwoCharsIr(second: number): IrProgram {
  return {
    entry: 'main',
    functions: [
      place16Fn(),
      printStringFn(),
      {
        name: 'main',
        params: [],
        returnType: 'void',
        body: [{ kind: 'call', name: 'printString', args: [{ kind: 'const', value: 0, type: 'usmallint' }, { kind: 'string', index: 0, type: 'string' }] }],
      },
    ],
    globals: [],
    strings: [{ text: `H${String.fromCharCode(second)}`, bytes: [72, second] }],
  };
}

test('milestone 9 acceptance: printString(cell, s) — a real string parameter, s.length, s[i], and cell + i (mixed-width 16-bit addition) — builds and links', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const result = await build(printTwoCharsIr(73 /* 'I' */), { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.ok(result.bytes.length > 67, 'a real loop, a string table, and a second function cost more than milestone 8\'s single-call place() gate');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// The differential proof milestones 8/9's own "811 vs 555" and "cell 999"
// gates already trust more than any mnemonic-sequence assertion: the *only*
// source difference between two builds is one byte of one string literal
// ('I' vs 'J', ir.strings[0].bytes[1]), so the two .prg files should differ
// in exactly one byte — the one place.ts and mos/data.ts actually wrote
// that character — not in their length, their code, or anywhere else the
// string's own address might have shifted a label.
test('milestone 9 differential: changing one character of the string literal changes exactly one byte of the built .prg, and nothing else', async () => {
  const scratchA = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  const scratchB = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const resultI = await build(printTwoCharsIr(73 /* 'I' */), { machine: 'pet', hardware, outFile: join(scratchA, 'out.prg'), frameRate: 60 });
    const resultJ = await build(printTwoCharsIr(74 /* 'J' */), { machine: 'pet', hardware, outFile: join(scratchB, 'out.prg'), frameRate: 60 });
    assert.equal(resultI.ok, true, resultI.ok ? '' : resultI.error);
    assert.equal(resultJ.ok, true, resultJ.ok ? '' : resultJ.error);
    if (!resultI.ok || !resultJ.ok) return;
    assert.equal(resultI.bytes.length, resultJ.bytes.length, 'same program shape, same length — only one byte of data changed');
    const diffs: number[] = [];
    for (let i = 0; i < resultI.bytes.length; i += 1) {
      if (resultI.bytes[i] !== resultJ.bytes[i]) diffs.push(i);
    }
    assert.deepEqual(diffs.length, 1, `expected exactly one differing byte, found ${diffs.length} at offsets ${diffs.join(', ')}`);
    assert.equal(resultI.bytes[diffs[0]], 73);
    assert.equal(resultJ.bytes[diffs[0]], 74);
  } finally {
    await rm(scratchA, { recursive: true, force: true });
    await rm(scratchB, { recursive: true, force: true });
  }
});

// ---- milestone 10: waitFrame() ---------------------------------------
//
// The real gate: packages/examples/hello-world/src/main.8bs now calls
// waitFrame() before text.print(0, "HELLO WORLD") — built and run for real
// (`8bs run pet --screenshot`, both the 2001 and 8032 profiles, milestone
// 9's own established practice for a second, differently-clocked model) and
// screenshotted; both show "HELLO WORLD" printing exactly as it did before
// this milestone, proving the one-time calibration (SEI, the VIA1 Timer 2
// measurement, the frameRate multiply) and one blocking wait-and-return
// neither hang nor corrupt anything on either of the PET's two real
// vertical-retrace rates (VICE's ~60.1Hz on the no-CRTC 2001, 50Hz on the
// CRTC-driven 8032). This fixture reproduces that exact program shape —
// helloWorldIr's own eleven-store body (above) with one waitFrame() call
// prepended — the same "byte for byte from the real source" discipline
// every earlier milestone's own gate already holds to.
const waitFrameHelloIr: IrProgram = {
  entry: 'main',
  functions: [{ name: 'main', body: [{ kind: 'waitFrame' }, ...helloWorldIr.functions[0].body] }],
  globals: [],
};

test('milestone 10 acceptance: waitFrame() before the real HELLO WORLD body builds, links, and reserves exactly its own 12 bytes of zero page', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const result = await build(waitFrameHelloIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    // No globals and no parameters/locals anywhere in this program — the
    // only zero page spent is waitFrame()'s own pacing state (mos/startup/
    // waitframe.ts's WAIT_FRAME_ZP_BYTES), so this number is exact, not a
    // lower bound.
    assert.equal(result.memory.variables, 12);
    assert.deepEqual([...await readFile(outFile)], [...result.bytes]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// A program that never calls waitFrame() pays nothing for it: no zero page
// reserved, no calibration code, no shared subroutine appended — proven by
// diffing against the exact same eleven-store fixture with the call
// removed, the same differential discipline as milestone 9's own "811 vs
// 555" and "I vs J" gates.
test('milestone 10: a program with no waitFrame() call anywhere pays nothing for it — same bytes as the plain HELLO WORLD fixture', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const result = await build(helloWorldIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.equal(result.memory.variables, 0, 'no waitFrame() anywhere — no zero page reserved for its pacing state');
    assert.equal(result.bytes.length, 70, 'unchanged from the milestone 4 gate — waitFrame() support cost this program nothing');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 10: a build with waitFrame() overflowing what zero page remains is refused, not silently truncated', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    // 113 one-byte globals leave exactly 1 byte of the PET's real free zp
    // range ($8E..$FF, 114 bytes) — nowhere near the 12 waitFrame() needs.
    const globals = Array.from({ length: 113 }, (_, i) => ({ name: `g${i}`, type: 'utinyint', address: null }));
    const ir: IrProgram = { entry: 'main', functions: [{ name: 'main', body: [{ kind: 'waitFrame' }] }], globals };
    const result = await build(ir, { machine: 'pet', hardware, outFile: join(scratch, 'out.prg'), frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /^waitFrame\(\) needs 12 bytes of zero page for its own pacing state but only 1 byte\(s\) remain$/);
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
  // FrameSync is a union (LevelSync | EdgeSyncFixed | EdgeSyncCalibrated);
  // the PET is the one machine that measures its own ratio rather than
  // using a fixed one, so `calibrate` only exists on its branch — the `in`
  // check is what narrows FRAME_SYNC.pet down to it for TypeScript.
  const pet = FRAME_SYNC.pet;
  assert.ok('calibrate' in pet, 'the PET has no fixed num/den ratio — it measures its own');
  if (!('calibrate' in pet)) return;
  const at60 = pet.calibrate(60);
  assert.match(at60, /0xE813/); // PIA1 CRB, the vsync latch
  assert.match(at60, /0xE848/); // VIA1 T2C-L
  assert.match(at60, /0xE849/); // VIA1 T2C-H
  assert.match(at60, /60u \*/);
  assert.match(at60, /1000000u/); // the PET's region-independent 1 MHz clock
  const at50 = pet.calibrate(50);
  assert.match(at50, /50u \*/);
  assert.doesNotMatch(at50, /60u \*/);
});

test('the real hello-world on the 2001 leaves BASIC 1 CHRGET ($C2-$D9) alone so SYS can return', async () => {
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'hello-world', 'src', 'main.8bs');
  const src = readFileSync(main, 'utf8');
  const zpBytes = async (profile: string | undefined) => {
    const resolved = resolveHardware(loadCatalog('pet'), { profile });
    assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
    // link()'s own return type is the loose `object | null` every caller
    // gets (packages/compiler/src/linker/index.mjs's own JSDoc — nothing
    // here narrows it further); an empty `diagnostics` is the real
    // guarantee that `ir` is both non-null and a real IrProgram, the same
    // way every other fixture in this file already types its own `ir`
    // literal as one.
    const { ir, diagnostics } = link(src, main, { machine: 'pet', facts: resolved.hardware.facts });
    assert.deepEqual(diagnostics, []);
    assert.ok(ir, 'link() returned no diagnostics but also no ir');
    const linkedIr = ir as IrProgram;
    // resolveHardware()'s own JSDoc types build.defsym loosely (`object`,
    // packages/cli/src/hardware.mjs's own Hardware typedef) — every real
    // catalog defsym is a linker symbol's numeric value (see mos/index.ts's
    // own `options.hardware.build.defsym.__ram_size` read), the same
    // guarantee this cast states explicitly rather than widening
    // BuildOptions itself to match a JSDoc type that undersells its own
    // real shape.
    const hardware = resolved.hardware as unknown as BuildOptions['hardware'];
    const scratch = await mkdtemp(join(tmpdir(), '8bs-chrget-'));
    try {
      const result = await build(linkedIr, { machine: 'pet', hardware, outFile: join(scratch, 'out.prg'), frameRate: 60 });
      assert.equal(result.ok, true, result.ok ? '' : result.error);
      return result.ok ? result.memory.variables : 0;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
  const on3032 = await zpBytes('3032');
  const on2001 = await zpBytes('2001');
  assert.equal(on3032, 77, 'BASIC 2 CHRGET is below $8E — no hole, 77 bytes of real slots');
  assert.equal(on2001, on3032 + 24, 'the 2001 skips BASIC 1\'s 24-byte CHRGET window at $C2');
});
