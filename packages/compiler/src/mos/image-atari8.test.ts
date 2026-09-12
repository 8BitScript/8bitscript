// What the Atari 8-bit's `.xex` has to be, and what its waitFrame() runtime
// has to poll — checked against the two artifacts this project can point at
// rather than against numbers retyped from the code under test: the `xxd` of
// a working `.xex` that packages/atari8/AGENTS.md records, and the hardware
// sheet in packages/atari8/package.json.
//
// These live here rather than in test/mos.test.ts because every assertion
// below is about one machine, and mos.test.ts is where the machine-agnostic
// contract is measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ATARI8 } from './image-atari8.ts';
import { imageFor } from './image.ts';
import { build, FRAME_SYNC } from './index.ts';
import type { BuildOptions, IrProgram, RatioPair } from './index.ts';
import { waitFrameKeepsInterrupts, waitFrameSetup } from './startup/waitframe.ts';
import type { Directive } from './asm/assemble.ts';
import { loadCatalog, resolveHardware } from '../../../cli/src/hardware.mjs';

/** The stock 800XL sheet, exactly as `8bs build --target atari8` resolves it. */
function stockSheet(): BuildOptions['hardware'] {
  const resolved = resolveHardware(loadCatalog('atari8'), {});
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  return resolved.hardware as unknown as BuildOptions['hardware'];
}

/** The smallest program that builds: `main()` with an empty body. */
const emptyIr: IrProgram = { entry: 'main', functions: [{ name: 'main', body: [] }], globals: [] };

/** The same, plus one waitFrame() — enough to pull in the whole frame runtime. */
const waitFrameIr: IrProgram = {
  entry: 'main',
  functions: [{ name: 'main', body: [{ kind: 'waitFrame' }] as IrProgram['functions'][0]['body'] }],
  globals: [],
};

