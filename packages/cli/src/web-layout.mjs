// The web target's screen layout, palette, and input mapping: the facts both
// the browser page and the headless --screenshot rasterizer have to agree on,
// in one place neither of them owns.
//
// This module is deliberately dependency-free and side-effect-free. Everything
// in it is either a constant that gets interpolated into generated JavaScript
// (web-loader.mjs) or a pure function that gets unit-tested here and *also*
// interpolated into that JavaScript. A rule that lives only inside a template
// string is a rule nothing can test; see swipeEdge() and borderFor() below.
//
// Grid size is a property of the build: the default host is 48×27 (384×216,
// exact 16:9). Machine skins (pet-2001, c64, vic20) pass a different cols/rows
// into agreementFor() and write the result next to the wasm as program.json
// so one loader serves every binary.

// The C64's palette (0-15), reused so a color number means the same thing
// in every 8BitScript example, on whichever machine it runs on. See the
// header comment on @8bitscript/web/screen's setColors() for why the web target
// borrows this rather than defining its own.
export const C64_PALETTE = [
  '#000000', '#ffffff', '#883932', '#67b6bd',
  '#8b3f96', '#55a049', '#40318d', '#bfce72',
  '#8b5429', '#574200', '#b86962', '#505050',
  '#787878', '#94e089', '#7869c4', '#9f9f9f',
];

// VERA's default palette, entries 0-15. The numbering and the names are the
// C64's (black, white, red, cyan, purple, green, blue, yellow, orange, brown,
// light red, dark grey, grey, light green, light blue, light grey), but the
// colours are VERA's own, twelve bits each ($RGB, every nibble n -> n * 17):
// blue is $00A = #0000aa here, not the C64's #40318d. Read back from an
// x16emu capture of the border, which is exactly #0000aa (BorderColor.BLUE).
// VERA has no other source: the Commander X16 Programmer's Reference lists
// these as the power-on values of palette entries 0-15.
const VERA_DEFAULT_12BIT = [
  0x000, 0xfff, 0x800, 0xafe, 0xc4c, 0x0c5, 0x00a, 0xee7,
  0xd85, 0x640, 0xf77, 0x333, 0x777, 0x8f6, 0x08f, 0xbbb,
];
export const VERA_PALETTE = VERA_DEFAULT_12BIT.map((rgb) => {
  const channel = (shift) => (((rgb >> shift) & 15) * 17).toString(16).padStart(2, '0');
  return `#${channel(8)}${channel(4)}${channel(0)}`;
});

// PET 2001 green phosphor on black. Index 0 is the screen; 1 is the ink.
// The rest copy 1 so a color byte `& 15` still lands on green when a program
// writes a C64-named color through text.setColor — the host ignores per-cell
// color on this skin (`colorPerCell: false`) and paints with 0/1 only.
export const PET_GREEN = '#55ff55';
export const PET_PALETTE = [
  '#000000', PET_GREEN, PET_GREEN, PET_GREEN,
  PET_GREEN, PET_GREEN, PET_GREEN, PET_GREEN,
  PET_GREEN, PET_GREEN, PET_GREEN, PET_GREEN,
  PET_GREEN, PET_GREEN, PET_GREEN, PET_GREEN,
];

// VIC-20 numbering is the same eight shared names as every machine's
// BorderColor (packages/vic20/src/screen.8bs). Hex is the MOS 6560/6561
// palette as Colodore publishes it — the same source VICE's default VIC-20
// colours follow — so a TextColor.RED cell is the VIC's red, not the C64's.
export const VIC20_PALETTE = [
  '#000000', '#ffffff', '#782922', '#87d6dd',
  '#aa5fb6', '#55a049', '#40318d', '#bfce72',
  '#aa7449', '#e99d7f', '#de7c6b', '#c9ffff',
  '#e99df5', '#94e089', '#8071cc', '#fffffe',
];

export const COLORS = C64_PALETTE;

export const CHAR_W = 8;
export const CHAR_H = 8;
export const CHAR_BASE = 2;

// ---- the Modern host's moving grid ----------------------------------------
//
// Modern is the one grid on this target that changes shape while a program
// runs, so its map is sized for the largest grid it will ever hand out rather
// than for the current one — see packages/web/src/geometry.8bs, which has to
// agree with every number here.
export const MAX_COLUMNS = 64;
export const MAX_ROWS = 64;
export const MAX_CELLS = MAX_COLUMNS * MAX_ROWS;
export const RESIZABLE_CHAR_BASE = 4;
export const COLUMNS_OFFSET = 2;
export const ROWS_OFFSET = 3;

// A grid small enough that 2048's four-tile board cannot be laid out at all is
// not a better answer than one that letterboxes, so the shape follows the
// window only between these.
export const MIN_COLUMNS = 24;
export const MIN_ROWS = 18;

