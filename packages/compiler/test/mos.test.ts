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
/** A stub that uses `name`, so empty-callee deletion and unused-param inlining cannot drop the call the fixture exists to measure. */
function stayAsCall(name: string) {
  return [{
    kind: 'memoryWrite',
    address: { kind: 'const', value: 0x8000, type: 'usmallint' },
    value: { kind: 'ref', name, type: 'utinyint' },
  }];
}

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

// A program that selects a character set, the way @8bitscript/pet/text's
// own prepare() does: one store of $0E to the VIA PCR at $E84C.
const selectsTextSetIr: IrProgram = {
  entry: 'main',
  functions: [{
    name: 'main',
    body: [{
      kind: 'memoryWrite',
      address: { kind: 'const', value: 0xe84c, type: 'usmallint' },
      value: { kind: 'const', value: 0x0e, type: 'utinyint' },
    }],
  }],
  globals: [],
};

test('build() leaves the character set where the program put it — no save, no restore, no bytes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const built = await build(selectsTextSetIr, { machine: 'pet', hardware, outFile: join(scratch, 'on.prg'), frameRate: 60 });
    assert.equal(built.ok, true);
    if (!built.ok) return;

    const code = [...built.bytes];
    const at = (needle: number[]) => code.findIndex((_, i) => needle.every((b, j) => code[i + j] === b));

    // The program's own store is there and is the only one: a build once
    // wrapped this in LDA $E84C / PHA ... PLA / STA $E84C so a 3032 would
    // return to the upper-case prompt it booted with. The bit is
    // retroactive, so writing the old value back re-rendered the text the
    // program had just drawn — the restore undid the reason for the
    // switch. A program now exits in the set it selected.
    assert.ok(at([0x8d, 0x4c, 0xe8]) >= 0, 'the program keeps its own store to $E84C');
    assert.equal(at([0xad, 0x4c, 0xe8, 0x48]), -1, 'nothing takes a copy of the register on the way in');
    assert.equal(at([0x68, 0x8d, 0x4c, 0xe8]), -1, 'and nothing writes one back on the way out');
    assert.equal(code.filter((b, i) => b === 0x8d && code[i + 1] === 0x4c && code[i + 2] === 0xe8).length, 1, 'exactly one store to the register: the program\'s');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() only returns a sizeReport when options.report asks for one, and it always sums to the real bytes.length', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const plain = await build(ir, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(plain.ok, true);
    if (!plain.ok) return;
    assert.equal(plain.sizeReport, undefined, 'no --size, no report — the CLI never asked for one');

    const reported = await build(ir, { machine: 'pet', hardware, outFile, frameRate: 60, report: true });
    assert.equal(reported.ok, true);
    if (!reported.ok) return;
    assert.ok(Array.isArray(reported.sizeReport) && reported.sizeReport.length > 0);
    const sum = reported.sizeReport.reduce((total, e) => total + e.bytes, 0);
    assert.equal(sum, reported.bytes.length, 'every named piece has to add up to the whole program, not just most of it');
    // Largest first — an empty main() still has a real biggest piece (the
    // BASIC stub), not a report in declaration or insertion order.
    for (let i = 1; i < reported.sizeReport.length; i++) {
      assert.ok(reported.sizeReport[i - 1].bytes >= reported.sizeReport[i].bytes, 'not sorted largest first');
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() for the PET lowers the eleven-store HELLO WORLD fixture to exactly sixty-eight bytes (milestone 4 acceptance test; 70 before 0.2.3 dropped the double-L reload)', async () => {
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
        0x8d, 0x03, 0x80, // STA $8003 · L — A still holds #12, so the reload folds away (0.2.3)
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
    assert.equal(result.bytes.length, 68);
    assert.deepEqual(result.memory, { variables: 0, program: 68 });
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
    assert.deepEqual(result.memory, { variables: 2, program: 45 }); // sum + i (locals) — `sum + i` reads i straight at the ADC, `i = i + 1` is an INC, and i's own `= 0` reuses the #0 still in A from sum's, so no temp is ever live; the extra program byte is the one-time CLD this program's own ADC earns it
    assert.equal(result.bytes.length, 45);
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
  // A different value per store, so the redundant-reload peephole (0.2.3)
  // can't fold any of the LDAs away and the body really stays past ±127.
  value: { kind: 'const', value: (i % 32) + 1, type: 'utinyint' },
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
    // 'if'/'while'/'for'/etc. gained rules at milestone 6, 'storeIndex' at
    // 0.2.2 — an invented kind stands in for whatever's genuinely next.
    const noRule: IrProgram = { entry: 'main', functions: [{ name: 'main', body: [{ kind: 'mystery' }] }], globals: [] };
    const result = await build(noRule, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /no instruction-selection rule yet for the 'mystery' statement/);
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
      functions: [{
        name: 'main',
        // main reads both — an unreferenced global is exactly what
        // linker/reachability.mjs now prunes, and a global this test's
        // own fixture declares but nothing ever touches isn't the real
        // currentColor/currentReverse shape it means to cover.
        body: [
          { kind: 'assign', target: 'currentColor', value: { kind: 'ref', name: 'currentColor', type: 'utinyint' } },
          { kind: 'assign', target: 'currentReverse', value: { kind: 'ref', name: 'currentReverse', type: 'bool' } },
        ],
      }],
      globals: [
        { name: 'currentColor', type: 'utinyint', address: null },
        { name: 'currentReverse', type: 'bool', address: null },
      ],
    };
    const result = await build(withGlobals, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // 15 program bytes as an empty main() would have, plus one shared
    // LDA #0 and an STA zp per global (both initialize to 0, and the
    // initializers group by value — 0.2.3) to write each global's own
    // initial value before main() runs — real RAM has no guaranteed
    // content at power-on (discovered building milestone 9's real gate:
    // @8bitscript/pet/text's own currentReverse read whatever boot-time
    // garbage happened to be at its address, on every build before this
    // test's own fixture existed to catch it) — plus 4 bytes each for
    // main's own read-back assign (LDA zp; STA zp), the reference this
    // fixture now needs to survive pruning at all.
    assert.equal(result.bytes.length, 29);
    assert.deepEqual(result.memory, { variables: 2, program: 29 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() refuses a PET program whose globals overflow the real zero-page budget, naming the variable', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    // $8E..$FF is 114 bytes; 115 one-byte globals cannot fit. main
    // references every one (an unreferenced global is exactly what
    // linker/reachability.mjs now prunes) — allocation itself runs before
    // any of main's own body lowers, so the overflow this test means to
    // check is unaffected either way, but the globals have to survive
    // pruning to be allocated at all.
    const tooManyGlobals: IrProgram = {
      entry: 'main',
      functions: [{
        name: 'main',
        body: Array.from({ length: 115 }, (_, i) => ({ kind: 'assign', target: `g${i}`, value: { kind: 'const', value: 0, type: 'utinyint' } })),
      }],
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
    // one shared body (LDA-param = 2 bytes — the return's jump to the very
    // next label folds away (0.2.3) — then RTS = 1 byte) — 2*10 + 3 = 23
    // bytes of code, plus the 12-byte BASIC stub, the 2-byte load address,
    // and main's own 1-byte epilogue RTS = 38. A backend that duplicated
    // identity's body per call site would cost 3 more bytes (a second
    // body) — this pins the smaller, correct number.
    assert.equal(result.bytes.length, 38);
    // Just 1 zp byte: identity's own parameter x. A call site stores its
    // argument straight into that fixed address (no temp of its own —
    // callSite() never touches the caller's LocalAllocator), and neither
    // main's body nor identity's own ever declares a local.
    assert.deepEqual(result.memory, { variables: 1, program: 38 });
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
        { name: 'place', params: [{ name: 'cell', type: 'usmallint' }], returnType: 'void', body: stayAsCall('cell') },
      ],
      globals: [],
    };
    const result = await build(wideParamIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.equal(result.bytes.length, 32);
    // 2 zp bytes: place's own 2-byte `cell` parameter, and nothing of
    // main's — a constant 16-bit argument stores its two immediate bytes
    // straight into the callee's param pair (store16Into, 0.2.3), no temp
    // pair in the caller's frame at all. The callee is a one-store stub
    // (so empty-callee deletion cannot drop the call).
    assert.deepEqual(result.memory, { variables: 2, program: 32 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a 16-bit return type gets its own zero-page pair, written by the callee and read back at the call site (0.2.2)', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const wideReturnIr: IrProgram = {
      entry: 'main',
      functions: [
        // main has to actually call address() AND consume its value:
        // build() prunes whatever the entry can't reach, and a bare call
        // statement never takes the 16-bit-value path this test is about.
        {
          name: 'main',
          params: [],
          returnType: 'void',
          body: [{
            kind: 'memoryWrite',
            address: { kind: 'call', name: 'address', args: [], type: 'usmallint' },
            value: { kind: 'const', value: 1, type: 'utinyint' },
          }],
        },
        { name: 'address', params: [], returnType: 'usmallint', body: [{ kind: 'return', value: { kind: 'const', value: 0x8000, type: 'usmallint' } }] },
      ],
      globals: [],
    };
    const result = await build(wideReturnIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
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
        // main has to actually call sumOf(): see the same note on the
        // 16-bit-return test above.
        { name: 'main', params: [], returnType: 'void', body: [{ kind: 'call', name: 'sumOf', args: [] }] },
        { name: 'sumOf', params: [{ name: 't', type: 'array', elementType: 'utinyint', length: 4 }], returnType: 'void', body: stayAsCall('t') },
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
        // main has to actually call f(): see the same note on the
        // 16-bit-return test above.
        { name: 'main', params: [], returnType: 'void', body: [{ kind: 'call', name: 'f', args: [] }] },
        { name: 'f', params: [{ name: 'n', type: 'int' }], returnType: 'void', body: stayAsCall('n') },
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
    // not enough for a usmallint parameter's own 2. main has to actually
    // reference every one of them (an unreferenced global is exactly what
    // linker/reachability.mjs now prunes) and actually call place(), or
    // build() would just drop all the filler this test exists to fill zp
    // with, and the overflow this test means to check would never happen.
    const almostFullIr: IrProgram = {
      entry: 'main',
      functions: [
        {
          name: 'main',
          params: [],
          returnType: 'void',
          body: [
            ...Array.from({ length: 113 }, (_, i) => ({ kind: 'assign', target: `g${i}`, value: { kind: 'const', value: 0, type: 'utinyint' } })),
            { kind: 'call', name: 'place', args: [{ kind: 'const', value: 0, type: 'usmallint' }] },
          ],
        },
        { name: 'place', params: [{ name: 'cell', type: 'usmallint' }], returnType: 'void', body: stayAsCall('cell') },
      ],
      globals: Array.from({ length: 113 }, (_, i) => ({ name: `g${i}`, type: 'utinyint', address: null })),
    };
    const result = await build(almostFullIr, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    // The frame layout (0.2.2, mos/zp/frames.ts) is what runs out now:
    // place's own frame — its 2-byte parameter (a constant argument no
    // longer needs a caller-side temp as of 0.2.3, so main's frame is
    // empty) — is the first thing that no longer fits in the 1 byte left.
    assert.match(result.error, /out of zero page: 'place's frame needs 2 byte\(s\)/);
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

test('milestone 7 gate: HELLO WORLD through a real putChar(cell, code), called eleven times from main — 256 bytes (302 before the 0.2.3 direct-CMP comparisons), matching the real xpet screenshot', async () => {
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
    assert.equal(result.bytes.length, 256);
    // putChar's own cell + code (2) and nothing else — its `cell == N`
    // comparisons CMP the constant directly (0.2.3), no temp — and main
    // declares no locals of its own.
    assert.deepEqual(result.memory, { variables: 2, program: 256 });
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

test('milestone 8 acceptance: place(cell: usmallint, code: utinyint) — a real 16-bit parameter, 16-bit addition, and a computed-address store through (zp),Y — 51 bytes (67 before 0.2.3\'s temp-free constants)', async () => {
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
        // The frame layout (mos/zp/frames.ts): main's frame is EMPTY —
        // a constant argument stores its immediate bytes straight into the
        // callee's param pair (store16Into, 0.2.3), no caller-side temp —
        // so place's frame starts at $8E: cell $8E/$8F, code $90, then
        // its own temporaries.
        // main: 999 ($03E7) straight into place's cell...
        0xa9, 0xe7, 0x85, 0x8e, // LDA #$E7 · STA $8E (cell lo)
        0xa9, 0x03, 0x85, 0x8f, // LDA #$03 · STA $8F (cell hi)
        // ...and code=8 into place's own param $90...
        0xa9, 0x08, 0x85, 0x90, // LDA #$08 · STA $90 (code)
        0x20, 0x1e, 0x04, // JSR $041E (place)
        0x60, // RTS — main's own epilogue, back to BASIC
        // place: $8000 + cell — the constant left side is two immediate
        // ADC operands (binop16's const shortcut, 0.2.3): no pair for the
        // literal at all, only the sum's own pair $91/$92.
        0x18, // CLC
        0xa5, 0x8e, 0x69, 0x00, 0x85, 0x91, // LDA $8E (cell lo) · ADC #$00 · STA $91 (pointer lo)
        0xa5, 0x8f, 0x69, 0x80, 0x85, 0x92, // LDA $8F (cell hi) · ADC #$80 · STA $92 (pointer hi)
        // ...then the store itself, through the pointer, Y forced to 0.
        0xa5, 0x90, // LDA $90 (code)
        0xa0, 0x00, // LDY #$00
        0x91, 0x91, // STA ($91),Y
        0x60, // RTS — place's own return
      ],
    );
    assert.equal(result.bytes.length, 51);
    // 5 zp bytes: place's frame alone (cell 2 + code 1 + the sum pair 2)
    // — main's frame is empty, so the two overlay trivially.
    assert.deepEqual(result.memory, { variables: 5, program: 51 });
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
test('a call widens an 8-bit literal argument into a 16-bit parameter — place(0, 65), two bytes under place(999, 8)', async () => {
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
    // Two bytes SMALLER than the acceptance test above: widening the
    // constant 0 lands as one LDA #0 serving both STAs of the param pair
    // (store16Into skips reloading an immediate its two bytes share),
    // where 999's two distinct bytes each need their own LDA.
    assert.deepEqual(result.memory, { variables: 5, program: 49 });
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
    // Two LDA #imm / STA abs pairs (10 bytes) plus the 15-byte stub. The
    // loop, string table, and place() fold away: a 2-character literal is
    // already-converted stores, smaller and faster than milestone 8's
    // single place() call.
    assert.equal(result.bytes.length, 25);
    assert.equal(result.memory.variables, 0);
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

test('milestone 10 acceptance: waitFrame() before the real HELLO WORLD body builds, links, and reserves exactly its own 8 bytes of zero page', async () => {
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
    assert.equal(result.memory.variables, 8);
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
    assert.equal(result.bytes.length, 68, 'unchanged from the milestone 4 gate — waitFrame() support cost this program nothing');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a waitFrame() program owns the machine and gets the whole $02-$FF budget — 113 globals plus pacing state fit with room to spare (0.2.2)', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    // Under the polite $8E-$FF budget these 113 one-byte globals left a
    // single byte — the old shape of this test. A waitFrame() program's
    // widened budget (PET_OWNED_ZP_BUDGET) holds them all AND the 8-byte
    // pacing state, which is exactly what let a real program (2048) build.
    const globals = Array.from({ length: 113 }, (_, i) => ({ name: `g${i}`, type: 'utinyint', address: null }));
    const body = [
      ...Array.from({ length: 113 }, (_, i) => ({ kind: 'assign', target: `g${i}`, value: { kind: 'const', value: 0, type: 'utinyint' } })),
      { kind: 'waitFrame' },
    ];
    const ir: IrProgram = { entry: 'main', functions: [{ name: 'main', body }], globals };
    const result = await build(ir, { machine: 'pet', hardware, outFile: join(scratch, 'out.prg'), frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('milestone 10: a build with waitFrame() overflowing even the owned budget is refused, not silently truncated', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    // The owned budget is $02-$FF — 254 bytes. 250 one-byte globals leave
    // 4, nowhere near the 8 the pacing state needs. main references every
    // one of them: an unreferenced global is exactly what
    // linker/reachability.mjs prunes, and this test needs them real.
    const globals = Array.from({ length: 250 }, (_, i) => ({ name: `g${i}`, type: 'utinyint', address: null }));
    const body = [
      ...Array.from({ length: 250 }, (_, i) => ({ kind: 'assign', target: `g${i}`, value: { kind: 'const', value: 0, type: 'utinyint' } })),
      { kind: 'waitFrame' },
    ];
    const ir: IrProgram = { entry: 'main', functions: [{ name: 'main', body }], globals };
    const result = await build(ir, { machine: 'pet', hardware, outFile: join(scratch, 'out.prg'), frameRate: 60 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /^waitFrame\(\) needs 8 bytes of zero page for its own pacing state but only 4 byte\(s\) remain$/);
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

test('the real hello-world selects the text set once per model that needs it, and never puts one back', async () => {
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'hello-world', 'src', 'main.8bs');
  const src = readFileSync(main, 'utf8');
  const bytesFor = async (profile: string) => {
    const resolved = resolveHardware(loadCatalog('pet'), { profile });
    assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
    const { ir, diagnostics } = link(src, main, { machine: 'pet', facts: resolved.hardware.facts });
    assert.deepEqual(diagnostics, []);
    assert.ok(ir, 'link() returned no diagnostics but also no ir');
    const hardware = resolved.hardware as unknown as BuildOptions['hardware'];
    const scratch = await mkdtemp(join(tmpdir(), '8bs-charset-'));
    try {
      const result = await build(ir as IrProgram, { machine: 'pet', hardware, outFile: join(scratch, 'out.prg'), frameRate: 60 });
      assert.equal(result.ok, true, result.ok ? '' : result.error);
      return result.ok ? [...result.bytes] : [];
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
  const count = (code: number[], needle: number[]) => code.filter((_, i) => needle.every((b, j) => code[i + j] === b)).length;
  const STA_PCR = [0x8d, 0x4c, 0xe8];
  const LDA_PCR = [0xad, 0x4c, 0xe8];

  // $0E is the text set, the only one holding both cases of the alphabet,
  // so printing `Hello World!` as written means selecting it — once, on
  // the models that boot in the other one.
  for (const profile of ['2001', '3032']) {
    const code = await bytesFor(profile);
    assert.equal(count(code, STA_PCR), 1, `${profile}: one store to $E84C`);
    assert.equal(count(code, [0xa9, 0x0e, ...STA_PCR]), 1, `${profile}: and it selects the text set`);
  }

  // The 8032's editor ROM powers on in the text set, so its guard folds
  // and the store never reaches the binary — asserted on the bytes rather
  // than the IR, since a dead store surviving into the image is exactly
  // what the fold is there to prevent.
  assert.equal(count(await bytesFor('8032'), STA_PCR), 0, '8032: nothing to select, so nothing is emitted');

  // And on no model does anything read the register back. This used to
  // save it on the way in and restore it on the way out; the bit is
  // retroactive, so the restore re-rendered `Hello World!` into
  // `|ELLO OORLD!` through the set it had just switched away from.
  for (const profile of ['2001', '3032', '8032']) {
    const code = await bytesFor(profile);
    assert.equal(count(code, LDA_PCR), 0, `${profile}: nothing takes a copy of the character set`);
    assert.equal(count(code, [0x68, ...STA_PCR]), 0, `${profile}: and nothing writes one back before returning`);
  }
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
  // 77/101 before linker/reachability.mjs: hello-world's own real zp cost
  // used to include every unreached helper @8bitscript/text and
  // @8bitscript/screen declare. After folding print of a literal into
  // stores, inlining PET blank (its color args are unused) and a zp-free
  // screen fill, what the program provably touches is nothing at all —
  // 8 until it stopped ending in a `while (true) waitFrame()` holding
  // loop, which was the only owner of zero page it had. Either way the
  // point of this test holds the same way: allocation from $8E never
  // reaches the hole at $C2 (that needs the 52nd byte), so the 2001 and
  // the 3032 allocate identically — the hole is there to skip, and this
  // program is small enough not to run into it. The skip logic itself —
  // given a program that actually does reach that far — is its own test,
  // right below.
  assert.equal(on3032, 0, 'a print-and-return hello-world owns no zero page at all');
  assert.equal(on2001, on3032, 'pruned hello-world never allocates as far as $C2 — nothing to skip');
});

test('--size still names inlined callees and splits wait-frame setup from the per-frame routine', async () => {
  // Deliberately its own source rather than the shipped hello-world: the
  // two buckets this test exists to tell apart only exist in a program
  // that calls waitFrame(), and an example is a sample program whose shape
  // is free to change (it stopped holding the machine in a loop in 0.4.2).
  // The path is still a real file in the examples package so the import
  // specifiers below resolve exactly the way they do for a real project.
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'hello-world', 'src', 'main.8bs');
  const src = `import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";

export function main(): void {
    screen.blank();
    text.print(0, "Hello World!");
    while (true) {
        waitFrame();
    }
}
`;
  const resolved = resolveHardware(loadCatalog('pet'), { profile: '3032' });
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  const { ir, diagnostics } = link(src, main, { machine: 'pet', facts: resolved.hardware.facts });
  assert.deepEqual(diagnostics, []);
  assert.ok(ir);
  const scratch = await mkdtemp(join(tmpdir(), '8bs-size-report-'));
  try {
    const result = await build(ir as IrProgram, {
      machine: 'pet',
      hardware: resolved.hardware as unknown as BuildOptions['hardware'],
      outFile: join(scratch, 'out.prg'),
      frameRate: 60,
      report: true,
    });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const names = result.sizeReport!.map((e) => e.name);
    assert.ok(names.includes('(wait-frame setup)'), names.join(', '));
    assert.ok(names.includes('(wait-frame routine)'), names.join(', '));
    assert.ok(names.includes('screen_blank'), names.join(', '));
    assert.ok(names.includes('text_print'), names.join(', '));
    assert.ok(names.includes('main'), names.join(', '));
    assert.equal(names.includes('(wait-frame setup + routine)'), false);
    assert.equal(result.sizeReport!.reduce((n, e) => n + e.bytes, 0), result.bytes.length);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('the BASIC 1 CHRGET hole ($C2-$D9) is still really skipped, once a program actually reaches that far', async () => {
  // Every filler global is read by main, so linker/reachability.mjs's own
  // pruning leaves all of them in place — see the same note on the
  // zero-page-overflow fixtures above. 60 one-byte globals reach from $8E
  // to $C9, past the hole's own start at $C2.
  const globals = Array.from({ length: 60 }, (_, i) => ({ name: `g${i}`, type: 'utinyint', address: null }));
  const body = Array.from({ length: 60 }, (_, i) => ({ kind: 'assign', target: `g${i}`, value: { kind: 'const', value: 0, type: 'utinyint' } }));
  const ir: IrProgram = { entry: 'main', functions: [{ name: 'main', body }], globals };
  const zpBytes = async (profile: string | undefined) => {
    const resolved = resolveHardware(loadCatalog('pet'), { profile });
    assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
    const scratch = await mkdtemp(join(tmpdir(), '8bs-chrget-hole-'));
    try {
      const result = await build(ir, { machine: 'pet', hardware: resolved.hardware as unknown as BuildOptions['hardware'], outFile: join(scratch, 'out.prg'), frameRate: 60 });
      assert.equal(result.ok, true, result.ok ? '' : result.error);
      return result.ok ? result.memory.variables : 0;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
  const on3032 = await zpBytes('3032');
  const on2001 = await zpBytes('2001');
  assert.equal(on3032, 60, 'BASIC 2 has no hole in this range — all 60 globals land back to back');
  assert.equal(on2001, on3032 + 24, 'BASIC 1\'s own CHRGET hole forces the 24-byte skip once allocation reaches $C2');
});

type IrExprFixture = IrProgram['functions'][number]['body'][number]['value'];

// ---- 0.2.2: mutable arrays ride in the program image, and `*` pays for
// its routine only when a runtime multiply survives the optimizer ------------

test('a `let` array lands in the data section — its init bytes in the image, zeros when it has none — and storeIndex writes through it (0.2.2)', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const arrays: IrProgram = {
      entry: 'main',
      functions: [{
        name: 'main',
        body: [
          { kind: 'storeIndex', array: { kind: 'ref', name: 'board' }, index: { kind: 'const', value: 2, type: 'utinyint' }, value: { kind: 'index', array: { kind: 'ref', name: 'seeded' }, index: { kind: 'const', value: 0, type: 'utinyint' }, elementType: 'utinyint', type: 'utinyint' }, elementType: 'utinyint' },
        ],
      }],
      globals: [
        { name: 'board', type: 'utinyint', address: null, array: 4, constant: false, init: null },
        { name: 'seeded', type: 'utinyint', address: null, array: 3, constant: false, init: [9, 8, 7] },
      ],
      strings: [],
    };
    const result = await build(arrays, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const bytes = [...result.bytes];
    // The data section is last: board's four zeros then seeded's 9,8,7 —
    // the load itself is the initializer, since a loaded .prg IS RAM.
    assert.deepEqual(bytes.slice(-7), [0, 0, 0, 0, 9, 8, 7]);
    // Neither array cost zero page: only code and data grew. A constant
    // index needs no temp either (0.2.3) — Y takes it directly.
    assert.equal(result.memory.variables, 0, 'no zero page at all');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('the multiply routine and its six zero-page cells appear only in a program that still multiplies at run time (0.2.2)', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const multiplies = (value: IrExprFixture): IrProgram => ({
      entry: 'main',
      functions: [{
        name: 'main',
        body: [
          { kind: 'local', name: 'x', type: 'utinyint', init: { kind: 'const', value: 3, type: 'utinyint' } },
          { kind: 'assign', target: 'x', value },
        ],
      }],
      globals: [],
      strings: [],
    });
    const runtime = await build(
      multiplies({ kind: 'binop', operator: '*', left: { kind: 'ref', name: 'x', type: 'utinyint' }, right: { kind: 'ref', name: 'x', type: 'utinyint' }, type: 'utinyint' }),
      { machine: 'pet', hardware, outFile: join(scratch, 'a.prg'), frameRate: 60 },
    );
    assert.equal(runtime.ok, true, runtime.ok ? '' : runtime.error);
    // A power-of-two constant multiplier strength-reduces to a shift in
    // the optimizer, so the routine never gets emitted for it.
    const reduced = await build(
      multiplies({ kind: 'binop', operator: '*', left: { kind: 'ref', name: 'x', type: 'utinyint' }, right: { kind: 'const', value: 4, type: 'utinyint' }, type: 'utinyint' }),
      { machine: 'pet', hardware, outFile: join(scratch, 'b.prg'), frameRate: 60 },
    );
    assert.equal(reduced.ok, true, reduced.ok ? '' : reduced.error);
    if (!runtime.ok || !reduced.ok) return;
    assert.ok(runtime.bytes.length > reduced.bytes.length + 30, `the routine's own bytes: ${runtime.bytes.length} vs ${reduced.bytes.length}`);
    assert.ok(runtime.memory.variables >= reduced.memory.variables + 6, 'the routine claims its six cells only when emitted');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
