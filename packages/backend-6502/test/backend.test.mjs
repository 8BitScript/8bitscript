// The 6502 backend's tests: the generated C as a deterministic string always,
// and a real compile to .prg when LLVM-MOS is installed (skipped, not failed,
// when it is not — CI without the SDK still runs the emitter tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.match(c, /__8bs_num = 1u;/);
  assert.match(c, /__8bs_den = 1u;/);
});

test('emitC: an unknown machine refuses rather than guessing', () => {
  assert.throws(() => emitC(frameIr(), { machine: 'commodore-64x' }), /unknown machine|needs a known machine/);
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
