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

// The 2001's own character ROM, screen codes 0-127 — not a
// reimplementation like the table above, but a pixel-for-pixel capture of
// real VICE's xpet actually rendering them. The probe: a program that
// memory.write()s 0xE84C (viaPeripheralControl, text.8bs's own
// CharacterSet.TEXT) then 0-127 straight into screen RAM, `8bs run pet
// --screenshot` against it, decoded cell by cell from the PNG
// (packages/cli/src/png.mjs's pixelAt(), 8×8 per cell, the same
// left-to-right/top-to-bottom row-byte order as GLYPHS_32_122_HEX above).
// Measuring the emulator's own rendering sidesteps ever touching
// Commodore's ROM binary while still matching the real hardware exactly —
// there is no "close enough" font here, just what the reference emulator
// already draws. The $E84C write matters: without it the ROM boots into
// its graphics half, where 64-90 are box-drawing shapes, not the lower
// case letters text.8bs's own asciiToScreenCode() actually sends there on
// a swapped (2001) build — confirmed by probing both ways and finding 0-63
// identical either way but 64-90 only readable as letters in text mode.
//
// Indexed by the PET's own screen code, unlike GLYPHS_32_122_HEX's ASCII
// index — text.8bs's asciiToScreenCode() already did the ASCII-to-screen-
// code translation before a byte ever reaches this table, so a lookup
// here needs no glyphIndexFn of its own (see layoutForRealMachine in
// web-layout.mjs, which now just names this table by its font id instead).
// 128-255 (reverse video) is not captured — nothing writes it yet: reverse
// video is not wired into the web loader's paint() at all. This is the
// 2001's ROM specifically (`video.characterSetSwapped`) — every later
// model's own ROM (901447-10, PET_TEXT_SCREENCODE below) draws different
// shapes at some of these same codes.
const PET_2001_SCREENCODE_0_127_HEX = '3844526a320478001824427e424242003e44443c44443e0038440202024438001e24444444241e007e02021e02027e007e02021e0202020038440272424438004242427e4242420038101010101038007020202020221c004222120e122242000202020202027e0042665a5a4242420042464a526242420018244242422418003e42423e0202020018244242522458003e42423e122242003c42023c40423c007c101010101010004242424242423c0042424224241818004242425a5a664200424224182442420044444438101010007e40201804027e003c04040404043c0000020408102040003c20202020203c00001038541010101000000804fe04080000000000000000001010101000001000242424000000000024247e247e24240010781438503c100000462610086462000c12120c52225c002010080000000000201008080810200004081010100804001054387c385410000010107c1010000000000000001010080000007e00000000000000000018180000402010080402003c42625a46423c001018141010107c003c4240300c027e003c42403840423c00203028247e2020007e021e2040221c003804023e42423c007e422010080808003c42423c42423c003c42427c40201c000000100000100000000010000010100870180c060c18700000007e007e0000000e18306030180e003c4240300800080000000000ff00000000001c203c225c0002023a4642463a0000003c4202423c0040405c6242625c0000003c427e023c003048083e0808080000005c62625c403c02023a46424242001000181010103800200030202020221c020222120a162200181010101010380000006e929292920000003a464242420000003c4242423c0000003a46463a020200005c62625c404000003a460202020000007c023c403e0008083e08084830000000424242625c0000004242422418000000829292926c00000042241824420000004242625c403c00007e2018047e0010101010ff101010050a050a050a050a10101010101010103333cccc3333cccc3366cc993366cc9900000000000000000f0f0f0f0f0f0f0f00000000ffffffffff0000000000000000000000000000ff010101010101010155aa55aa55aa55aa80808080808080800000000055aa55aa99cc663399cc6633c0c0c0c0c0c0c0c010101010f010101000000000f0f0f0f010101010f0000000000000001f101010000000000000ffff00000000f010101010101010ff00000000000000ff101010101010101f10101003030303030303030707070707070707e0e0e0e0e0e0e0e0ffff000000000000ffffff00000000000000000000ffffff804022120a060200000000000f0f0f0ff0f0f0f000000000101010101f0000000f0f0f0f000000000f0f0f0ff0f0f0f0';
const PET_2001_SCREENCODE = Buffer.from(PET_2001_SCREENCODE_0_127_HEX, 'hex');