// ---- the per-scanline raster list -----------------------------------------
//
// Right after HOST_OFFSET: one control byte (the renderer applies the list
// while it is nonzero), one count byte, then RASTER_MAX_ENTRIES three-byte
// entries — the line's low byte, the slot byte, the value — the same four
// slots @8bitscript/raster names (BORDER 0, BACKGROUND 1, SCROLL_X 2, CHARSET 3). The
// slot byte's bit 7 carries the line's ninth bit: the resizable Modern host
// hands out up to MAX_ROWS (64) rows, 512 picture lines, and a single line
// byte stops at 255 — the slots only need the low bits, so the ninth bit
// rides there and the format stays three bytes wide with every offset in
// place. Written by packages/web/src/rasterline.8bs, read fresh at every
// paint by both renderers (web-scanline.mjs and the loader's inlined copy
// of it). packages/web/src/geometry.8bs and its skin twins mirror the
// offsets and have to agree.
export const RASTER_MAX_ENTRIES = 64;
export const RASTER_ENTRY_SIZE = 3;

// ---- the redefinable glyph table ------------------------------------------
//
// GLYPH_COUNT glyphs of eight row bytes each, right after the raster list:
// the synthetic web hosts draw a cell whose character code is in
// [GLYPH_FIRST, GLYPH_FIRST + GLYPH_COUNT) from these bytes when any of its
// eight rows is nonzero (bit 0 the leftmost pixel, as every font here), and
// from the font as before when all eight are zero — so an untouched table
// changes nothing and a program that never writes it pays nothing. The
// range sits in the gap the font leaves: 128-143 are the quadrant blocks,
// 144-147 the corner masks, 0xA9 the copyright sign. A real machine's own
// web build (pet, vic20, c64 through --web) has no table: its codes are its
// own ROM's screen codes. packages/web/src/geometry.8bs and its skin twins
// mirror these numbers and have to agree.
export const GLYPH_FIRST = 176;
export const GLYPH_COUNT = 80;
export const GLYPH_ROW_BYTES = 8;
export const GLYPH_BYTES = GLYPH_COUNT * GLYPH_ROW_BYTES;

// ---- the tone registers ---------------------------------------------------
//
// AUDIO_BYTES bytes right after the glyph table (or after the raster list on
// a host with no table), one voice's worth of chip: GATE (nonzero while the
// voice sounds), NOTE (the @8bitscript/audio / .8ba index, octave * 12 +
// semitone, C0 = 0, A4 = 57), WAVE (0 square, 1 triangle, 2 sawtooth) and
// VOLUME (0-15). The synthetic web hosts' page plays them through the Web
// Audio API, one oscillator, read at every paint just as the raster list is;
// web-audio.mjs is the pure reference of what that is (frequency, waveform,
// level) and renders it to samples for the tests, since a headless run has no
// speaker to hear. A real machine's own --web build has no region: its sound
// is its chip's. packages/audio/src/index.web.8bs writes it and
// packages/web/src/geometry.8bs and its skin twins mirror the numbers.
export const AUDIO_BYTES = 4;
export const AudioRegister = { GATE: 0, NOTE: 1, WAVE: 2, VOLUME: 3 };

/**
 * The eight row bytes of a user-defined glyph, or null when `code` is not in
 * the table's range or its eight rows are all zero (an undefined glyph: the
 * font draws the cell as it always has). Pure and dependency-free so the
 * browser loader can carry a copy of it (web-loader.mjs interpolates this
 * function's source) and the headless rasterizer calls it directly.
 *
 * @param {Uint8Array} mem the program's memory
 * @param {number} glyphBase the table's first byte, or a negative number for a host with no table
 * @param {number} code the cell's character code
 * @returns {Uint8Array | null}
 */
export function userGlyph(mem, glyphBase, code) {
  if (glyphBase < 0 || code < GLYPH_FIRST || code >= GLYPH_FIRST + GLYPH_COUNT) return null;
  const at = glyphBase + (code - GLYPH_FIRST) * GLYPH_ROW_BYTES;
  const rows = mem.subarray(at, at + GLYPH_ROW_BYTES);
  for (let i = 0; i < GLYPH_ROW_BYTES; i += 1) {
    if (rows[i] !== 0) return rows;
  }
  return null;
}

// Hold the cell COUNT roughly constant and let the window decide the shape.
// Text then stays the same fraction of the screen whatever the screen is: a
// phone and a 4K monitor showing the same shape get the same grid, so a
// layout does not get denser as the display gets bigger.
export const TARGET_CELLS = 1296;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * The grid for a box of `width`x`height`. 16:9 gives back exactly 48x27 —
 * the grid this host has always had — so nothing about a landscape desktop
 * changes; 9:16 gives 27x48, and 4:3 gives 42x31.
 *
 * An unmeasured box is not a shape, it is a box that has not been laid out
 * yet: that gets the default grid rather than a guess.
 *
 * @param {{ width?: number, height?: number }} [box]
 */
export function gridFor({ width, height } = {}) {
  if (!(width > 0) || !(height > 0)) return { cols: 48, rows: 27 };
  const cols = clamp(Math.round(Math.sqrt(TARGET_CELLS * (width / height))), MIN_COLUMNS, MAX_COLUMNS);
  const rows = clamp(Math.round(TARGET_CELLS / cols), MIN_ROWS, MAX_ROWS);
  return { cols, rows };
}

