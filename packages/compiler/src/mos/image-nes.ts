// What a built NES program looks like as a FILE: an iNES cartridge image.
//
// Everything mos/image.ts's COMMODORE shape assumes is false here. There is
// no load address in the file, because nothing loads it — the bytes are a
// cartridge, already in the CPU's address space the moment the machine is
// switched on. There is no BASIC stub and no `SYS`, because there is no
// interpreter: the 6502 fetches a 16-bit address out of $FFFC/$FFFD on
// reset and jumps there, and that address is the whole of this target's
// start-up protocol. And there is no `RTS` at the end of main(), because
// there is nothing under it on the stack to return to — see `entryIsVectored`
// below, and the halt loop mos/index.ts emits in the epilogue's place.
//
// ---- the file's three parts ----------------------------------------------
//
// 1. A 16-byte iNES header. The format emulators actually read (FCEUX
//    among them): bytes 0-3 are `NES` + $1A, byte 4 is the PRG-ROM size in
//    16 KiB units, byte 5 the CHR-ROM size in 8 KiB units, byte 6's low
//    nibble is nametable arrangement/battery/trainer flags with the
//    mapper's low nibble above it, byte 7 the mapper's high nibble and the
//    VS/PlayChoice bits, bytes 8-15 padding (nesdev.org/wiki/INES, read
//    2026-09-12 — packages/nes/AGENTS.md's "verify hardware facts before
//    writing them into comments" rule applies to this table as much as to
//    the PPU's). NROM is mapper 0, so both mapper nibbles are zero and
//    bytes 6 and 7 are $00 outright.
//
//    Byte 6 bit 0 is the nametable arrangement, and it is genuinely
//    arbitrary for this target rather than merely defaulted: @8bitscript/nes
//    writes one nametable ($2000) and resets the scroll after every PPUADDR
//    sequence (its own rule 2), so the second nametable is never displayed
//    and which physical half it mirrors cannot be observed. A scrolling API
//    would make this a real choice; until there is one, 0.
//
// 2. 32 KiB of PRG-ROM, mapped at $8000-$FFFF. The linked code sits at its
//    start (the sheet's `__load_address`, which for this machine is the
//    hardware's own $8000 and not a policy), the gap after it is $FF —
//    the value an unprogrammed ROM reads as, and never executed — and the
//    top of it is the 6502's vector table.
//
// 3. 8 KiB of CHR-ROM: the tile patterns the PPU fetches. mos/chr-nes.ts
//    assembles these out of the `.chr_rom` native source @8bitscript/nes
//    ships, because unlike every other machine here the NES has no
//    character generator of its own.
//
// ---- the vectors ----------------------------------------------------------
//
// $FFFC/$FFFD (RESET) is the program's entry, and is the only reason this
// file needs `codeStart` at all. The other two are pointed at a single RTI
// byte placed immediately below the table, at $FFF9:
//
//   - $FFFA/$FFFB (NMI) fires on vertical blank only while PPUCTRL bit 7 is
//     set, and this target never sets it: @8bitscript/nes's resetScroll()
//     writes $2000 = 0 after every VRAM access and its own header says the
//     target "polls PPUSTATUS rather than taking the interrupt".
//   - $FFFE/$FFFF (IRQ) is masked for the whole life of the program: the
//     6502 sets the I flag as part of reset and nothing in this backend
//     ever clears it (the waitFrame runtime only ever SEIs), and NROM has
//     no mapper IRQ to begin with.
//
// So neither should ever be taken — which is exactly why they are pointed
// somewhere harmless rather than left at whatever the padding happens to
// be. A vector table full of $FFFF on a machine that did take an interrupt
// would execute the padding. One byte buys the difference between "cannot
// happen" and "cannot happen, and if it did the machine would carry on".
// The linker is what keeps that byte free: the sheet's `__ram_ceiling` is
// $FFF9, so code + data are refused by name before they can reach it.
import { readFileSync } from 'node:fs';

import { assembleChrRom } from './chr-nes.ts';
import type { ImageExtras, MachineImage } from './image.ts';

/** `NES` + the MS-DOS end-of-file byte — bytes 0-3 of every iNES file. */
const INES_MAGIC = [0x4e, 0x45, 0x53, 0x1a];
const INES_HEADER_BYTES = 16;

/** NROM: 32 KiB of PRG-ROM at $8000-$FFFF and 8 KiB of CHR-ROM, no banking (packages/nes/AGENTS.md's mapper row). */
export const PRG_ROM_BYTES = 32 * 1024;
export const CHR_ROM_BYTES = 8 * 1024;
const PRG_ORIGIN = 0x8000;

/** Where the 6502's three vectors live, and the RTI the two unused ones point at. */
const VECTOR_TABLE = 0xfffa;
const UNUSED_VECTOR_HANDLER = VECTOR_TABLE - 1;
const RTI = 0x40;

/** What an unprogrammed mask ROM reads as. Nothing ever executes it — see this file's header. */
const ROM_FILL = 0xff;