// Every non-2001 PET model's own character ROM (901447-10) — every model
// this catalog offers besides the 2001 shares this exact image, per
// text.8bs's own header comment ("Every later model's text set
// (901447-10)"), so one capture covers 3008/3016/3032/4016/4032/8032 and
// their business-keyboard twins alike, not just the model actually
// probed (4032, chosen only because it happens to be releaseTargets.pet's
// own default — the ROM itself does not vary by model). Same recipe as
// the 2001's own table above, right down to the $E84C write: without it
// codes 64-90 are the graphics half's box-drawing shapes rather than the
// lower-case letters this ROM's *text* half actually holds there, exactly
// as for the 2001 — confirmed the same way, by probing both and finding
// 0-63 identical either way but 64-90 only readable as letters in text
// mode. Screen codes 1-26 are lower case here and 65-90 already sit at
// their own ASCII value (the opposite assignment from the 2001's ROM,
// matching asciiToScreenCode()'s non-swapped branch) — verified glyph by
// glyph: code 1 draws 'a', code 65 draws 'A', not the reverse.
const PET_TEXT_SCREENCODE_0_127_HEX = '3844526a3204780000001c203c225c0002023a4642463a0000003c4202423c0040405c6242625c0000003c427e023c003048083e0808080000005c62625c403c02023a46424242001000181010103800200030202020221c020222120a162200181010101010380000006e929292920000003a464242420000003c4242423c0000003a46463a020200005c62625c404000003a460202020000007c023c403e0008083e08084830000000424242625c0000004242422418000000829292926c00000042241824420000004242625c403c00007e2018047e003c04040404043c0000020408102040003c20202020203c00001038541010101000000804fe04080000000000000000001010101000001000242424000000000024247e247e24240010781438503c100000462610086462000c12120c52225c002010080000000000201008080810200004081010100804001054387c385410000010107c1010000000000000001010080000007e00000000000000000018180000402010080402003c42625a46423c001018141010107c003c4240300c027e003c42403840423c00203028247e2020007e021e2040221c003804023e42423c007e422010080808003c42423c42423c003c42427c40201c000000100000100000000010000010100870180c060c18700000007e007e0000000e18306030180e003c4240300800080000000000ff0000001824427e424242003e44443c44443e0038440202024438001e24444444241e007e02021e02027e007e02021e0202020038440272424438004242427e4242420038101010101038007020202020221c004222120e122242000202020202027e0042665a5a4242420042464a526242420018244242422418003e42423e0202020018244242522458003e42423e122242003c42023c40423c007c101010101010004242424242423c0042424224241818004242425a5a664200424224182442420044444438101010007e40201804027e0010101010ff101010050a050a050a050a10101010101010103333cccc3333cccc3366cc993366cc9900000000000000000f0f0f0f0f0f0f0f00000000ffffffffff0000000000000000000000000000ff010101010101010155aa55aa55aa55aa80808080808080800000000055aa55aa99cc663399cc6633c0c0c0c0c0c0c0c010101010f010101000000000f0f0f0f010101010f0000000000000001f101010000000000000ffff00000000f010101010101010ff00000000000000ff101010101010101f10101003030303030303030707070707070707e0e0e0e0e0e0e0e0ffff000000000000ffffff00000000000000000000ffffff804022120a060200000000000f0f0f0ff0f0f0f000000000101010101f0000000f0f0f0f000000000f0f0f0ff0f0f0f0';
const PET_TEXT_SCREENCODE = Buffer.from(PET_TEXT_SCREENCODE_0_127_HEX, 'hex');