/**
 * Memory-map and canvas facts for one grid. `COLOR_BASE = 2 + cols*rows`,
 * then color RAM of the same length, then INPUT_OFFSET, then HOST_OFFSET.
 *
 * A `resizable` host is mapped for MAX_CELLS instead, with the live grid in
 * two bytes ahead of the character region: the offsets then stay put when the
 * grid changes, and `cols` is the only thing that moves.
 *
 * @param {{ cols?: number, rows?: number, palette?: string[], aspect?: string, colorPerCell?: boolean, font?: string, resizable?: boolean, pixelAspect?: number }} [options]
 */
export function agreementFor({
  cols = 48,
  rows = 27,
  palette = C64_PALETTE,
  aspect = '16/9',
  colorPerCell = true,
  font = 'font8x8',
  resizable = false,
  // How much wider than tall one drawn pixel is, physically — 1 for a
  // host with no chip to be unfaithful to (the default web target) or a
  // real machine whose own pixel shape has not been measured yet. Real
  // hardware whose dot clock is not a clean multiple of its own CPU
  // clock (the VIC-20's, unlike the C64's) draws non-square pixels on a
  // real screen; `aspect` alone (the outer picture's shape) says nothing
  // about that — see REAL_MACHINE_LAYOUT.vic20's own header for the
  // measurement and web-loader.mjs's fit() for where this actually
  // stretches anything.
  pixelAspect = 1,
  // The synthetic web hosts carry the redefinable glyph table after the
  // raster list; a real machine's own build does not (its codes are its ROM's).
  userGlyphs = false,
  // And the tone registers after those: the synthetic hosts again.
  audio = false,
} = {}) {
  const cells = cols * rows;
  const charBase = resizable ? RESIZABLE_CHAR_BASE : CHAR_BASE;
  const region = resizable ? MAX_CELLS : cells;
  const colorBase = charBase + region;
  const inputOffset = colorBase + region;
  const hostOffset = inputOffset + 1;
  const rasterControlOffset = hostOffset + 1;
  const rasterCountOffset = hostOffset + 2;
  const rasterBase = hostOffset + 3;
  // One past the last byte the agreement uses: the wasm backend places the
  // program's own data section at or above this (dataBaseFor() in
  // packages/compiler/src/wasm/index.ts), so a register the page writes
  // can never land on a string the program reads.
  const rasterEnd = rasterBase + RASTER_MAX_ENTRIES * RASTER_ENTRY_SIZE;
  const glyphBase = userGlyphs ? rasterEnd : -1;
  const glyphEnd = userGlyphs ? rasterEnd + GLYPH_BYTES : rasterEnd;
  const audioBase = audio ? glyphEnd : -1;
  const reservedEnd = audio ? glyphEnd + AUDIO_BYTES : glyphEnd;
  return {
    cols,
    rows,
    resizable,
    charWidth: CHAR_W,
    charHeight: CHAR_H,
    innerWidth: cols * CHAR_W,
    innerHeight: rows * CHAR_H,
    charBase,
    colorBase,
    inputOffset,
    hostOffset,
    rasterControlOffset,
    rasterCountOffset,
    rasterBase,
    glyphBase,
    glyphFirst: GLYPH_FIRST,
    glyphCount: GLYPH_COUNT,
    audioBase,
    reservedEnd,
    rasterMaxEntries: RASTER_MAX_ENTRIES,
    columnsOffset: COLUMNS_OFFSET,
    rowsOffset: ROWS_OFFSET,
    maxCols: MAX_COLUMNS,
    maxRows: MAX_ROWS,
    palette: [...palette],
    aspect,
    colorPerCell,
    font,
    pixelAspect,
  };
}

export const DEFAULT_LAYOUT = agreementFor({ userGlyphs: true, audio: true });

export const GRID_COLS = DEFAULT_LAYOUT.cols;
export const GRID_ROWS = DEFAULT_LAYOUT.rows;
export const INNER_W = DEFAULT_LAYOUT.innerWidth;
export const INNER_H = DEFAULT_LAYOUT.innerHeight;
export const COLOR_BASE = DEFAULT_LAYOUT.colorBase;
export const INPUT_OFFSET = DEFAULT_LAYOUT.inputOffset;
export const HOST_OFFSET = DEFAULT_LAYOUT.hostOffset;

/**
 * The HOST_OFFSET byte, bit by bit. Zero is a desktop with a mouse and a
 * keyboard — what a screenshot host (no navigator, no page) writes, so
 * every bit says how a host *differs* from that, never what it has.
 *
 *   TOUCH        bit 0: this host is a touchscreen (`input.touch()`).
 *   NO_KEYBOARD  bit 1: nothing to press arrows on — a phone or a tablet
 *                held in the hands (`input.keyboard()` is false). Set at
 *                start-up by hostHasKeyboard() below, and cleared for good
 *                by the first real key the page sees.
 */
