// The 6502 backend's tests: the generated C as a deterministic string always,
// and a real compile to .prg when LLVM-MOS is installed (skipped, not failed,
// when it is not — CI without the SDK still runs the emitter tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tokenize, parse, lower } from '@8bitscript/compiler';
import {
  emitC, buildPrg, outputExtension, reduceRatio, frameRatio, FRAME_SYNC, DRIVER,
} from '../src/index.mjs';

const irOf = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't').ir;
};

// A program that uses waitFrame(): the shape every frame-paced program has,
// and what makes the backend emit its frame-sync runtime and prologue.
const frameIr = () => irOf('export function main(): void { while (true) { waitFrame(); } }');

test('emits plain C for the milestone program', () => {
  const c = emitC(irOf('let x: u8 = 10;\nexport function main(): void { x = x + 1; }'));
  // A variable names its section and takes its starting value in main():
  // no .data/.bss for the SDK's start-up code to copy or zero.
  assert.match(c, /uint8_t x __attribute__\(\(section\("\.zp\.noinit\.x"\)\)\);/);
  // The entry is an ordinary static function; C's own main calls it once.
  assert.match(c, /static void __8bs_main\(void\) \{/);
  assert.match(c, /int main\(void\) \{\n    x = 10;\n    __8bs_main\(\);\n    return 0;\n\}/);
  assert.match(c, /x = \(x \+ 1\);/);
});

test('a program that never calls waitFrame() carries none of the frame-sync runtime', () => {
  const c = emitC(irOf('let x: u8 = 10;\nexport function main(): void { x = x + 1; }'), { machine: 'vic20' });
  assert.doesNotMatch(c, /__8bs_wait_frame|__8bs_acc|__8bs_num|0x9004/);
});

test('the entry may have any name; a user function named main is renamed off C\'s', () => {
  const c = emitC(irOf('export function start(): void { }'));
  assert.match(c, /static void start\(void\);/);
  assert.match(c, /int main\(void\) \{\n    start\(\);/);
});

test('every user function is static, except one an asm6502 block names', () => {
  const c = emitC(irOf(
    'function helper(): void { }\nfunction other(): void { asm6502 { jsr helper } }\n'
    + 'export function main(): void { other(); }',
  ));
  assert.match(c, /^void helper\(void\);/m);
  assert.match(c, /^static void other\(void\);/m);
});

test('a string literal is a static const length-prefixed table; a string parameter is a const uint8_t pointer', () => {
  const c = emitC(irOf('let n: utinyint = 0;\nfunction show(s: string): void { n = s.length; n = s[n]; }\nexport function main(): void { show("TICK"); }'));
  assert.match(c, /static const uint8_t __8bs_str_0\[\] __attribute__\(\(section\("\.rodata\.__8bs_str_0"\)\)\) = \{ 4, 84, 73, 67, 75 \}; \/\* "TICK" \*\//);
  assert.match(c, /static void show\(const uint8_t \* s\)/);
  assert.match(c, /n = s\[0\];/);
  assert.match(c, /n = s\[1 \+ n\];/);
  assert.match(c, /show\(__8bs_str_0\);/);
});

test('@address becomes a volatile pointer #define', () => {
  const c = emitC(irOf('@address(0x900F)\nlet vicColor: volatile<u8>;'));
  assert.match(c, /#define vicColor \(\*\(volatile uint8_t \*\)0x900F\)/);
});

test('calls emit with prototypes ahead of every definition', () => {
  // The linker puts the entry's functions first, so main may call a function
  // defined below it; without the prototype block the C would not compile.
  const c = emitC(irOf('export function main(): void { apply(); }\nfunction apply(): void { return; }'));
  assert.match(c, /void apply\(void\);/);
  assert.match(c, /apply\(\);/);
  assert.ok(c.indexOf('void apply(void);') < c.indexOf('__8bs_main(void) {'));
});

test('asm6502 bodies pass through verbatim', () => {
  const c = emitC(irOf('export function f(): void { asm6502 { lda #$06\n sta $900f } }'));
  assert.match(c, /__asm__ volatile\(/);
  assert.match(c, /lda #\$06/);
});

test('IR with unresolved imports is refused, not dropped', async () => {
  const result = await buildPrg(
    irOf('import { limit } from "./lib.8bs";'),
    { machine: 'vic20', outFile: 'unused.prg' },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /unresolved imports/);
});

const HAS_SDK = process.env.LLVM_MOS_HOME
  && existsSync(join(process.env.LLVM_MOS_HOME, 'bin', 'mos-vic20-clang'));

test('the milestone program compiles to a real .prg', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-test-'));
  try {
    const outFile = join(scratch, 'm.prg');
    const result = await buildPrg(
      irOf('let x: u8 = 10;\nexport function main(): void { x = x + 1; }'),
      { machine: 'vic20', outFile },
    );
    assert.ok(result.ok, result.error);
    const prg = await readFile(outFile);
    // The first two bytes of a .prg are its load address: $1001, the BASIC
    // start of the unexpanded VIC-20 — the machine 8BitScript targets first.
    assert.equal(prg[0], 0x01);
    assert.equal(prg[1], 0x10);
    // The whole program has to fit the unexpanded machine's 3583 bytes.
    assert.ok(prg.length <= 3583, `prg is ${prg.length} bytes`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('emitC: the Commodore-KERNAL machines carry the char-conv guard; the others do not', () => {
  for (const machine of ['vic20', 'c64', 'pet', 'c128', 'mega65']) {
    const c = emitC(frameIr(), { machine });
    assert.match(c, /int __from_ascii\(char c, void \*ctx, int \(\*write\)\(char c, void \*ctx\)\) \{ return write\(c, ctx\); \}/, machine);
    assert.match(c, /int __to_ascii\(void \*ctx, int \(\*read\)\(void \*ctx\)\) \{ return read\(ctx\); \}/, machine);
  }
  for (const machine of ['nes', 'atari8', 'cx16']) {
    assert.doesNotMatch(emitC(frameIr(), { machine }), /__to_ascii|__from_ascii/, machine);
  }
});

test('buildPrg: a Commodore build makes no KERNAL CHROUT call before main() — the SDK\'s PETSCII 14 switch is gone', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-test-'));
  try {
    for (const machine of ['pet', 'c64']) {
      const outFile = join(scratch, `${machine}.prg`);
      const result = await buildPrg(frameIr(), { machine, outFile });
      assert.ok(result.ok, result.error);
      const objdump = join(process.env.LLVM_MOS_HOME, 'bin', 'llvm-objdump');
      const listing = await new Promise((resolvePromise, rejectPromise) => {
        execFile(objdump, ['-d', `${outFile}.elf`], (error, stdout) => (error ? rejectPromise(error) : resolvePromise(stdout)));
      });
      // $FFD2 is CHROUT on every Commodore KERNAL; the SDK's `shift:`
      // routine was `lda #$0e / jsr $ffd2` at the very start of _start.
      assert.doesNotMatch(listing, /jsr\s+\$ffd2/i, `${machine} still calls CHROUT before main()`);
      assert.doesNotMatch(listing, /__to_ascii|__from_ascii/, `${machine} kept the guard's own bodies`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ---- Phase 2-4 targets: PET, C128, Atari 8-bit, NES, Commander X16, MEGA65

test('outputExtension: prg everywhere except NES (.nes) and Atari 8-bit (.xex, or .rom for xegs)', () => {
  assert.equal(outputExtension('vic20'), 'prg');
  assert.equal(outputExtension('c64'), 'prg');
  assert.equal(outputExtension('pet'), 'prg');
  assert.equal(outputExtension('c128'), 'prg');
  assert.equal(outputExtension('mega65'), 'prg');
  assert.equal(outputExtension('cx16'), 'prg');
  assert.equal(outputExtension('nes'), 'nes');
  assert.equal(outputExtension('atari8', { build: { defsym: {} } }), 'xex');
  assert.equal(outputExtension('atari8', { build: { driver: 'mos-atari8-cart-xegs-clang', output: 'rom' } }), 'rom');
});

test('emitC: level machines (c128, mega65, atari8) reuse a raster/VCOUNT poll, no acknowledgement', () => {
  for (const machine of ['c128', 'mega65']) {
    const c = emitC(frameIr(), { machine });
    // Same registers as c64 — see the FRAME_SYNC comment for why.
    assert.match(c, /0xD012/);
    assert.match(c, /0xD011/);
  }
  const atari = emitC(frameIr(), { machine: 'atari8' });
  assert.match(atari, /0xD40B/); // ANTIC VCOUNT
});

test('emitC: pet calibrates its frame period at runtime via VIA1 T2, under SEI', () => {
  const c = emitC(frameIr(), { machine: 'pet' });
  assert.match(c, /"sei"/); // presync: owns the CB1 flag instead of racing the KERNAL for it
  assert.match(c, /0xE813/); // PIA1 CRB — the vertical-retrace flag
  assert.match(c, /0xE812/); // PIA1 ORB — reading it acknowledges the flag
  assert.match(c, /0xE848/); // VIA1 T2C-L
  assert.match(c, /0xE849/); // VIA1 T2C-H — starts the timer
  assert.match(c, /__8bs_num = 60u \* \(uint32_t\)__8bs_elapsed;/);
});

test('emitC: nes polls PPUSTATUS, which self-acknowledges on read', () => {
  const c = emitC(frameIr(), { machine: 'nes' });
  assert.match(c, /0x2002/);
  // A fixed, documented ratio is a pair of #defines, not two variables in
  // RAM — reduced to sixteen bits: 60 * 59601 / 3579546 is 6155/6161 to
  // within 1e-9.
  assert.match(c, /#define __8bs_num 6155u/);
  assert.match(c, /#define __8bs_den 6161u/);
  assert.match(c, /static uint16_t __8bs_acc __attribute__\(\(section\("\.zp\.noinit\.__8bs_acc"\)\)\);/);
});

test('emitC: a machine\'s frame hook is called after every hardware frame edge, only when the program defines it', () => {
  const plain = emitC(frameIr(), { machine: 'nes' });
  assert.doesNotMatch(plain, /nesVerticalBlank/);
  const hooked = emitC(irOf('function nesVerticalBlank(): void { }\nexport function main(): void { while (true) { waitFrame(); nesVerticalBlank(); } }'), { machine: 'nes' });
  // Declared before the runtime (which is emitted first), defined with the program's functions.
  assert.match(hooked, /static void nesVerticalBlank\(void\);\n(#define[^\n]*\n)+static uint16_t __8bs_acc/);
  assert.match(hooked, /while \(!\(\(\*\(volatile uint8_t \*\)0x2002\) & 0x80\)\) \{\}\n\s+nesVerticalBlank\(\);\n\s+__8bs_acc \+= __8bs_num;/);
  // Not on a machine that has no hook.
  const c64 = emitC(irOf('function nesVerticalBlank(): void { }\nexport function main(): void { while (true) { waitFrame(); nesVerticalBlank(); } }'), { machine: 'c64' });
  assert.doesNotMatch(c64, /nesVerticalBlank\(\);\n\s+__8bs_acc/);
});

test('emitC: cx16 polls VERA ISR and acknowledges by writing the bit back', () => {
  const c = emitC(frameIr(), { machine: 'cx16' });
  assert.match(c, /0x9F27/);
  assert.match(c, /"sei"/);
  // cx16 has no documented crystal split, so its FRAME_SYNC entry is the
  // degenerate { num: 1, den: 60 }: real hardware fires at a fixed ~60Hz, so
  // at the default frameRate the ratio is exactly 1:1 and folds away —
  // waitFrame() is one poll, with no accumulator at all.
  assert.doesNotMatch(c, /__8bs_acc|__8bs_num|__8bs_den/);
  assert.match(c, /static void __8bs_wait_frame\(void\) \{\n    while \(!\(\(\*\(volatile uint8_t \*\)0x9F27\) & 0x01\)\) \{\}\n/);
});

test('emitC: the frame-sync runtime is the accumulator read from the waiting side', () => {
  const c = emitC(frameIr(), { machine: 'vic20' });
  assert.match(c, /static uint16_t __8bs_num __attribute__\(\(section\("\.zp\.noinit\.__8bs_num"\)\)\);/);
  assert.match(c, /static uint16_t __8bs_den __attribute__\(\(section\("\.zp\.noinit\.__8bs_den"\)\)\);/);
  assert.match(c, /while \(__8bs_acc < __8bs_den\) \{/);
  assert.match(c, /__8bs_acc \+= __8bs_num;/);
  assert.match(c, /__8bs_acc -= __8bs_den;/);
  // The prologue runs in C's main before the entry: zero the accumulator,
  // sync, pick region, call.
  assert.match(c, /int main\(void\) \{\n    __8bs_acc = 0;\n    while \(\(\*\(volatile uint8_t \*\)0x9004\) < 64\) \{\}/);
  assert.match(c, /__8bs_main\(\);\n    return 0;/);
  // And the loop body calls the runtime, not a hidden driver.
  assert.match(c, /while \(1\) \{\n        __8bs_wait_frame\(\);/);
});

test('emitC: an unknown machine refuses rather than guessing', () => {
  assert.throws(() => emitC(frameIr(), { machine: 'commodore-64x' }), /unknown machine|needs a known machine/);
});

// ---- frameRate: the same accumulator scheme, at a configured logical rate
// (8bs.config.ts's `frameRate`, default 60) instead of a hardcoded 60. These
// exercise a 'level' machine, an 'edge'-fixed machine (nes), an
// 'edge'-calibrated machine (pet), and cx16's degenerate case, at 50 —
// checking every FRAME_SYNC 'kind' scales uniformly, not just the default.

test('emitC: frameRate scales a level machine\'s num, not its den', () => {
  const c = emitC(frameIr(), { machine: 'vic20', frameRate: 50 });
  // vic20 ntsc: { num: 261 * 65 * 14, den: 14318181 } -> 11875500/14318181,
  // in sixteen bits 24566/29619
  assert.match(c, /__8bs_num = 24566u;/);
  assert.match(c, /__8bs_den = 29619u;/);
  // vic20 pal: { num: 312 * 71 * 4, den: 4433618 } -> 4430400/4433618 -> 5507/5511
  assert.match(c, /__8bs_num = 5507u;/);
  assert.match(c, /__8bs_den = 5511u;/);
});

test('emitC: frameRate scales an edge-fixed machine (nes)', () => {
  const c = emitC(frameIr(), { machine: 'nes', frameRate: 50 });
  // nes: { num: 59601, den: 2 * 1789773 } -> 2980050/3579546 -> 18636/22385
  assert.match(c, /#define __8bs_num 18636u/);
  assert.match(c, /#define __8bs_den 22385u/);
});

test('emitC: frameRate is substituted into an edge-calibrated machine\'s (pet) runtime measurement', () => {
  const c = emitC(frameIr(), { machine: 'pet', frameRate: 50 });
  assert.match(c, /__8bs_num = 50u \* \(uint32_t\)__8bs_elapsed;/);
});

test('emitC: frameRate scales cx16\'s degenerate 1/60 ratio (no longer 1:1, so the accumulator is back)', () => {
  const c = emitC(frameIr(), { machine: 'cx16', frameRate: 50 });
  assert.match(c, /#define __8bs_num 5u/);
  assert.match(c, /#define __8bs_den 6u/);
  assert.match(c, /static uint16_t __8bs_acc/);
});

// ---- the sixteen-bit ratio -----------------------------------------------------

test('reduceRatio: the closest p/q with p + q <= 65535, exact when the ratio already fits', () => {
  assert.deepEqual(reduceRatio(50, 60), { num: 5, den: 6, error: 0 });
  const r = reduceRatio(60 * 263 * 65 * 14, 14318181); // c64 NTSC at 60
  assert.deepEqual([r.num, r.den], [23117, 23050]);
  assert.ok(r.num + r.den <= 65535);
  assert.ok(r.error < 1e-8, `relative error ${r.error}`);
});

test('frameRatio: every machine at every ordinary rate fits sixteen bits within a frame a day', () => {
  for (const [machine, sync] of Object.entries(FRAME_SYNC)) {
    if (sync.calibrate) continue; // the PET measures its own, in 32 bits
    for (const frameRate of [30, 50, 60, 100, 120]) {
      const { type, pairs } = frameRatio(sync, frameRate);
      assert.equal(type, 'uint16_t', `${machine} at ${frameRate}`);
      for (const [region, { num, den }] of Object.entries(pairs)) {
        assert.ok(num + den <= 65535, `${machine} ${region} at ${frameRate}: ${num} + ${den}`);
        const exact = sync.kind === 'level' ? sync[region] : sync;
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
  const c = emitC(frameIr(), { machine: 'c64', frameRate: 1000 });
  assert.match(c, /static uint32_t __8bs_num/);
  assert.match(c, /__8bs_num = 239330000u;/);
});

// ---- where every byte lives ------------------------------------------------------

test('emitC: const arrays and strings are .rodata; let arrays with values load in place; the rest is noinit set by main()', () => {
  const src = 'const T: array<utinyint, 3> = [1, 2, 3];\nlet v: array<utinyint, 3> = [4, 5, 6];\nlet z: array<usmallint, 300>;\nlet n: usmallint = 7;\n'
    + 'export function main(): void { n = T[0] + v[1] + z[2]; }';
  const c = emitC(irOf(src), { machine: 'c64' });
  assert.match(c, /static const uint8_t T\[3\] __attribute__\(\(section\("\.rodata\.T"\)\)\) = \{ 1, 2, 3 \};/);
  assert.match(c, /uint8_t v\[3\] __attribute__\(\(section\("\.data\.v"\)\)\) = \{ 4, 5, 6 \};/);
  assert.match(c, /uint16_t z\[300\] __attribute__\(\(section\("\.noinit\.z"\)\)\);/);
  assert.match(c, /uint16_t n __attribute__\(\(section\("\.zp\.noinit\.n"\)\)\);/);
  // main() zeroes the array with a counter wide enough for its length, and stores the scalar.
  assert.match(c, /int main\(void\) \{\n    for \(uint16_t i = 0; i < 300; i\+\+\) z\[i\] = 0;\n    n = 7;\n/);
  assert.doesNotMatch(c, /__8bs_init_v/);
});

test('emitC: on a cartridge (nes) an initialised let array is copied from a .rodata twin by main()', () => {
  const src = 'let v: array<utinyint, 3> = [4, 5, 6];\nexport function main(): void { v[0] = v[1]; }';
  const c = emitC(irOf(src), { machine: 'nes' });
  assert.match(c, /static const uint8_t __8bs_init_v\[3\] __attribute__\(\(section\("\.rodata\.__8bs_init_v"\)\)\) = \{ 4, 5, 6 \};/);
  assert.match(c, /uint8_t v\[3\] __attribute__\(\(section\("\.noinit\.v"\)\)\);/);
  assert.match(c, /for \(uint8_t i = 0; i < 3; i\+\+\) v\[i\] = __8bs_init_v\[i\];/);
});

test('emitC: scalars take zero page until the budget is spent, then ordinary RAM', () => {
  const decls = Array.from({ length: 30 }, (_, i) => `let v${i}: uint = ${i};`).join('\n');
  const c = emitC(irOf(`${decls}\nexport function main(): void { v0 = v29; }`), { machine: 'c64' });
  // 30 four-byte variables: the first twelve (48 bytes) fit, the thirteenth does not.
  assert.match(c, /uint32_t v11 __attribute__\(\(section\("\.zp\.noinit\.v11"\)\)\);/);
  assert.match(c, /uint32_t v12 __attribute__\(\(section\("\.noinit\.v12"\)\)\);/);
  assert.match(c, /v29 = 29;/);
});

test('emitC: frameRate above the overflow-safe cap is refused, not silently wrapped', () => {
  assert.throws(
    () => emitC(frameIr(), { machine: 'vic20', frameRate: 100000 }),
    /frameRate must be a positive integer/,
  );
});

// The hardware a build is for reaches the backend already resolved
// (packages/cli/src/hardware.mjs): a `build` block with the link symbols,
// and possibly another driver and output. These are the shapes the
// catalogs produce today.
const PET_3008 = { build: { defsym: { __ram_size: 8 } }, label: 'model=3008' };
const XEGS = { build: { driver: 'mos-atari8-cart-xegs-clang', output: 'rom' }, label: 'model=xegs' };

test('outputExtension: the machine\'s own, unless the hardware links something else', () => {
  assert.equal(outputExtension('c64'), 'prg');
  assert.equal(outputExtension('nes'), 'nes');
  assert.equal(outputExtension('atari8'), 'xex');
  assert.equal(outputExtension('atari8', XEGS), 'rom');
  assert.equal(outputExtension('atari8', { build: { defsym: {} } }), 'xex');
});

test('DRIVER names one stock driver per 6502 machine', () => {
  assert.deepEqual(Object.keys(DRIVER).sort(), ['atari8', 'c128', 'c64', 'cx16', 'mega65', 'nes', 'pet', 'vic20']);
  assert.equal(DRIVER.atari8, 'mos-atari8-dos-clang');
});

test('buildPrg: the hardware\'s link symbols reach the linker — a 3008 PET build fits under 8K with its stack at the top', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-test-'));
  try {
    const outFile = join(scratch, 'm.prg');
    const result = await buildPrg(frameIr(), { machine: 'pet', hardware: PET_3008, outFile });
    assert.ok(result.ok, result.error);
    const prg = await readFile(outFile);
    assert.equal(prg[0], 0x01); // load address $0401, behind the BASIC SYS stub
    assert.equal(prg[1], 0x04);
    assert.ok(prg.length <= 8 * 1024 - 0x401, `prg is ${prg.length} bytes`);
    // The SDK's link.ld puts __stack at __ram_size KiB: $2000 for the 3008.
    const nm = join(process.env.LLVM_MOS_HOME, 'bin', 'llvm-nm');
    const symbols = await new Promise((resolvePromise, rejectPromise) => {
      execFile(nm, [`${outFile}.elf`], (error, stdout) => (error ? rejectPromise(error) : resolvePromise(stdout)));
    });
    assert.match(symbols, /00002000 A __stack/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

for (const [machine, opts] of [
  ['pet', {}],
  ['c128', {}],
  ['mega65', {}],
  ['cx16', {}],
  ['nes', {}],
  ['atari8', {}],
  ['atari8', { hardware: XEGS }],
]) {
  const label = `${machine}${opts.hardware ? `/${opts.hardware.label}` : ''}`;
  test(`buildPrg: a waitFrame() program compiles for real on ${label}`, { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-test-'));
    try {
      const ext = outputExtension(machine, opts.hardware);
      const outFile = join(scratch, `m.${ext}`);
      const result = await buildPrg(frameIr(), { machine, outFile, ...opts });
      assert.ok(result.ok, result.error);
      assert.ok(existsSync(outFile));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

// The linker's `ir.nativeSources` go to the driver as extra inputs. The
// NES font is the first real one: a .s whose bytes land in the .nes image's
// CHR bank — checked by position, since nothing in the C could put them
// there. iNES layout: 16-byte header, 32 KiB PRG, then 8 KiB CHR; tile $41
// ('A') is 16 bytes at CHR + $410, its first row 0b00011000 = $18 (see
// packages/nes/native/6502/font.s).
test('buildPrg: nativeSources are assembled and linked — the NES font lands in CHR-ROM', { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async () => {
  const font = fileURLToPath(new URL('../../nes/native/6502/font.s', import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-test-'));
  try {
    const outFile = join(scratch, 'm.nes');
    const ir = { ...frameIr(), nativeSources: [font] };
    const result = await buildPrg(ir, { machine: 'nes', outFile });
    assert.ok(result.ok, result.error);
    const rom = await readFile(outFile);
    assert.equal(rom.length, 16 + 32768 + 8192);
    assert.equal(rom[5], 1); // header byte 5: CHR-ROM size in 8 KiB units
    const chr = 16 + 32768;
    assert.deepEqual([...rom.subarray(chr + 0x410, chr + 0x418)], [0x18, 0x3C, 0x66, 0x7E, 0x66, 0x66, 0x66, 0x00]);
    assert.deepEqual([...rom.subarray(chr + 0x418, chr + 0x420)], [0, 0, 0, 0, 0, 0, 0, 0]); // plane 1 clear
    assert.deepEqual([...rom.subarray(chr + 0x808, chr + 0x810)], Array(8).fill(0xFF)); // $80: solid, plane 1 set
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ---- the size level is chosen by measuring, not assumed --------------------
//
// Neither -Os nor -Oz is smaller everywhere (docs/compiler.md), so buildPrg
// compiles the program at both and keeps whichever linked smaller. This is
// a guard against that quietly becoming a single pass again: over the
// repository's own three programs on eight targets, best-of-two was 669
// bytes better than -Os alone and made no build worse.
test('buildPrg compiles at both of LLVM\'s size levels and keeps the smaller', () => {
  const source = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const build = source.slice(source.indexOf('export async function buildPrg'));
  assert.match(build, /compile\('-Os'\)/, 'the build still tries -Os');
  assert.match(build, /compile\('-Oz'\)/, 'the build still tries -Oz');
  assert.match(build, /other\.program < first\.program/, 'and keeps whichever linked smaller');
});