async function buildAtari8(ir: IrProgram, hardware = stockSheet()): Promise<Uint8Array> {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-atari8-'));
  try {
    const result = await build(ir, { machine: 'atari8', hardware, outFile: join(scratch, 'out.xex'), frameRate: 60 });
    if (!result.ok) throw new Error(result.error);
    return result.bytes;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---- the hardware sheet ----------------------------------------------------

// packages/atari8/AGENTS.md records the same region three ways — the link
// script's literal `ORIGIN = 0x2000, LENGTH = 0xa000`, the MEMLO survey that
// chose $2000, and the catalog's own `memory.ram` — and the two defsyms are
// only right if they reproduce it. This is that arithmetic, done against the
// real catalog rather than against two constants written down here.
test('atari8 sheet: __ram_ceiling - __load_address is exactly the memory.ram fact ($2000-$BFFF, 40960 bytes)', () => {
  const sheet = stockSheet();
  assert.equal(sheet.build.defsym.__load_address, 0x2000);
  assert.equal(sheet.build.defsym.__ram_ceiling, 0xc000);
  assert.equal(sheet.build.defsym.__ram_ceiling - sheet.build.defsym.__load_address, sheet.facts['memory.ram']);
  assert.equal(sheet.facts['memory.ram'], 40960);
});

// ---- the .xex container ----------------------------------------------------

test('atari8 image: no prelude, and the code starts at the load address', () => {
  const { bytes, codeStart } = ATARI8.prelude(0x2000);
  assert.equal(bytes.length, 0);
  assert.equal(codeStart, 0x2000);
  assert.equal(imageFor('atari8'), ATARI8);
});

// The twelve bytes packages/atari8/AGENTS.md quotes off a real, booting
// `.xex` this project built pre-0.2.0: `ff ff e0 02 e1 02 00 20 00 20 31 23`.
// Everything but the last two is fixed for every build at $2000 — marker, RUN
// segment ($02E0-$02E1 inclusive) carrying the entry address, then the code
// segment's own header. The last two are that build's `end`, which is a
// function of its length; the fixture below is sized so this reproduces the
// recorded bytes exactly rather than approximately.
test('atari8 image: the file opens with the RUN segment, then the code segment, byte for byte as the recorded xxd', () => {
  const body = new Uint8Array(0x2331 - 0x2000 + 1); // the recorded build's own length
  const file = ATARI8.file(0x2000, body, 0x2000, { nativeSources: [] });
  assert.deepEqual(
    [...file.slice(0, 12)],
    [0xff, 0xff, 0xe0, 0x02, 0xe1, 0x02, 0x00, 0x20, 0x00, 0x20, 0x31, 0x23],
  );
  assert.equal(file.length, 12 + body.length);
});

// `end` names the LAST byte, not the byte after it. A one-byte program is the
// case that tells the two readings apart: inclusive gives start == end, and
// off-by-one gives end == start - 1, which is a segment of $10000 bytes.
test('atari8 image: a segment\'s end address is inclusive', () => {
  const file = ATARI8.file(0x2000, new Uint8Array(1), 0x2000, { nativeSources: [] });
  const start = file[8] | (file[9] << 8);
  const end = file[10] | (file[11] << 8);
  assert.equal(start, 0x2000);
  assert.equal(end, 0x2000);
});

test('atari8 image: the RUN segment carries the entry address, not the load address, when they differ', () => {
  const file = ATARI8.file(0x2000, new Uint8Array(4), 0x2345, { nativeSources: [] });
  assert.equal(file[6] | (file[7] << 8), 0x2345);
});

test('build() for the atari8 writes a real .xex: the recorded header, then the linked code, with end = start + length - 1', async () => {
  const bytes = await buildAtari8(emptyIr);
  assert.deepEqual([...bytes.slice(0, 10)], [0xff, 0xff, 0xe0, 0x02, 0xe1, 0x02, 0x00, 0x20, 0x00, 0x20]);
  const end = bytes[10] | (bytes[11] << 8);
  assert.equal(end, 0x2000 + (bytes.length - 12) - 1);
});

// ---- how a program ends ----------------------------------------------------

// DOS really did JSR through RUNAD, so `entryIsVectored` is false — but the
// environment an RTS returns to clears the screen (see image-atari8.ts's own
// measurement), so `endsByHalting` makes main() spin instead. The proof in
// the image is a `JMP` whose operand is its own address.
test('atari8 image: entered by a loader (entryIsVectored false) but ends by halting', () => {
  assert.equal(ATARI8.entryIsVectored, false);
  assert.equal(ATARI8.endsByHalting, true);
});

test('build() for the atari8 ends main() with a JMP to itself, not an RTS to a caller that would wipe the screen', async () => {
  const bytes = await buildAtari8(emptyIr);
  let found = false;
  for (let i = 12; i + 2 < bytes.length; i++) {
    if (bytes[i] !== 0x4c) continue;
    const target = bytes[i + 1] | (bytes[i + 2] << 8);
    // The code segment starts at $2000 and begins at file offset 12.
    if (target === 0x2000 + (i - 12)) found = true;
  }
  assert.ok(found, 'the image contains a JMP to its own address');
});

// ---- the frame runtime -----------------------------------------------------

test('waitFrame() on the atari8 polls ANTIC\'s VCOUNT and leaves interrupts alone', async () => {
  assert.equal(waitFrameKeepsInterrupts('atari8'), true);
  // The rule this is the exception to: every Commodore takes the machine.
  assert.equal(waitFrameKeepsInterrupts('c64'), false);
  assert.equal(waitFrameKeepsInterrupts('vic20'), false);

  const bytes = await buildAtari8(waitFrameIr);
  const code = [...bytes];
  const has = (needle: number[]) => code.some((_, i) => needle.every((b, j) => code[i + j] === b));
  assert.ok(has([0xad, 0x0b, 0xd4]), 'LDA $D40B — ANTIC VCOUNT');
  assert.ok(has([0xc9, 0x40]), 'CMP #64 — the top-half test');
  assert.ok(has([0xc9, 140]), 'CMP #140 — the PAL-only probe line');
  // Nothing of any other machine's frame hardware: VIC-II's raster pair, the
  // VIC-I's counter, VERA's ISR, the PET's retrace flag.
  for (const foreign of [[0xad, 0x12, 0xd0], [0xad, 0x04, 0x90], [0xad, 0x27, 0x9f], [0xad, 0x13, 0xe8]]) {
    assert.equal(has(foreign), false, 'no other machine\'s frame hardware');
  }
});

// The one-byte proof of the decision, taken on the directives rather than on
// the image: a `$78` in a built `.xex` is just as likely to be the low byte
// of STICK0 ($0278), which every Atari program that reads a joystick has.
test('waitFrameSetup: no SEI for the atari8, and one for a machine that takes the machine', () => {
  const sei = (program: Directive[]) => program.some((d) => d.kind === 'instruction' && d.mnemonic === 'SEI');
  assert.equal(sei(waitFrameSetup(60, 0x80, 0x84, 'atari8')), false);
  assert.equal(sei(waitFrameSetup(60, 0x02, 0x06, 'c64')), true);
  assert.equal(sei(waitFrameSetup(60, 0x02, 0x06, 'vic20')), true);
});

// FRAME_SYNC.atari8 and the runtime's own RASTER entry are two tables of the
// same two facts, and this is what notices if they ever drift apart: each
// region's per-frame credit has to reach the image as four immediates.
test('waitFrame() on the atari8 carries both regions\' credit, from FRAME_SYNC\'s own ratios', async () => {
  const sync = FRAME_SYNC.atari8;
  assert.equal(sync.kind, 'level');
  if (sync.kind !== 'level') return;
  const bytes = await buildAtari8(waitFrameIr);
  const code = [...bytes];
  const has = (needle: number[]) => code.some((_, i) => needle.every((b, j) => code[i + j] === b));
  const credit = (ratio: RatioPair) => Math.round((60 * ratio.num * 1_000_000) / ratio.den);
  const bytesOf = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  const pal = credit(sync.pal);
  const ntsc = credit(sync.ntsc);
  assert.notEqual(pal, ntsc, 'the two regions really do differ');
  for (const [region, value] of [['PAL', pal], ['NTSC', ntsc]] as const) {
    assert.ok(has([0xa9, bytesOf(value)[0]]), `${region} credit is loaded as an immediate`);
  }
});

// ---- what this backend will not build --------------------------------------

// Thirteen of the catalog's media values are cartridges, and each names a
// start-up driver this backend does not have. Refused BY NAME rather than
// wrapped in a .xex container and written out as a .rom nothing can load.
test('build() refuses an atari8 cartridge media value by name, and writes nothing', async () => {
  const resolved = resolveHardware(loadCatalog('atari8'), { overrides: { media: 'cart8' } });
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  const scratch = await mkdtemp(join(tmpdir(), '8bs-atari8-'));
  try {
    const outFile = join(scratch, 'out.rom');
    const result = await build(emptyIr, {
      machine: 'atari8',
      hardware: resolved.hardware as unknown as BuildOptions['hardware'],
      outFile,
      frameRate: 60,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /cart-std/);
    assert.match(result.error, /cartridge/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