export const HostStatus = {
  TOUCH: 1,
  NO_KEYBOARD: 2,
};

/**
 * Host look (aspect, font id, palette) per `machine` catalog value.
 * Facts (columns, colorPerCell) live in packages/web/package.json; this is
 * only what the canvas needs that `#fact` does not name.
 */
export const MACHINE_HOST = {
  // Modern is the only one that resizes. A skin is a machine, and a machine's
  // screen is the size its video chip makes it.
  hifi: { aspect: '16/9', font: 'font8x8', palette: C64_PALETTE, resizable: true },
  'pet-2001': { aspect: '4/3', font: 'pet', palette: PET_PALETTE },
  c64: { aspect: '4/3', font: 'font8x8', palette: C64_PALETTE },
  vic20: { aspect: '4/3', font: 'font8x8', palette: VIC20_PALETTE },
};

/**
 * Layout for a resolved hardware object (or its facts + machine option).
 *
 * @param {{ facts?: object, options?: { machine?: string } } | object} hardwareOrFacts
 */
export function layoutFromHardware(hardwareOrFacts = {}) {
  const facts = hardwareOrFacts.facts ?? hardwareOrFacts;
  const machine = hardwareOrFacts.options?.machine ?? 'hifi';
  const host = MACHINE_HOST[machine] ?? MACHINE_HOST.hifi;
  return agreementFor({
    cols: facts['video.columns'] ?? DEFAULT_LAYOUT.cols,
    rows: facts['video.rows'] ?? DEFAULT_LAYOUT.rows,
    palette: host.palette,
    aspect: host.aspect,
    colorPerCell: facts['video.colorPerCell'] !== false,
    font: host.font,
    resizable: host.resizable === true,
    userGlyphs: true,
    audio: true,
  });
}

/**
 * Where a real machine's own wasm build (pet, vic20, c64 built through
 * `--web` — run.mjs's `buildForWeb`) actually keeps screen memory, and how
 * to turn a raw screen byte into the shared bitmap font's own index.
 *
 * `layoutFromHardware()` above computes `charBase`/`colorBase` from grid
 * size because the *synthetic* target's own `.8bs` source
 * (`packages/web/src/geometry.8bs`) was written to match that math — every
 * skin it builds, `pet-2001` included, is a from-scratch reimplementation
 * that already writes ASCII-shaped codes there. A real machine's own
 * package was written against its actual hardware's memory map instead
 * (`packages/pet/src/text.8bs` writes `memory.write(0x8000 + cell, ...)`,
 * a fact nowhere in the hardware catalog — it's PET's KERNAL's own screen
 * address, not a build option), so that math would just read whichever
 * unwritten bytes happen to sit at the *synthetic* offset. Confirmed the
 * hard way: the first real run painted a blank screen, because nothing at
 * `agreementFor()`'s computed `charBase` (~8192) was ever written — the
 * program's actual text sat 24KB further on, at $8000.
 *
 * Which ROM a build's screen bytes actually mean is not itself fixed on
 * the PET: `packages/pet/src/text.8bs`'s own `asciiToScreenCode()`
 * branches on `#fact(video.characterSetSwapped)` (true only for the 2001,
 * the catalog's own `model` option) — swapped, upper case moves down to
 * 1-26 and lower case sits at 65-90; non-swapped (every later model,
 * ROM 901447-10), the opposite assignment, lower case at 1-26 and upper
 * case already at its own ASCII value. `font8x8.mjs`'s
 * `pet-2001-screencode` and `pet-text-screencode` tables are captures of
 * those two ROMs (real VICE, screenshotted, decoded pixel by pixel — see
 * that file's own header), each indexed by the PET's own screen code, so
 * a lookup here needs no translation function of its own either way —
 * `font` alone is enough. Getting the swapped/non-swapped choice wrong
 * doesn't blank the screen (unlike charBase) — it draws real glyphs, just
 * the wrong ones, which is a worse failure to ship unnoticed.
 *
 * Reverse video (bit 7, PET's own `toScreen()` ORs it into the *screen
 * code itself*, not a separate color byte the way the synthetic target's
 * `text.setReverse` does) is drawn the way the machine draws it: the glyph
 * of `code − 128` with every pixel inverted (font8x8.mjs's
 * withReverseVideo()). Both ROM sets of each machine carry it.
 *
 * Which of a machine's two sets is live is the machine's own register, read
 * from the program's memory each frame (`charsetSwitch`): the PET's VIA
 * control register and the VIC-20's memory pointer. A raster list's
 * Slot.CHARSET entry still overrides it on the lines it names.
 */
const PET_CHARSET_SWITCH = { register: 0xe84c, mask: 0x02 }; // PCR 12 = graphics, 14 = text
const VIC20_CHARSET_SWITCH = { register: 0x9005, mask: 0x0e }; // low nybble 0 = $8000 upper, 2 = $8800 lower