// The VIC-20's own character ROM (chargen-901460-03.bin), "text" set,
// screen codes 0-127. Not a screenshot capture like the two PET tables
// above — read directly out of the real ROM binary VICE ships
// (opt/homebrew/.../share/vice/VIC20/chargen-901460-03.bin, 4096 bytes:
// the first 2048 are the "unshifted" graphics/uppercase set, the second
// 2048 — offset here — the "shifted" text set), so there is no screenshot
// alignment to get wrong at all, just an offset and a byte count. The
// earlier attempt at this same table (VIC-20's own 2x-scaled, non-black
// screenshot defeated automated grid detection) was abandoned for that
// reason; reading the ROM directly sidesteps the whole problem.
//
// Every byte here is bit-reversed from the ROM's own raw bytes. The 6560
// reads a chargen byte MSB-first (bit 7 = leftmost pixel) — confirmed by
// eye against the real chip's own output — but this file's own bit
// convention, and Hepper's font8x8_basic GLYPHS_32_122_HEX above, is
// bit 0 = leftmost (see that table's header). Missing this the first
// time shipped a table where every symmetric letter (H, o, W, !) looked
// right by accident and every asymmetric one (e, l, r, d, ...) rendered
// as its own mirror image — reported live as "Hello World!" reading
// "H <backward e> <backward l>...", a backward 'd' looking like a 'b'.
// Cross-checked
// against PET_TEXT_SCREENCODE_0_127_HEX above once reversed: the two ROMs
// agree on all but 7 of 1024 bytes (all 7 at screen code 28, a symbol
// with no letter shape to compare), which is the real, independent
// confirmation that the bit order below is the right one this time —
// the *unreversed* bytes matched PET on barely half.
//
// Screen-code layout confirmed glyph by glyph the same way the PET
// tables were: code 1 draws 'a', code 65 draws 'A' — lower case at 1-26,
// upper case at its own ASCII value, matching text.8bs's own
// asciiToScreenCode() comment and packages/vic20/text.8bs's non-swapped
// scheme (the VIC-20 has no swapped model the way the PET 2001 does).
// 128-255 (reverse video) is not captured, same open gap as the PET's own
// tables — nothing writes it yet.
const VIC20_TEXT_SCREENCODE_0_127_HEX = '3844526a3204780000001c203c225c0002023a4642463a0000003c4202423c0040405c6242625c0000003c427e023c003048083e0808080000005c62625c403c02023a46424242001000181010103800200030202020221c020222120a162200181010101010380000006e929292920000003a464242420000003c4242423c0000003a46463a020200005c62625c404000003a460202020000007c023c403e0008083e08084830000000424242625c0000004242422418000000829292926c00000042241824420000004242625c403c00007e2018047e003c04040404043c003008083c080e76003c20202020203c00001038541010101000000804fe04080000000000000000001010101000001000242424000000000024247e247e24240010781438503c100000462610086462000c12120c52225c002010080000000000201008080810200004081010100804001054387c385410000010107c1010000000000000001010080000007e00000000000000000018180000402010080402003c42625a46423c001018141010107c003c4240300c027e003c42403840423c00203028247e2020007e021e2040221c003804023e42423c007e422010080808003c42423c42423c003c42427c40201c000000100000100000000010000010100870180c060c18700000007e007e0000000e18306030180e003c4240300800080000000000ff0000001824427e424242003e44443c44443e0038440202024438001e24444444241e007e02021e02027e007e02021e0202020038440272424438004242427e4242420038101010101038007020202020221c004222120e122242000202020202027e0042665a5a4242420042464a526242420018244242422418003e42423e0202020018244242522458003e42423e122242003c42023c40423c007c101010101010004242424242423c0042424224241818004242425a5a664200424224182442420044444438101010007e40201804027e0010101010ff101010050a050a050a050a10101010101010103333cccc3333cccc3366cc993366cc9900000000000000000f0f0f0f0f0f0f0f00000000ffffffffff0000000000000000000000000000ff010101010101010155aa55aa55aa55aa80808080808080800000000055aa55aa99cc663399cc6633c0c0c0c0c0c0c0c010101010f010101000000000f0f0f0f010101010f0000000000000001f101010000000000000ffff00000000f010101010101010ff00000000000000ff101010101010101f10101003030303030303030707070707070707e0e0e0e0e0e0e0e0ffff000000000000ffffff00000000000000000000ffffff804022120a060200000000000f0f0f0ff0f0f0f000000000101010101f0000000f0f0f0f000000000f0f0f0ff0f0f0f0';
const VIC20_TEXT_SCREENCODE = Buffer.from(VIC20_TEXT_SCREENCODE_0_127_HEX, 'hex');

/**
 * A future machine with its own selectable charset — or a different
 * KERNAL/ROM revision entirely — extends the same way: its own probe
 * program (or, when the ROM ships as a plain binary, a direct read of
 * it), its own named table here, and its own `font` id in
 * web-layout.mjs's REAL_MACHINE_LAYOUT. Nothing about this mechanism is
 * PET-specific past the tables above.
 */
const NAMED_FONTS = {
  'pet-2001-screencode': (code) => (code >= 0 && code <= 127 ? PET_2001_SCREENCODE.subarray(code * 8, code * 8 + 8) : null),
  'pet-text-screencode': (code) => (code >= 0 && code <= 127 ? PET_TEXT_SCREENCODE.subarray(code * 8, code * 8 + 8) : null),
  'vic20-text-screencode': (code) => (code >= 0 && code <= 127 ? VIC20_TEXT_SCREENCODE.subarray(code * 8, code * 8 + 8) : null),
};

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
 * those ranges — a blank cell in both renderers. `font`, when it names one
 * of NAMED_FONTS (a real machine's own screen-code-indexed table — see
 * layoutForRealMachine in web-layout.mjs), is tried first; falling through
 * to the shared ASCII table below is what every skin used before any
 * NAMED_FONTS entry existed, so an unrecognized or absent font id, or a
 * code that table has nothing for, still draws exactly as it always has.
 * @param {number} code
 * @param {string} [font]
 * @returns {Buffer | null}
 */
export function glyphRows(code, font) {
  const named = font && NAMED_FONTS[font]?.(code);
  if (named) return named;
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
 * omitted — a missing code is a blank cell. `font` selects a NAMED_FONTS
 * table the same way glyphRows() does; left out, this is the shared ASCII
 * table every skin drew before any NAMED_FONTS entry existed.
 * @param {string} [font]
 */
export function glyphTableLiteral(font) {
  const entries = [];
  for (let c = 0; c < 256; c += 1) {
    const rows = glyphRows(c, font);
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
