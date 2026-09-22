// The 91 glyphs (ASCII 32 "space" through 122 "z") from Daniel Hepper's
// font8x8_basic (https://github.com/dhepper/font8x8, public domain, itself
// based on Marcel Sondaar's public-domain VGA font) — the portable
// character set the checker's own PORTABLE_CHARACTERS enforces on screen
// text (packages/compiler/src/checker/index.mjs: space, 0-9, A-Z, a-z,
// and a little punctuation) fits entirely inside this range, upper and
// lower case both. Trimmed from the original's full 128-entry table to
// just the range this project's screen codes ever use — 96 "`" rides
// along for a contiguous range even though it's outside the portable set;
// 123 "{" through 127 DEL are dropped since nothing in the portable set
// needs them.
//
// Codes 128-143 are the sixteen 2×2 quadrant-block patterns, indexed the
// same way @8bitscript/pet/blocks's QUAD table is (topLeft<<3 | topRight<<2
// | bottomLeft<<1 | bottomRight). They sit above ASCII so a program can stamp
// PET-style digits without colliding with 'a'/'b'/'l' (PET screen codes 97,
// 98, 108). Each quadrant is a 4×4 of the 8×8 cell.
//
// Each glyph is 8 bytes, one per row; bit x of a row byte is column x
// (bit 0 = leftmost pixel) — Hepper's own reference renderer reads it the
// same way. The browser canvas and --screenshot both draw these bits.
const GLYPHS_32_122_HEX = '0000000000000000183c3c1818001800363600000000000036367f367f3636000c3e031e301f0c00006333180c6663001c361c6e3b336e000606030000000000180c0606060c1800060c1818180c060000663cff3c660000000c0c3f0c0c000000000000000c0c060000003f0000000000000000000c0c006030180c060301003e63737b6f673e000c0e0c0c0c0c3f001e33301c06333f001e33301c30331e00383c36337f3078003f031f3030331e001c06031f33331e003f3330180c0c0c001e33331e33331e001e33333e30180e00000c0c00000c0c00000c0c00000c0c06180c0603060c180000003f00003f0000060c1830180c06001e3330180c000c003e637b7b7b031e000c1e33333f3333003f66663e66663f003c66030303663c001f36666666361f007f46161e16467f007f46161e16060f003c66030373667c003333333f333333001e0c0c0c0c0c1e007830303033331e006766361e366667000f06060646667f0063777f7f6b63630063676f7b736363001c36636363361c003f66663e06060f001e3333333b1e38003f66663e366667001e33070e38331e003f2d0c0c0c0c1e003333333333333f0033333333331e0c006363636b7f7763006363361c1c3663003333331e0c0c1e007f6331184c667f001e06060606061e0003060c18306040001e18181818181e00081c36630000000000000000000000ff0c0c18000000000000001e303e336e000706063e66663b0000001e3303331e003830303e33336e0000001e333f031e001c36060f06060f0000006e33333e301f0706366e666667000c000e0c0c0c1e00300030303033331e070666361e3667000e0c0c0c0c0c1e000000337f7f6b630000001f333333330000001e3333331e0000003b66663e060f00006e33333e307800003b6e66060f0000003e031e301f00080c3e0c0c2c18000000333333336e0000003333331e0c000000636b7f7f3600000063361c36630000003333333e301f00003f190c263f00';

const GLYPHS = Buffer.from(GLYPHS_32_122_HEX, 'hex');

export const BLOCK_CODE_BASE = 128;
export const BLOCK_CODE_COUNT = 16;

/**
 * Quarter-circle corner masks, one cell each: 144 top-left, 145 top-right,
 * 146 bottom-left, 147 bottom-right. A bit set is the cut — under reverse
 * video the host punches those pixels out, so the cell reads as a rounded
 * corner of the tile rather than a quadrant chamfer. Bit 0 is the leftmost
 * pixel. The curve is the r = 10 disk clipped to the cell, which is
 * symmetric and uses seven of the eight rows, so the whole corner is the
 * arc and the far edge of the cell stays solid where it meets the tile:
 *
 *     #######.
 *     #####...
 *     ###.....
 *     ##......
 *     ##......
 *     #.......
 *     #.......
 *     ........
 */
export const CORNER_CODE_BASE = 144;
const CORNER_TL = Buffer.from([0x7f, 0x1f, 0x07, 0x03, 0x03, 0x01, 0x01, 0x00]);

function mirrorByte(byte) {
  let out = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    if ((byte >> bit) & 1) out |= 1 << (7 - bit);
  }
  return out;
}