const REAL_MACHINE_LAYOUT = {
  pet: {
    palette: PET_PALETTE,
    colorPerCell: false,
    aspect: '4/3',
    // PET has no separate color RAM — one past the screen is unwritten by
    // every program, so the colour byte always reads 0. Reverse video is not
    // the colour byte's bit 7 here but the screen code's own (the font
    // tables carry it; see the header comment above).
    memoryFor: (cells) => ({ charBase: 0x8000, colorBase: 0x8000 + cells }),
    // The set the machine boots in is graphics and upper case; the VIA's
    // peripheral control register ($E84C, PCR) names the other: 12 is
    // graphics, 14 text — bit 1 is the one that differs (the POKE 59468,14 of
    // every PET manual, text.8bs's CharacterSet.TEXT). So `font` is the
    // graphics set, `fontAlt` the text set, and the page reads PCR bit 1 each
    // frame the way the video circuit does. The 2001 has its own ROM (the
    // swapped one text.8bs's asciiToScreenCode() knows about).
    glyphsFor: (facts) => (facts['video.characterSetSwapped']
      ? { font: 'pet-2001-graphics-screencode', fontAlt: 'pet-2001-screencode', charsetSwitch: PET_CHARSET_SWITCH }
      : { font: 'pet-graphics-screencode', fontAlt: 'pet-text-screencode', charsetSwitch: PET_CHARSET_SWITCH }),
  },
  vic20: {
    palette: VIC20_PALETTE,
    colorPerCell: true,
    aspect: '4/3',
    // The VIC-20's screen moves with its own memory, not with anything
    // this function computes: unexpanded (and 3K, which only fills in
    // below it) keeps the KERNAL's stock $1E00/$9600; 8K and up, the
    // KERNAL relocates both down to $1000/$9400 so BASIC RAM stays one
    // contiguous run above it (packages/vic20/src/geometry.8bs's own
    // header has the full reasoning). `expanded` is the exact tag that
    // file's own `.expanded` twin resolves on, read here from the same
    // `hardware.tags` a build already carries — real color RAM, at its
    // own hardware address, not the PET's "one past the screen" fiction.
    memoryFor: (cells, hardware) => (hardware.tags?.includes('expanded')
      ? { charBase: 0x1000, colorBase: 0x9400 }
      : { charBase: 0x1e00, colorBase: 0x9600 }),
    // The VIC-20's own character ROM (chargen-901460-03.bin's "text"
    // set), read directly out of VICE's own ROM binary — no screenshot
    // alignment needed at all, unlike the PET captures, so the earlier
    // abandoned attempt (2x scaling and a non-black background defeated
    // automated grid detection) never needed retrying. Falling back to
    // the shared ASCII font instead of this table was a real bug, not
    // just lower fidelity: text.8bs writes screen codes (lower case at
    // 1-26), and the shared font is ASCII-indexed, so every lower-case
    // letter looked up the wrong glyph — only upper case and a few
    // symbols happened to land on the same code in both schemes (exactly
    // what showed up as "Hello World!" losing every lower-case letter).
    // The 6560 boots in the upper case and graphics set ($8000, low nybble 0
    // of $9005) — text.8bs stores MEMORY_POINTER_UPPERCASE there itself —
    // and the lower/upper case set sits at $8800 (nybble 2). The page reads
    // $9005 each frame; nybbles 1 and 3 name the ROM's reversed copies, which
    // the table already holds as codes 128-255 (the "…-upper" set above and
    // the text set both invert), so they draw as their neighbour and an
    // unmapped nybble (4 and up reads the chip's own registers) is not
    // modelled.
    glyphsFor: () => ({ font: 'vic20-upper-screencode', fontAlt: 'vic20-text-screencode', charsetSwitch: VIC20_CHARSET_SWITCH }),
    // NTSC only (6560; facts['video.frameRate'] === 60) — PAL's 6561 runs
    // a different cycles-per-line count (71, not 65) this project has not
    // measured, so it keeps square pixels rather than guessing.
    //
    // The 6560 draws one pixel every 3.5 of its own 14.31818MHz clock
    // (a character cell is 28 of that clock, 8 pixels wide: 28/8 = 3.5),
    // and the *whole* video signal it draws in one line — border and all,
    // 702 of those clocks — is what a real, unmodified TV stretches to
    // fill its own screen. 252 of the 261 lines a frame draws are
    // likewise the whole vertical picture, border included (9 lines are
    // VBLANK). So the pixel aspect a real TV shows is
    //
    //   (252 lines / (702 clocks / 3.5 clocks-per-pixel)) * (4/3 CRT shape)
    //   = (252 / 200.57) * (4/3) ≈ 1.68
    //
    // measured from the 6560's own timing (brawn.org's "6560 Video
    // Information", cross-checked against the VIC-20 community's own
    // long-established 5:3 (1.667) approximation for this exact number —
    // agreement to within 1% is what says this is the real chip's shape,
    // not a guess). This project's own renderer draws every machine with
    // square pixels today (web-loader.mjs's fit() scales width and height
    // by the same factor), which is a real gap, not a lower-fidelity
    // choice: it is why this preview's text reads squarer/more "normal"
    // than a real VIC-20's own visibly wide, stretched characters.
    pixelAspectFor: (facts) => (facts['video.frameRate'] === 60 ? 5 / 3 : 1),
    // The border and the background are one packed register on the 6560/6561
    // ($900F: border in bits 0-2, background in bits 4-7, bit 3 normal
    // video), so the page reads them from the program's own memory, as it
    // does the C64's two. Bit 3 (reverse) is not modelled: the page draws
    // normal video whatever it holds. Until a program writes the register it
    // reads 0: a black border and a black background.
    // (Which of the two character sets is live is `charsetSwitch` above: $9005.)
    packedRegisters: { colorRegister: 0x900f, borderMask: 0x07, backgroundShift: 4 },
  },
  // The X16's VERA VRAM is not part of the CPU's address space at all —
  // even real hardware reaches it only through a stateful address port
  // (packages/cx16/src/index.8bs), which the wasm backend has no model
  // of (memory.write is a flat, side-effect-free i32.store8 — see
  // packages/compiler/src/wasm/lower.ts). So unlike pet/vic20 above,
  // there is no real fixed address to substitute for the synthetic one:
  // packages/cx16/src/text.cx16.web.8bs and screen.cx16.web.8bs (the
  // `.web` twins this build actually links) write a flat two-plane
  // screen at agreementFor()'s own default charBase/colorBase instead —
  // the same scheme the synthetic web target's own skins use, there
  // being no real address to be faithful to either way. memoryFor is a
  // deliberate no-op: the geometry this function already computed below
  // is exactly where those twins put it.
  // The C64's chips are bytes of the program's own memory on this rail, and
  // the page reads the ones it needs from where a real VIC-II would: the screen
  // matrix at $E000 and colour RAM at $D800 (packages/c64/src/geometry.8bs),
  // the border and background at $D020/$D021, the horizontal fine scroll at
  // $D016, which of the character RAM's two sets is live at $D018 bit 1, and
  // every glyph out of the character RAM — eight bytes a glyph, bit 7 the
  // leftmost pixel — which the web twin of setupVideo() fills with the
  // character ROM and a program redefines with @8bitscript/c64/charset. The
  // RAM is at $A000 here, not the machine's $D000: that is under the I/O area
  // on the machine and the chips' own registers in flat memory
  // (packages/c64/src/geometry.c64.web.8bs says why). So
  // there is no font id here: the glyphs a cell draws are whatever the program
  // holds, reversed copies (codes 128-255) included. Not modelled yet, and said
  // so in packages/c64/AGENTS.md: sprites, bitmap and multicolour modes, ECM,
  // the 38-column/24-row windows, the screen's position within its bank (the
  // screen is always $E000), and the VIC bank itself.
  c64: {
    palette: C64_PALETTE,
    colorPerCell: true,
    aspect: '4/3',
    memoryFor: () => ({ charBase: 0xe000, colorBase: 0xd800 }),
    // Memory the page reads that no pinned global names: the character RAM,
    // which the web twin of setupVideo() fills and a program redefines. The
    // backend refuses a build whose data would reach into it.
    reservedRanges: [{ start: 0xa000, end: 0xb000, label: "the C64's character RAM" }],
    vic: {
      charsetBase: 0xa000,
      setStride: 0x800,
      selectRegister: 0xd018,
      selectMask: 0x02,
      borderRegister: 0xd020,
      backgroundRegister: 0xd021,
      scrollRegister: 0xd016,
      // The eight sprites (web-vic.mjs): their registers $D000-$D02E, the
      // pointers at screen + $3F8, the shape blocks in VIC bank 3 ($C000 + 64 *
      // pointer), and raster.8bs's list — the live page ($0200 or $0300) named
      // by the byte at $02FF, its end by the byte at $02FC.
      spriteRegs: 0xd000,
      spritePointers: 0xe3f8,
      spriteBank: 0xc000,
      listLivePage: 0x02ff,
      listEnd: 0x02fc,
    },
  },
  cx16: {
    palette: VERA_PALETTE, // the C64's names in the C64's order, but VERA's own colours
    colorPerCell: true,
    aspect: '4/3',
    // The redefinable glyph table (codes 176-255) after the raster list, as the
    // synthetic web target has it: there is no VERA to hold tile data on this
    // rail, so a picture (@8bitscript/graphics) is drawn as a glyph in this
    // table — packages/graphics/src/index.cx16.web.8bs.
    userGlyphs: true,
    memoryFor: () => ({}),
  },
};

