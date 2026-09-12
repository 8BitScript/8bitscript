// The web target's screen layout, palette, and input mapping: the facts both
// the browser page and the headless --screenshot rasterizer have to agree on,
// in one place neither of them owns.
//
// This module is deliberately dependency-free and side-effect-free. Everything
// in it is either a constant that gets interpolated into generated JavaScript
// (web-loader.mjs) or a pure function that gets unit-tested here and *also*
// interpolated into that JavaScript. A rule that lives only inside a template
// string is a rule nothing can test; see swipeEdge() and borderFor() below.

// The C64's palette (0-15), reused so a color number means the same thing
// in every 8BitScript example, on whichever machine it runs on. See the
// header comment on @8bitscript/web/screen's setColors() for why the web target
// borrows this rather than defining its own.
export const COLORS = [
  '#000000', '#ffffff', '#883932', '#67b6bd',
  '#8b3f96', '#55a049', '#40318d', '#bfce72',
  '#8b5429', '#574200', '#b86962', '#505050',
  '#787878', '#94e089', '#7869c4', '#9f9f9f',
];

// The character grid is the C64's own 40×25 of 8×8 cells — 320×200, the
// same shape @8bitscript/web's virtual screen uses. The colored border sits
// around that grid, the way the VIC-II/VIC paint it, rather than eating into
// it: characters then live entirely in the background, not clipped into the
// border.
export const GRID_COLS = 40;
export const GRID_ROWS = 25;
export const CHAR_W = 8;
export const CHAR_H = 8;
export const INNER_W = GRID_COLS * CHAR_W;
export const INNER_H = GRID_ROWS * CHAR_H;

// The border a machine with room to spare draws, and the one the headless
// --screenshot rasterizer always draws: a screenshot has no viewport to
// measure, so it has no business guessing at a smaller one. On a real screen
// the page picks a border per-container with borderFor() below.
export const BORDER_PX = 24;

// Where the virtual screen's character codes and per-cell colors live in
// the wasm's linear memory — @8bitscript/web's WebRegisters layout, mirrored
// here by hand (there's no shared module the .8bs side and this JS host
// could both import). Byte 0 is border, byte 1 is background.
export const CHAR_BASE = 2;
export const COLOR_BASE = 1002;
// Directions / confirm / cancel: the host writes this byte, @8bitscript/web/input
// reads it. Same Edge bits as every other machine's input layer. First byte
// after the 1000 color cells at COLOR_BASE.
export const INPUT_OFFSET = 2002;

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

// How much of the box the picture gets to keep before the border is worth
// drawing at all. The border is decoration: on a real VIC-20 it is overscan
// the picture tube needed, and on a desktop it reads as the machine's own
// frame around the screen. It is also 48 of every 368 horizontal pixels —
// 13% of the width and 19% of the height — spent on nothing.
//
// On a phone that trade is plainly wrong in either orientation. An iPhone
// held upright gives the picture about 1.2 device-independent pixels per
// screen pixel; turned sideways, under 2. There is no room there to spend
// a fifth of the height on a frame, so this drops it entirely and the game
// runs edge to edge. A tablet, or a mid-sized embed in an article, gets a
// hairline — enough to read as a screen with an edge, not enough to cost
// anything. Only a box big enough to render the picture at 3× or better
// gets the full 24-pixel border a desktop has always had.
export const BORDER_HAIRLINE_PX = 8;
// Render the picture at 3x or better and there is room for the full border;
// below 2x there is no room for any of it.
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
 * after mount doesn't flash through a borderless frame first.
 *
 * @param {{ width?: number, height?: number, coarse?: boolean }} box
 * @returns {number} border width in screen pixels
 */
export function borderFor({ width, height, coarse = false } = {}) {
  if (!(width > 0) || !(height > 0)) return BORDER_PX;
  // How large the 320×200 picture alone would draw in this box. Measured
  // without the border, on purpose: the question is what the picture is
  // worth here, not what the last layout happened to leave room for.
  const scale = Math.min(width / INNER_W, height / INNER_H);
  if (scale < ANY_BORDER_SCALE) return 0;
  if (coarse || scale < FULL_BORDER_SCALE) return BORDER_HAIRLINE_PX;
  return BORDER_PX;
}

/** Canvas resolution for a given border: the picture plus that border on all four sides. */
export function screenSize(border) {
  return { width: INNER_W + border * 2, height: INNER_H + border * 2 };
}
