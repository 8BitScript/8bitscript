// The 64 glyphs (ASCII 32 "space" through 95 "_") from Daniel Hepper's
// font8x8_basic (https://github.com/dhepper/font8x8, public domain, itself
// based on Marcel Sondaar's public-domain VGA font) — the same portable
// character set @8bitscript/web/text's putChar accepts (space, 0-9, A-Z,
// a little punctuation, upper case only; see web-runtime.mjs's
// decodeScreenCode). Trimmed from the original's full 128-entry table to
// just the range this project's screen codes ever use.
//
// Each glyph is 8 bytes, one per row; bit x of a row byte is column x
// (bit 0 = leftmost pixel) — Hepper's own reference renderer reads it the
// same way.
const GLYPHS_32_95_HEX = '0000000000000000183c3c1818001800363600000000000036367f367f3636000c3e031e301f0c00006333180c6663001c361c6e3b336e000606030000000000180c0606060c1800060c1818180c060000663cff3c660000000c0c3f0c0c000000000000000c0c060000003f0000000000000000000c0c006030180c060301003e63737b6f673e000c0e0c0c0c0c3f001e33301c06333f001e33301c30331e00383c36337f3078003f031f3030331e001c06031f33331e003f3330180c0c0c001e33331e33331e001e33333e30180e00000c0c00000c0c00000c0c00000c0c06180c0603060c180000003f00003f0000060c1830180c06001e3330180c000c003e637b7b7b031e000c1e33333f3333003f66663e66663f003c66030303663c001f36666666361f007f46161e16467f007f46161e16060f003c66030373667c003333333f333333001e0c0c0c0c0c1e007830303033331e006766361e366667000f06060646667f0063777f7f6b63630063676f7b736363001c36636363361c003f66663e06060f001e3333333b1e38003f66663e366667001e33070e38331e003f2d0c0c0c0c1e003333333333333f0033333333331e0c006363636b7f7763006363361c1c3663003333331e0c0c1e007f6331184c667f001e06060606061e0003060c18306040001e18181818181e00081c36630000000000000000000000ff';

const GLYPHS = Buffer.from(GLYPHS_32_95_HEX, 'hex');

/**
 * The 8 row-bytes for an ASCII code in [32, 95], or `null` outside that
 * range — the same "blank cell" outcome web-runtime.mjs's
 * decodeScreenCode gives for a screen byte it doesn't recognize.
 * @param {number} code
 * @returns {Buffer | null}
 */
export function glyphRows(code) {
  if (code < 32 || code > 95) return null;
  const offset = (code - 32) * 8;
  return GLYPHS.subarray(offset, offset + 8);
}