/**
 * @param {string} target a real machine's own name (`pet`, `vic20`, `c64`,
 *   `cx16`), never the literal `'web'` — that stays on
 *   `layoutFromHardware()`.
 * @param {{ facts?: object }} hardware
 */
export function layoutForRealMachine(target, hardware = {}) {
  const facts = hardware.facts ?? {};
  const real = REAL_MACHINE_LAYOUT[target];
  const cols = facts['video.columns'] ?? DEFAULT_LAYOUT.cols;
  const rows = facts['video.rows'] ?? DEFAULT_LAYOUT.rows;
  const pixelAspect = real?.pixelAspectFor?.(facts) ?? 1;
  // A measured pixelAspect replaces the flat `aspect` guess with the
  // shape that grid actually draws once each pixel is pixelAspect times
  // wider than tall — real.aspect (a guess, same '4/3' every machine
  // here happens to share) only survives for a machine with no
  // measurement yet.
  const aspect = pixelAspect !== 1 ? `${cols * CHAR_W * pixelAspect}/${rows * CHAR_H}` : real?.aspect ?? '4/3';
  const geometry = agreementFor({
    cols,
    rows,
    palette: real?.palette ?? C64_PALETTE,
    aspect,
    colorPerCell: real ? real.colorPerCell : facts['video.colorPerCell'] !== false,
    resizable: false,
    pixelAspect,
    userGlyphs: real?.userGlyphs === true,
  });
  // No entry for this target: geometry only, the synthetic charBase. Not
  // correct for a real build, but no *more* wrong than layoutFromHardware
  // already was, and there is nothing target-specific to substitute.
  if (!real) return geometry;
  const cells = geometry.cols * geometry.rows;
  return {
    ...geometry,
    ...real.memoryFor(cells, hardware),
    // Optional: a machine with no captured character ROM of its own yet
    // (vic20 today) keeps agreementFor()'s own default ASCII font rather
    // than crashing here for want of a glyphsFor.
    ...(real.glyphsFor?.(facts) ?? {}),
    ...(real.vic ? { vic: real.vic } : {}),
    ...(real.packedRegisters ? { packedRegisters: real.packedRegisters } : {}),
    ...(real.reservedRanges ? { reservedRanges: real.reservedRanges } : {}),
  };
}

