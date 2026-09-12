// The NES as a build target: the parts of the 6502 backend that are this
// machine's and no other's.
//
// Kept apart from mos.test.ts, which measures the Commodore .prg shape byte
// for byte, because almost nothing here is shared with it: the output is a
// cartridge rather than a load, the entry is a hardware vector rather than
// a BASIC `SYS`, main() ending halts rather than returns, mutable arrays
// live in RAM rather than in the image, and the character set is part of
// the FILE. Each of those is a separate mechanism with its own way of
// being wrong, so each gets its own test here.
//
// The screenshots these stand in for are in packages/nes/AGENTS.md's
// verification row: a test can prove the reset vector points at the entry,
// and only FCEUX can prove the picture comes up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build, FRAME_SYNC } from '../src/mos/index.ts';
import type { BuildOptions, IrProgram } from '../src/mos/index.ts';
import { CHR_ROM_BYTES, NES, PRG_ROM_BYTES } from '../src/mos/image-nes.ts';
import { assembleChrRom } from '../src/mos/chr-nes.ts';
import { frameEdgeWait, waitFrameRoutine } from '../src/mos/startup/waitframe.ts';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';

// ---- the CHR-ROM reader ----------------------------------------------------

/** A `.chr_rom` source in the same gas subset packages/nes/native/6502/font.s is written in. */
const FONT_SHAPED = [
  '; a comment',
  '.macro tile r0, r1',
  '    .byte \\r0, \\r1',
  '    .byte 0, 0',
  '.endm',
  '.macro inv r0',
  '    .byte 0xff^\\r0',
  '.endm',
  '.section .chr_rom,"a"',
  'tile 0b00000011, 0x0C',
  '.space 2 * 2',
  '.rept 3',
  '    inv 0b00001111',
  '.endr',
  '.byte (1 + 2) * 4',
].join('\n');

test('the CHR reader reads font.s\'s own gas subset: macros with \\arg substitution, .rept, .space with arithmetic, and xor', () => {
  const chr = assembleChrRom([{ path: 'font.s', text: FONT_SHAPED }], 32);
  assert.equal(chr.ok, true, chr.ok ? '' : chr.error);
  if (!chr.ok) return;
  assert.deepEqual(
    [...chr.bytes.slice(0, chr.defined)],
    [
      0x03, 0x0c, 0x00, 0x00, // tile 0b11, $0C — the macro's two arguments, then its own two literal zeros
      0x00, 0x00, 0x00, 0x00, // .space 2 * 2 — the expression is evaluated, not read as "2"
      0xf0, 0xf0, 0xf0, // .rept 3 of `inv 0b00001111` — 0xff ^ 0x0f
      12, // (1 + 2) * 4 — parentheses and precedence
    ],
  );
  assert.equal(chr.defined, 12);
  assert.equal(chr.bytes.length, 32, 'padded to the requested size: the rest of the character set is blank tiles');
});

test('the CHR reader keeps only .chr_rom bytes — a native source that assembles something else contributes none', () => {
  const source = [
    '.section .text,"ax"',
    '.byte 1, 2, 3',
    '.section .chr_rom,"a"',
    '.byte 9',
  ].join('\n');
  const chr = assembleChrRom([{ path: 'mixed.s', text: source }], 4);
  assert.equal(chr.ok, true, chr.ok ? '' : chr.error);
  if (!chr.ok) return;
  assert.deepEqual([...chr.bytes], [9, 0, 0, 0]);
  assert.equal(chr.defined, 1);
});

