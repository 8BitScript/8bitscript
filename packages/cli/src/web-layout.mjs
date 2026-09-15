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
// entries — the line's low byte, the slot byte, the value — the same three
// slots @8bitscript/raster names (BORDER 0, BACKGROUND 1, SCROLL_X 2). The
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
 * @param {{ cols?: number, rows?: number, palette?: string[], aspect?: string, colorPerCell?: boolean, font?: string, resizable?: boolean }} [options]
 */
export function agreementFor({
  cols = 48,
  rows = 27,
  palette = C64_PALETTE,
  aspect = '16/9',
  colorPerCell = true,
  font = 'font8x8',
  resizable = false,
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
    rasterMaxEntries: RASTER_MAX_ENTRIES,
    columnsOffset: COLUMNS_OFFSET,
    rowsOffset: ROWS_OFFSET,
    maxCols: MAX_COLUMNS,
    maxRows: MAX_ROWS,
    palette: [...palette],
    aspect,
    colorPerCell,
    font,
  };
}

export const DEFAULT_LAYOUT = agreementFor();

export const GRID_COLS = DEFAULT_LAYOUT.cols;
export const GRID_ROWS = DEFAULT_LAYOUT.rows;
export const INNER_W = DEFAULT_LAYOUT.innerWidth;
export const INNER_H = DEFAULT_LAYOUT.innerHeight;
export const COLOR_BASE = DEFAULT_LAYOUT.colorBase;
export const INPUT_OFFSET = DEFAULT_LAYOUT.inputOffset;
export const HOST_OFFSET = DEFAULT_LAYOUT.hostOffset;

/** Bit 0 of the HOST_OFFSET byte: this host is a touchscreen. */
export const HostStatus = {
  TOUCH: 1,
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
  });
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
    rasterMaxEntries: layout.rasterMaxEntries,
    palette: layout.palette,
    font: layout.font,
    aspect: layout.aspect,
    colorPerCell: layout.colorPerCell,
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