/** JSON sidecar written next to a wasm so one loader can size any skin. */
export function sidecarJson(layout = DEFAULT_LAYOUT) {
  return {
    cols: layout.cols,
    rows: layout.rows,
    resizable: layout.resizable === true,
    columnsOffset: layout.columnsOffset,
    rowsOffset: layout.rowsOffset,
    maxCols: layout.maxCols,
    maxRows: layout.maxRows,
    charWidth: layout.charWidth,
    charHeight: layout.charHeight,
    charBase: layout.charBase,
    colorBase: layout.colorBase,
    inputOffset: layout.inputOffset,
    hostOffset: layout.hostOffset,
    rasterControlOffset: layout.rasterControlOffset,
    rasterCountOffset: layout.rasterCountOffset,
    rasterBase: layout.rasterBase,
    glyphBase: layout.glyphBase,
    glyphFirst: layout.glyphFirst,
    glyphCount: layout.glyphCount,
    audioBase: layout.audioBase,
    rasterMaxEntries: layout.rasterMaxEntries,
    palette: layout.palette,
    font: layout.font,
    fontAlt: layout.fontAlt,
    charsetSwitch: layout.charsetSwitch,
    aspect: layout.aspect,
    colorPerCell: layout.colorPerCell,
    pixelAspect: layout.pixelAspect,
    vic: layout.vic ?? null,
    packedRegisters: layout.packedRegisters ?? null,
  };
}

// The border a machine with room to spare draws, and the one the headless
// --screenshot rasterizer always draws: a screenshot has no viewport to
// measure, so it has no business guessing at a smaller one. On a real screen
// the page picks a border per-container with borderFor() below.
export const BORDER_PX = 24;

export const InputEdge = {
  LEFT: 1,
  RIGHT: 2,
  UP: 4,
  DOWN: 8,
  CONFIRM: 16,
  CANCEL: 32,
};

export const KEY_TO_EDGE = {
  ArrowLeft: InputEdge.LEFT,
  ArrowRight: InputEdge.RIGHT,
  ArrowUp: InputEdge.UP,
  ArrowDown: InputEdge.DOWN,
  Enter: InputEdge.CONFIRM,
  Escape: InputEdge.CANCEL,
};

/** Bit in the INPUT_OFFSET snapshot for a DOM `KeyboardEvent.key`, or 0. */
export function inputBitForKey(key) {
  return KEY_TO_EDGE[key] ?? 0;
}

// A swipe shorter than this (in CSS pixels on the canvas) is a tap, which
// the page writes as confirm — the same edge as Enter. A longer gesture
// takes the dominant axis. Exported so the mapping is tested, not inferred
// from the inlined page script.
export const SWIPE_THRESHOLD = 28;

/** Direction or confirm bit for a pointer gesture, or 0 if it did not move enough to count. */
export function swipeEdge(dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < SWIPE_THRESHOLD && ay < SWIPE_THRESHOLD) return 0;
  if (ax > ay) return dx < 0 ? InputEdge.LEFT : InputEdge.RIGHT;
  return dy < 0 ? InputEdge.UP : InputEdge.DOWN;
}

