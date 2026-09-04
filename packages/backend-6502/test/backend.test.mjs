// The 6502 backend's tests: the generated C as a deterministic string always,
// and a real compile to .prg when LLVM-MOS is installed (skipped, not failed,
// when it is not — CI without the SDK still runs the emitter tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tokenize, parse, lower } from '@8bitscript/compiler';
import {
  emitC, buildPrg, outputExtension, ATARI8_PROFILES,
} from '../src/index.mjs';

const irOf = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't').ir;
};

const frameIr = () => irOf('export function main(): void { }\nexport function frame(): void { }');

test('emits plain C for the milestone program', () => {
  const c = emitC(irOf('let x: u8 = 10;\nexport function main(): void { x = x + 1; }'));
  assert.match(c, /uint8_t x = 10;/);
  assert.match(c, /int main\(void\) \{/);
  assert.match(c, /x = \(x \+ 1\);/);
  assert.match(c, /return 0;/);
});

test('@address becomes a volatile pointer #define', () => {
  const c = emitC(irOf('@address(0x900F)\nlet vicColor: volatile<u8>;'));
  assert.match(c, /#define vicColor \(\*\(volatile uint8_t \*\)0x900F\)/);
});

test('calls emit with prototypes ahead of every definition', () => {
  // The linker puts the entry's functions first, so main may call a function
  // defined below it; without the prototype block the C would not compile.
  const c = emitC(irOf('export function main(): void { apply(); }\nexport function apply(): void { return; }'));
  assert.match(c, /void apply\(void\);/);
  assert.match(c, /apply\(\);/);
  assert.ok(c.indexOf('void apply(void);') < c.indexOf('int main(void)'));
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

// ---- Phase 2-4 targets: PET, C128, Atari 8-bit, NES, Commander X16, MEGA65

test('outputExtension: prg everywhere except NES (.nes) and Atari 8-bit (.xex, or .rom for xegs)', () => {
  assert.equal(outputExtension('vic20'), 'prg');
  assert.equal(outputExtension('c64'), 'prg');
  assert.equal(outputExtension('pet'), 'prg');
  assert.equal(outputExtension('c128'), 'prg');
  assert.equal(outputExtension('mega65'), 'prg');
  assert.equal(outputExtension('cx16'), 'prg');
  assert.equal(outputExtension('nes'), 'nes');
  assert.equal(outputExtension('atari8', '800xl'), 'xex');
  assert.equal(outputExtension('atari8', 'xegs'), 'rom');
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
  assert.match(c, /__8bs_num = 3576060u;/);
  assert.match(c, /__8bs_den = 3579546u;/);
});

test('emitC: cx16 polls VERA ISR and acknowledges by writing the bit back', () => {
  const c = emitC(frameIr(), { machine: 'cx16' });
  assert.match(c, /0x9F27/);
  assert.match(c, /"sei"/);
  // cx16 has no documented crystal split, so its FRAME_SYNC entry is the
  // degenerate { num: 1, den: 60 }: real hardware fires at a fixed ~60Hz,
  // so at the default frameRate the accumulator drains 1:1.
  assert.match(c, /__8bs_num = 60u;/);
  assert.match(c, /__8bs_den = 60u;/);
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
  // vic20 ntsc: { num: 261 * 65 * 14, den: 14318181 } -> num * 50 = 11875500
  assert.match(c, /__8bs_num = 11875500u;/);
  assert.match(c, /__8bs_den = 14318181u;/);
  // vic20 pal: { num: 312 * 71 * 4, den: 4433618 } -> num * 50 = 4430400
  assert.match(c, /__8bs_num = 4430400u;/);
  assert.match(c, /__8bs_den = 4433618u;/);
});

test('emitC: frameRate scales an edge-fixed machine (nes)', () => {
  const c = emitC(frameIr(), { machine: 'nes', frameRate: 50 });
  // nes: { num: 59601, den: 2 * 1789773 } -> num * 50 = 2980050
  assert.match(c, /__8bs_num = 2980050u;/);
  assert.match(c, /__8bs_den = 3579546u;/);
});

test('emitC: frameRate is substituted into an edge-calibrated machine\'s (pet) runtime measurement', () => {
  const c = emitC(frameIr(), { machine: 'pet', frameRate: 50 });
  assert.match(c, /__8bs_num = 50u \* \(uint32_t\)__8bs_elapsed;/);
});

test('emitC: frameRate scales cx16\'s degenerate 1/60 ratio', () => {
  const c = emitC(frameIr(), { machine: 'cx16', frameRate: 50 });
  assert.match(c, /__8bs_num = 50u;/);
  assert.match(c, /__8bs_den = 60u;/);
});

test('emitC: frameRate above the overflow-safe cap is refused, not silently wrapped', () => {
  assert.throws(
    () => emitC(frameIr(), { machine: 'vic20', frameRate: 100000 }),
    /frameRate must be a positive integer/,
  );
});

test('buildPrg: an unknown atari8 profile is refused', async () => {
  const result = await buildPrg(irOf('export function main(): void { }'), {
    machine: 'atari8', atari8Profile: 'bogus', outFile: 'unused.xex',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown atari8 profile/);
});

test('ATARI8_PROFILES lists exactly the six documented hardware profiles', () => {
  assert.deepEqual([...ATARI8_PROFILES].sort(), ['130xe', '400', '65xe', '800', '800xl', 'xegs']);
});

for (const [machine, opts] of [
  ['pet', {}],
  ['c128', {}],
  ['mega65', {}],
  ['cx16', {}],
  ['nes', {}],
  ['atari8', { atari8Profile: '800xl' }],
  ['atari8', { atari8Profile: 'xegs' }],
]) {
  const label = `${machine}${opts.atari8Profile ? `/${opts.atari8Profile}` : ''}`;
  test(`buildPrg: a frame()-driven program compiles for real on ${label}`, { skip: !HAS_SDK && 'LLVM_MOS_HOME not set' }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-test-'));
    try {
      const ext = outputExtension(machine, opts.atari8Profile);
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