function le16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

/**
 * The 16-byte iNES header for this target's one cartridge shape. Written
 * as a function of the two sizes rather than as a literal so the numbers
 * in it can never drift from the bytes that follow it.
 */
function inesHeader(prgBytes: number, chrBytes: number): Uint8Array {
  const header = new Uint8Array(INES_HEADER_BYTES);
  header.set(INES_MAGIC, 0);
  header[4] = prgBytes / (16 * 1024);
  header[5] = chrBytes / (8 * 1024);
  header[6] = 0x00; // mapper 0's low nibble, no battery, no trainer, arrangement 0
  header[7] = 0x00; // mapper 0's high nibble, not a VS/PlayChoice board
  return header;
}

/**
 * Every native source's text, read from disk. Synchronous on purpose:
 * `MachineImage.file` is a pure bytes-in/bytes-out function called once
 * per build, and making the whole image interface async to read a handful
 * of small files that the resolver has already proved exist (8BS2008 is
 * raised long before a backend runs) would be a cost paid by every machine
 * for one.
 */
function readSources(paths: string[]): { path: string; text: string }[] {
  return paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}

/**
 * The CHR-ROM half of the image. Refused by name, rather than padded to
 * blank tiles, when the program contributes none: a .nes built without a
 * character set is not a broken build, it is a build that runs and shows
 * 960 empty cells, and packages/nes/AGENTS.md is explicit that this is the
 * class of failure only a screenshot catches.
 */
function chrRom(extras: ImageExtras): Uint8Array {
  const sources = readSources(extras.nativeSources);
  const chr = assembleChrRom(sources, CHR_ROM_BYTES);
  if (!chr.ok) throw new Error(chr.error);
  if (chr.defined === 0) {
    throw new Error(
      'the NES has no character ROM of its own, so a .nes image needs the tile patterns a package ships as a `.chr_rom` native source — the linked program contributes none. Importing @8bitscript/screen or @8bitscript/text brings @8bitscript/nes\'s own font in',
    );
  }
  return chr.bytes;
}

/** iNES header, 32K of PRG-ROM with the code at $8000 and the vectors on top, 8K of CHR-ROM. */
export const NES: MachineImage = {
  // Nothing precedes the code: the reset vector names its address outright,
  // so there is no stub to jump over and the code starts exactly where the
  // sheet says the cartridge is mapped.
  prelude(loadAddress: number) {
    return { bytes: new Uint8Array(0), codeStart: loadAddress };
  },

  file(loadAddress: number, body: Uint8Array, codeStart: number, extras: ImageExtras): Uint8Array {
    if (loadAddress !== PRG_ORIGIN) {
      throw new Error(
        `the NES hardware sheet's defsym.__load_address is $${loadAddress.toString(16).toUpperCase()}, but NROM maps its 32K of PRG-ROM at $8000 — a cartridge cannot be built to load anywhere else`,
      );
    }
    const offset = codeStart - PRG_ORIGIN;
    if (offset + body.length > UNUSED_VECTOR_HANDLER - PRG_ORIGIN) {
      // Unreachable through build(), which links against the sheet's own
      // __ram_ceiling of $FFF9 and refuses there by name first. Kept
      // because this function is what would silently overwrite the vectors
      // if that ceiling were ever wrong, and a cartridge with no reset
      // vector does not fail — it hangs.
      throw new Error(
        `the NES program ends at $${(PRG_ORIGIN + offset + body.length).toString(16).toUpperCase()}, past the $${UNUSED_VECTOR_HANDLER.toString(16).toUpperCase()} start of the 6502's vector table`,
      );
    }

    const prg = new Uint8Array(PRG_ROM_BYTES).fill(ROM_FILL);
    prg.set(body, offset);
    prg[UNUSED_VECTOR_HANDLER - PRG_ORIGIN] = RTI;
    le16(prg, VECTOR_TABLE - PRG_ORIGIN, UNUSED_VECTOR_HANDLER); // NMI
    le16(prg, VECTOR_TABLE - PRG_ORIGIN + 2, codeStart); // RESET: the program
    le16(prg, VECTOR_TABLE - PRG_ORIGIN + 4, UNUSED_VECTOR_HANDLER); // IRQ/BRK

    const chr = chrRom(extras);
    const header = inesHeader(PRG_ROM_BYTES, CHR_ROM_BYTES);
    const bytes = new Uint8Array(header.length + prg.length + chr.length);
    bytes.set(header, 0);
    bytes.set(prg, header.length);
    bytes.set(chr, header.length + prg.length);
    return bytes;
  },

  // The hardware starts the program, so main() ending has no caller to
  // return to (mos/index.ts emits a halt in the epilogue's place).
  entryIsVectored: true,

  // The image is a cartridge: storing into an array that lives in it does
  // nothing at all, and does it silently. build() puts mutable arrays in
  // the RAM window the sheet names instead.
  writableImage: false,
};