/**
 * Whether this page should set HostStatus.TOUCH. maxTouchPoints plus
 * `(pointer: coarse)` is the reliable "this is a touchscreen" signal
 * (iPhone / iPad / Android). UA sniffing is a fallback only. A screenshot
 * host has no navigator, so this returns false there.
 *
 * @param {{ maxTouchPoints?: number, coarse?: boolean, userAgent?: string }} [env]
 */
export function hostIsTouch({ maxTouchPoints = 0, coarse = false, userAgent = '' } = {}) {
  if (maxTouchPoints > 0 && coarse) return true;
  if (maxTouchPoints > 0 && /iPhone|iPad|iPod|Android/i.test(userAgent)) return true;
  return false;
}

/**
 * Whether this page should leave HostStatus.NO_KEYBOARD clear. No browser
 * API says "a physical keyboard is attached", so this is the best signal
 * there is: a touch host whose primary pointer cannot hover — CSS
 * `(hover: none)` — is a phone or a tablet in the hands, and starts out
 * with no keyboard. A touchscreen laptop, or an iPad on a trackpad
 * keyboard, reports `hover: hover` and keeps its keyboard. The one that
 * gets it wrong — an iPad on a keyboard folio with no trackpad — is put
 * right by `sawKey`: the page passes true once any trusted keydown has
 * arrived, and from then on the host has a keyboard. A screenshot host
 * has no navigator and passes nothing, so it has a keyboard.
 *
 * @param {{ touch?: boolean, hoverNone?: boolean, sawKey?: boolean }} [env]
 */
export function hostHasKeyboard({ touch = false, hoverNone = false, sawKey = false } = {}) {
  if (sawKey) return true;
  return !(touch && hoverNone);
}

/** The whole HOST_OFFSET byte for a host described the way the two probes above take it. */
export function hostStatusByte(env = {}) {
  const touch = hostIsTouch(env);
  let byte = touch ? HostStatus.TOUCH : 0;
  if (!hostHasKeyboard({ touch, hoverNone: env.hoverNone, sawKey: env.sawKey })) byte |= HostStatus.NO_KEYBOARD;
  return byte;
}

// How much of the box the picture gets to keep before the border is worth
// drawing at all. The border is decoration: on a real VIC-20/C64 it is
// overscan the picture tube needed, and on a desktop it reads as the machine's
// own frame around the screen. It is also a slice of the canvas spent on
// nothing.
//
// On a phone that trade is mostly wrong in either orientation. An iPhone held
// upright gives the picture about 1.2 device-independent pixels per screen
// pixel; turned sideways, under 2. There is no room there to spend a fifth of
// the height on a frame, so a small screen drops it to a hairline and the game
// runs very nearly edge to edge. A tablet, or a mid-sized embed in an article,
// gets a thin one. Only a box big enough to render the picture at 3x or better
// gets the full 24-pixel border a desktop has always had.
//
// What it never drops to is nothing. The border is not only decoration: it is
// a color a program can set (screen.setBorder), and programs use it to say
// something about the whole screen at once — 2048 turns it red on game over.
// A border of zero silently deletes that channel on exactly the devices most
// people play on. BORDER_MIN_PX is small enough to cost nothing (3 of 216
// picture rows, under 3% of the height across both edges) and large enough
// that a color change is unmistakable.
export const BORDER_HAIRLINE_PX = 8;
// The thinnest border there is: still a border, still a color, still visible.
export const BORDER_MIN_PX = 3;
// Render the picture at 3x or better and there is room for the full border;
// below 2x there is only room for the thinnest one.
export const FULL_BORDER_SCALE = 3;
export const ANY_BORDER_SCALE = 2;

/**
 * The border, in screen pixels, for a box of `width`×`height` CSS pixels.
 *
 * `coarse` is a touch pointer (CSS `pointer: coarse`): a tablet big enough
 * to clear the 3× bar still gets the hairline rather than the full border,
 * because a hand covers part of the screen that a mouse does not.
 *
 * A zero or missing box is not a small screen, it is a box that has not been
 * measured yet — that gets the full border, so a container which is styled
 * after mount doesn't flash through a thin frame first.
 *
 * `innerWidth` / `innerHeight` default to the 16:9 host; a 4:3 skin passes
 * its own picture size so the 2×/3× bars are in that skin's pixels.
 *
 * @param {{ width?: number, height?: number, coarse?: boolean, innerWidth?: number, innerHeight?: number }} box
 * @returns {number} border width in screen pixels
 */
export function borderFor({
  width, height, coarse = false, innerWidth = INNER_W, innerHeight = INNER_H,
} = {}) {
  if (!(width > 0) || !(height > 0)) return BORDER_PX;
  const scale = Math.min(width / innerWidth, height / innerHeight);
  if (scale < ANY_BORDER_SCALE) return BORDER_MIN_PX;
  if (coarse || scale < FULL_BORDER_SCALE) return BORDER_HAIRLINE_PX;
  return BORDER_PX;
}

/** Canvas resolution for a given border: the picture plus that border on all four sides. */
export function screenSize(border, layout = DEFAULT_LAYOUT) {
  return { width: layout.innerWidth + border * 2, height: layout.innerHeight + border * 2 };
}