test('the CHR reader refuses what it does not understand, quoting the line — never silently dropping bytes a font needs', () => {
  for (const [source, pattern] of [
    ['.section .chr_rom,"a"\nlda #$00', /lda #\$00/],
    ['.section .chr_rom,"a"\n.byte someSymbol', /someSymbol/],
    ['.macro t a\n.byte \\a', /no matching \.endm/],
    ['.rept 2\n.byte 1', /no matching \.endr/],
    ['.section .chr_rom,"a"\n.space one', /not a size this reads/],
  ] as const) {
    const chr = assembleChrRom([{ path: 'bad.s', text: source }], 16);
    assert.equal(chr.ok, false, `expected a refusal for:\n${source}`);
    assert.match(chr.ok ? '' : chr.error, pattern);
  }
});

test('the CHR reader refuses a character set too big for the ROM, with both sizes', () => {
  const chr = assembleChrRom([{ path: 'big.s', text: '.section .chr_rom,"a"\n.space 40' }], 16);
  assert.equal(chr.ok, false);
  assert.match(chr.ok ? '' : chr.error, /16 bytes and the linked program's \.chr_rom sections define 40/);
});

// ---- the iNES image --------------------------------------------------------

const FONT_PATH = new URL('../../nes/native/6502/font.s', import.meta.url).pathname;
const PRG_ORIGIN = 0x8000;

test('the .nes image is an iNES header, 32K of PRG-ROM and 8K of CHR-ROM, with the code at $8000', () => {
  const body = new Uint8Array([0xea, 0xea]); // two NOPs standing in for a program
  const bytes = NES.file(PRG_ORIGIN, body, PRG_ORIGIN, { nativeSources: [FONT_PATH] });

  assert.equal(bytes.length, 16 + PRG_ROM_BYTES + CHR_ROM_BYTES);
  assert.deepEqual([...bytes.slice(0, 8)], [
    0x4e, 0x45, 0x53, 0x1a, // "NES" + the MS-DOS EOF byte
    0x02, // PRG-ROM in 16K units: 32K
    0x01, // CHR-ROM in 8K units: 8K
    0x00, // mapper 0 (NROM) low nibble, no battery, no trainer
    0x00, // mapper 0 high nibble, not a VS/PlayChoice board
  ]);
  assert.deepEqual([...bytes.slice(8, 16)], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...bytes.slice(16, 18)], [0xea, 0xea], 'the code sits at the very start of PRG-ROM');
});

test('the .nes image\'s vectors: RESET at the entry, NMI and IRQ at an RTI, none of them left as padding', () => {
  const bytes = NES.file(PRG_ORIGIN, new Uint8Array([0xea]), PRG_ORIGIN, { nativeSources: [FONT_PATH] });
  const prg = bytes.subarray(16, 16 + PRG_ROM_BYTES);
  const at = (address: number) => prg[address - PRG_ORIGIN] | (prg[address - PRG_ORIGIN + 1] << 8);

  assert.equal(at(0xfffc), PRG_ORIGIN, 'RESET: what the 6502 jumps to at power-on IS the program');
  assert.equal(at(0xfffa), 0xfff9, 'NMI');
  assert.equal(at(0xfffe), 0xfff9, 'IRQ/BRK');
  assert.equal(prg[0xfff9 - PRG_ORIGIN], 0x40, 'and $FFF9 is an RTI, so a vector that cannot fire still would not run padding');
});

test('the .nes image carries @8bitscript/nes\'s real character set, tile index == ASCII', () => {
  const bytes = NES.file(PRG_ORIGIN, new Uint8Array([0xea]), PRG_ORIGIN, { nativeSources: [FONT_PATH] });
  const chr = bytes.subarray(16 + PRG_ROM_BYTES);
  assert.equal(chr.length, CHR_ROM_BYTES);
  // 'A' is tile $41 and its first bitplane row is the glyph's top row.
  // Checked against the file's own artwork rather than against a hash, so
  // a failure says which letter changed.
  assert.deepEqual([...chr.subarray(0x41 * 16, 0x41 * 16 + 8)], [0x18, 0x3c, 0x66, 0x7e, 0x66, 0x66, 0x66, 0x00]);
  // Lowercase, added 2026-09-12 — before it, `Hello World!` drew as `H  W !`.
  assert.deepEqual([...chr.subarray(0x65 * 16, 0x65 * 16 + 8)], [0x00, 0x00, 0x3c, 0x66, 0x7e, 0x60, 0x3c, 0x00], "'e'");
  // Tile $80 is the drawn border: all of plane 1, none of plane 0.
  assert.deepEqual([...chr.subarray(0x80 * 16, 0x80 * 16 + 16)], [
    0, 0, 0, 0, 0, 0, 0, 0,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
});

test('the .nes image refuses a program with no character set, and a load address NROM cannot map', () => {
  assert.throws(
    () => NES.file(PRG_ORIGIN, new Uint8Array([0xea]), PRG_ORIGIN, { nativeSources: [] }),
    /no character ROM of its own/,
  );
  assert.throws(
    () => NES.file(0x0401, new Uint8Array([0xea]), 0x0401, { nativeSources: [FONT_PATH] }),
    /NROM maps its 32K of PRG-ROM at \$8000/,
  );
});

// ---- build() for the NES ---------------------------------------------------

function nesHardware(): BuildOptions['hardware'] {
  const resolved = resolveHardware(loadCatalog('nes'), {});
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  return resolved.hardware as unknown as BuildOptions['hardware'];
}

/** The hardware sheet's own numbers, asserted here so a change to packages/nes/package.json cannot quietly move the program. */
test('the NES hardware sheet: PRG-ROM at $8000 up to the vector table, and $0200-$07FF of work RAM', () => {
  const { defsym } = nesHardware().build;
  assert.equal(defsym.__load_address, 0x8000, 'NROM maps 32K of PRG-ROM at $8000');
  assert.equal(defsym.__ram_ceiling, 0xfff9, 'and the program must end below the vectors and the shared RTI');
  assert.equal(
    defsym.__ram_ceiling - defsym.__load_address,
    32 * 1024 - 6 - 1,
    "the 32K NROM PRG-ROM packages/nes/AGENTS.md documents, less the 6502's three vectors and the one RTI they point at",
  );
  assert.equal(defsym.__bss_origin, 0x0200);
  assert.equal(defsym.__bss_ceiling, 0x0800);
  assert.equal(
    defsym.__bss_ceiling - defsym.__bss_origin,
    1536,
    "the 1536 bytes of work RAM the catalog's own memory.ram fact reports, beside the zero page and the stack",
  );
});

/** Writes one byte to the PPU's data port — enough of a program to link, and nothing this file has to explain. */
const oneStore = (address: number, value: number) => [{
  kind: 'memoryWrite',
  address: { kind: 'const', value: address, type: 'usmallint' },
  value: { kind: 'const', value, type: 'utinyint' },
}];

const nesIr: IrProgram = {
  entry: 'main',
  functions: [{ name: 'main', body: oneStore(0x2007, 0x41) }],
  globals: [],
  nativeSources: [FONT_PATH],
};

async function buildNes(ir: IrProgram, extra: Partial<BuildOptions> = {}) {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-nes-'));
  const outFile = join(scratch, 'out.nes');
  const result = await build(ir, { machine: 'nes', hardware: nesHardware(), outFile, frameRate: 60, ...extra });
  return { result, outFile, cleanup: () => rm(scratch, { recursive: true, force: true }) };
}

test('build() for the NES writes a cartridge: header + 32K PRG + 8K CHR, the reset vector pointing at the entry', async () => {
  const { result, outFile, cleanup } = await buildNes(nesIr);
  try {
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.equal(result.bytes.length, 16 + PRG_ROM_BYTES + CHR_ROM_BYTES);
    assert.equal(existsSync(outFile), true);
    assert.deepEqual([...await readFile(outFile)], [...result.bytes]);
    const prg = result.bytes.subarray(16, 16 + PRG_ROM_BYTES);
    assert.equal(prg[0xfffc - 0x8000] | (prg[0xfffd - 0x8000] << 8), 0x8000);
  } finally {
    await cleanup();
  }
});

test('build() for the NES emits the reset handler first: the IRQ sources silenced, a stack pointer, and two vertical blanks', async () => {
  const { result, cleanup } = await buildNes(nesIr);
  try {
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const code = [...result.bytes.subarray(16, 16 + 32)];
    assert.deepEqual(code.slice(0, 9), [
      0x78, // SEI
      0xa2, 0x40, 0x8e, 0x17, 0x40, // LDX #$40 / STX $4017 — the APU frame IRQ inhibited
      0xa2, 0xff, 0x9a, // LDX #$FF / TXS — the stack pointer reset leaves undefined
    ]);
    // BIT $2002 / BPL back two bytes, twice: the PPU ignores writes for
    // ~29,658 cycles after reset and reports two vertical blanks by then.
    const warmup = [0x2c, 0x02, 0x20, 0x10, 0xfb, 0x2c, 0x02, 0x20, 0x10, 0xfb];
    assert.ok(
      code.some((_, i) => warmup.every((b, j) => code[i + j] === b)),
      'the two documented vertical-blank waits are in the reset handler',
    );
  } finally {
    await cleanup();
  }
});

test('build() for the NES ends main() in a halt, never an RTS — the hardware vectored in and pushed no return address', async () => {
  const { result, cleanup } = await buildNes(nesIr);
  try {
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const prg = [...result.bytes.subarray(16, 16 + 64)];
    // `JMP` to its own address: a three-byte instruction whose operand is
    // the address it sits at. Found by walking, because where it lands
    // depends on how long the reset handler and the body are.
    const halts = prg.flatMap((b, i) => (b === 0x4c && (prg[i + 1] | (prg[i + 2] << 8)) === 0x8000 + i ? [i] : []));
    assert.equal(halts.length, 1, 'exactly one spin-forever, at the end of the entry');
    assert.equal(prg[halts[0] - 1] !== 0x60, true, 'and no RTS ahead of it');
  } finally {
    await cleanup();
  }
});

// ---- mutable arrays on a ROM image -----------------------------------------

const arrayIr = (init: number[] | null): IrProgram => ({
  entry: 'main',
  functions: [{
    name: 'main',
    body: [{
      kind: 'storeIndex',
      array: { kind: 'ref', name: 'buffer', type: 'utinyint' },
      index: { kind: 'const', value: 0, type: 'utinyint' },
      value: { kind: 'const', value: 7, type: 'utinyint' },
      elementType: 'utinyint',
    }],
  }],
  globals: [{ name: 'buffer', type: 'utinyint', address: null, array: 4, init, constant: false }],
  nativeSources: [FONT_PATH],
});

test('a mutable array on a ROM image lives in RAM, not in the cartridge, and is cleared before the program runs', async () => {
  const { result, cleanup } = await buildNes(arrayIr(null));
  try {
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const prg = [...result.bytes.subarray(16, 16 + 96)];
    const has = (needle: number[]) => prg.some((_, i) => needle.every((b, j) => prg[i + j] === b));
    // STA $0200,X walked by an X counting down from 4 — the window the
    // sheet names, zeroed, because a cartridge's RAM holds whatever it
    // holds at power-on.
    assert.ok(has([0xa2, 0x04, 0xca, 0x9d, 0x00, 0x02, 0xd0, 0xfa]), 'the RAM window is cleared at start-up');
    // And the store the program itself makes goes to that same RAM, not
    // into the image: STA $0200,X (absolute,X — the array's own base).
    assert.ok(has([0x9d, 0x00, 0x02]) || has([0x8d, 0x00, 0x02]), 'the array is addressed in RAM');
  } finally {
    await cleanup();
  }
});

test('a mutable array with a real initializer keeps its bytes in the ROM and copies them down at start-up', async () => {
  const { result, cleanup } = await buildNes(arrayIr([1, 2, 3, 4]));
  try {
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const prg = [...result.bytes.subarray(16, 16 + PRG_ROM_BYTES)];
    assert.ok(
      prg.some((_, i) => [1, 2, 3, 4].every((b, j) => prg[i + j] === b)),
      'the initial bytes are in the image once',
    );
    // LDA rom,X / STA $0200,X / INX / CPX #4 / BNE — the copy loop.
    const head = prg.slice(0, 128);
    assert.ok(
      head.some((_, i) => head[i] === 0xbd && head[i + 3] === 0x9d && head[i + 4] === 0x00 && head[i + 5] === 0x02
        && head[i + 6] === 0xe8 && head[i + 7] === 0xe0 && head[i + 8] === 0x04),
      'and a loop that copies them into the RAM the array was given',
    );
  } finally {
    await cleanup();
  }
});

test('build() refuses an array too big for the NES\'s RAM window, naming it and what is left', async () => {
  // The store has to be in main: a global nothing reads is pruned before
  // any of this runs, so an unused 2000-byte array would build fine.
  const tooBig: IrProgram = {
    ...arrayIr(null),
    globals: [{ name: 'huge', type: 'utinyint', address: null, array: 2000, init: null, constant: false }],
    functions: [{
      name: 'main',
      body: [{
        kind: 'storeIndex',
        array: { kind: 'ref', name: 'huge', type: 'utinyint' },
        index: { kind: 'const', value: 0, type: 'utinyint' },
        value: { kind: 'const', value: 7, type: 'utinyint' },
        elementType: 'utinyint',
      }],
    }],
  };
  const { result, outFile, cleanup } = await buildNes(tooBig);
  try {
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /'huge' needs 2000 byte\(s\) of the nes's RAM but only 1536/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await cleanup();
  }
});

test('build() refuses a ROM image whose sheet names no RAM window at all, rather than putting an array where writes vanish', async () => {
  const sheet = nesHardware();
  const { __bss_origin, __bss_ceiling, ...rest } = sheet.build.defsym;
  const { result, cleanup } = await buildNes(arrayIr(null), {
    hardware: { ...sheet, build: { ...sheet.build, defsym: rest } },
  });
  try {
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /image is a ROM, so it needs real RAM/);
    assert.match(result.ok ? '' : result.error, /__bss_origin/);
  } finally {
    await cleanup();
  }
});

// ---- the frame runtime -----------------------------------------------------

test("FRAME_SYNC.nes is NESdev's own NTSC frame, not a rounded one", () => {
  const sync = FRAME_SYNC.nes;
  assert.equal(sync.kind, 'edge');
  if (sync.kind !== 'edge' || 'calibrate' in sync) return;
  // 341 dots x 261 lines + 340.5 for the pre-render line that is a dot
  // shorter on odd frames = 89341.5 dots a frame; twice that, divided by
  // the PPU's 3:1 ratio to the CPU, is an exact integer.
  assert.equal(sync.num, (341 * 261 + 340.5) * 2 / 3);
  assert.equal(sync.den, 2 * 1789773);
  assert.ok(Math.abs(sync.den / sync.num - 60.0988) < 0.001, 'which is NESdev\'s published 60.0988Hz');
  assert.equal(sync.frameHook, 'nesVerticalBlank');
});

test('waitFrame() on the NES polls PPUSTATUS bit 7 — the read is its own acknowledgement — and delivers the write queue', () => {
  const wait = frameEdgeWait('nes', 'tag');
  assert.deepEqual(wait?.map((d) => (d.kind === 'instruction' ? d.mnemonic : d.kind)), ['label', 'LDA', 'BPL']);

  const routine = waitFrameRoutine(0x10, 0x18, 'nes', '__8bs_fn_nesVerticalBlank');
  const mnemonics = routine.map((d) => (d.kind === 'instruction' ? d.mnemonic : ''));
  const poll = mnemonics.indexOf('BPL');
  const hook = routine.findIndex((d) => d.kind === 'instruction' && d.mnemonic === 'JSR');
  assert.ok(poll >= 0 && hook > poll, 'the frame hook is called after the edge is seen');
  // No acknowledgement write between them: reading PPUSTATUS cleared the
  // flag, which is why FRAME_SYNC.nes's own `ack` is empty.
  assert.equal(
    routine.slice(poll, hook).some((d) => d.kind === 'instruction' && d.mnemonic === 'STA'),
    false,
  );
  assert.equal(
    waitFrameRoutine(0x10, 0x18, 'nes').some((d) => d.kind === 'instruction' && d.mnemonic === 'JSR'),
    false,
    'and a program whose link has no hook pays nothing for one',
  );
});

test('build() refuses a frame hook the optimizer inlined away, rather than shipping a program that never delivers its picture', async () => {
  // A no-parameter void function with no `return` in it: inlineVoidCall
  // pastes it into its one call site and the prune drops it, which is
  // right for a helper and fatal for the function the backend itself
  // calls. @8bitscript/nes ends the real one with `return;` for exactly
  // this reason.
  const inlinedHook: IrProgram = {
    entry: 'main',
    functions: [
      { name: 'main', body: [{ kind: 'call', name: 'nesVerticalBlank', args: [] }] },
      { name: 'nesVerticalBlank', body: oneStore(0x2007, 0x20) },
    ],
    globals: [],
    nativeSources: [FONT_PATH],
  };
  const { result, cleanup } = await buildNes(inlinedHook);
  try {
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /nesVerticalBlank\(\) after every hardware frame/);
    assert.match(result.ok ? '' : result.error, /explicit 'return;'/);
  } finally {
    await cleanup();
  }
});

// ---- a read whose value nobody wants ---------------------------------------

test("`memory.read(addr);` as a statement is emitted, not elided: on this machine the read IS the action", async () => {
  const readOnly: IrProgram = {
    entry: 'main',
    functions: [{
      name: 'main',
      // What @8bitscript/nes's setVramAddress() opens with: reading
      // PPUSTATUS is what resets the PPU's address/scroll write toggle.
      body: [
        { kind: 'memoryRead', address: { kind: 'const', value: 0x2002, type: 'usmallint' } },
        ...oneStore(0x2006, 0x20),
      ],
    }],
    globals: [],
    nativeSources: [FONT_PATH],
  };
  const { result, cleanup } = await buildNes(readOnly);
  try {
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    const prg = [...result.bytes.subarray(16, 16 + 96)];
    // LDA $2002 followed (eventually) by the store the program also makes.
    assert.ok(
      prg.some((_, i) => prg[i] === 0xad && prg[i + 1] === 0x02 && prg[i + 2] === 0x20
        && prg[i + 3] === 0xa9 && prg[i + 5] === 0x8d && prg[i + 6] === 0x06 && prg[i + 7] === 0x20),
      'the discarded read is still a real LDA, right where the program put it',
    );
  } finally {
    await cleanup();
  }
});