const CORNER_TR = Buffer.from(CORNER_TL.map(mirrorByte));
const CORNER_BL = Buffer.from([...CORNER_TL].reverse());
const CORNER_BR = Buffer.from([...CORNER_TR].reverse());
const CORNER_ROWS = [CORNER_TL, CORNER_TR, CORNER_BL, CORNER_BR];

/**
 * ©, at its own Latin-1/Unicode code point rather than an agreed-on private
 * number, because this table is ASCII-indexed outright and 0xA9 is what the
 * symbol *is* everywhere else. It sits above the quadrant blocks with a gap
 * (148-168) that stays blank, which costs nothing: glyphTableLiteral() skips
 * every code glyphRows() has no ink for. 144-147 are the four quarter-circle
 * corners, just above the quadrant blocks.
 *
 * Three of the nine targets can draw it, and they agree on this code.
 * This table is the web host's. @8bitscript/nes ships its own CHR-ROM and
 * now draws the same artwork at the same tile (native/6502/font.s). The
 * Commander X16 runs its screen in ISO mode, where the KERNAL's ISO-8859-15
 * set already holds © at 169 — read out of the shipped rom.bin rather than
 * assumed from the code chart, so nothing there had to change.
 *
 * The other six draw whatever their character generator holds at 169, which
 * is not this: the PET, C64, VIC-20, C128, MEGA65 and Atari 8-bit ROMs have
 * no © glyph anywhere in them (every chargen VICE ships, plus the Atari OS
 * and MEGA65 ROMs, were scanned for one). They gain the symbol when a
 * redefined-charset layer exists, which no machine has yet — a header that
 * implied otherwise would be the kind this project does not write.
 *
 * The portable character set has no way to spell © in a string literal
 * either (the checker's PORTABLE_CHARACTERS is space, 0-9, A-Z, a-z and a
 * little punctuation), so it is reached through putChar() with this code,
 * the same way "(" and ")" already are.
 *
 * Drawn as a ring with a C inside; bit 0 is the leftmost pixel, as
 * everywhere else in this file:
 *
 *     .######.      0x7E
 *     #......#      0x81
 *     #.####.#      0xBD
 *     #.#....#      0x85
 *     #.#....#      0x85
 *     #.####.#      0xBD
 *     #......#      0x81
 *     .######.      0x7E
 */
export const COPYRIGHT_CODE = 0xa9;
const COPYRIGHT_ROWS = Buffer.from([0x7e, 0x81, 0xbd, 0x85, 0x85, 0xbd, 0x81, 0x7e]);

function quadRows(index) {
  const tl = (index >> 3) & 1;
  const tr = (index >> 2) & 1;
  const bl = (index >> 1) & 1;
  const br = index & 1;
  const rows = Buffer.alloc(8);
  for (let y = 0; y < 8; y += 1) {
    const left = y < 4 ? tl : bl;
    const right = y < 4 ? tr : br;
    let bits = 0;
    if (left) bits |= 0x0f;
    if (right) bits |= 0xf0;
    rows[y] = bits;
  }
  return rows;
}

/**
 * The 8 row-bytes for an ASCII code in [32, 122], a 2×2 block pattern in
 * [128, 143], a quarter-circle corner in [144, 147], or `null` outside
 * those ranges — a blank cell in both renderers.
 * @param {number} code
 * @returns {Buffer | null}
 */
export function glyphRows(code) {
  if (code >= 32 && code <= 122) {
    const offset = (code - 32) * 8;
    return GLYPHS.subarray(offset, offset + 8);
  }
  if (code >= BLOCK_CODE_BASE && code < BLOCK_CODE_BASE + BLOCK_CODE_COUNT) {
    return quadRows(code - BLOCK_CODE_BASE);
  }
  if (code >= CORNER_CODE_BASE && code < CORNER_CODE_BASE + CORNER_ROWS.length) {
    return CORNER_ROWS[code - CORNER_CODE_BASE];
  }
  if (code === COPYRIGHT_CODE) return COPYRIGHT_ROWS;
  return null;
}

/**
 * `{code:[8 row-bytes],...}` for the browser page, so it paints the same
 * bits `--screenshot` does. All-zero glyphs (space, the empty block) are
 * omitted — a missing code is a blank cell.
 */
export function glyphTableLiteral() {
  const entries = [];
  for (let c = 0; c < 256; c += 1) {
    const rows = glyphRows(c);
    if (!rows) continue;
    let ink = false;
    for (let i = 0; i < 8; i += 1) {
      if (rows[i] !== 0) ink = true;
    }
    if (!ink) continue;
    entries.push(`${c}:[${[...rows].join(',')}]`);
  }
  return `{${entries.join(',')}}`;
}
