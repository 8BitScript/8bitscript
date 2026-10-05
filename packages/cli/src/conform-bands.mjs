// `8bs conform bands` — does the wasm build put a raster band on the same
// picture line the real machine does?
//
// The probe (conform/src/bands.8bs) paints the whole picture one solid colour
// (white) and puts the portable raster layer's BORDER entries at named picture
// lines. The picture is then a clean rectangle in each capture: the run of
// background-coloured pixels through the middle of the screen, across and
// down, IS the picture, whatever size or position the emulator gave it. Down
// the strip of border just left of it, each picture line has a colour; the
// places that colour changes are the bands' first lines, which is what is
// compared:
//
//   - the wasm build against the lines the program named (it applies an entry
//     at its picture line exactly: offset 0);
//   - the native emulator against the same lines (the machine's own timing,
//     which is the finding: the VIC-20's frame hook syncs on pairs of lines,
//     the C64's handler lands in the line before);
//   - the two against each other.
//
// Pure functions over decoded PNGs, so the comparison itself is tested in CI
// without an emulator (test/conform-bands.test.mjs).
import { decodePNG } from './png-decode.mjs';

/** The first picture line of each band the probe paints: line 0, then each BORDER entry. */
export const BAND_STARTS = [0, 24, 56, 88, 120, 152];

/** The machines whose raster list has BORDER entries on both the native and the wasm side. */
export const BAND_MACHINES = ['vic20', 'c64'];

const COLOUR_SAME = 24; // channels this close are one colour (a band's edge is not anti-aliased, but a palette is)

const px = (img, x, y) => {
  const o = (y * img.width + x) * 4;
  return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]];
};
const distance = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/**
 * The picture rectangle in a capture of the bands probe: the run of the colour
 * at the centre of the screen, across the middle row and down the middle
 * column. Throws a sentence a person can act on if the centre is not a clean
 * rectangle of one colour.
 */
export function locateBandsPicture(img, grid) {
  const cx = img.width >> 1;
  const cy = img.height >> 1;
  const ink = px(img, cx, cy);
  let x0 = cx; let x1 = cx; let y0 = cy; let y1 = cy;
  while (x0 > 0 && distance(px(img, x0 - 1, cy), ink) <= COLOUR_SAME) x0 -= 1;
  while (x1 < img.width - 1 && distance(px(img, x1 + 1, cy), ink) <= COLOUR_SAME) x1 += 1;
  while (y0 > 0 && distance(px(img, cx, y0 - 1), ink) <= COLOUR_SAME) y0 -= 1;
  while (y1 < img.height - 1 && distance(px(img, cx, y1 + 1), ink) <= COLOUR_SAME) y1 += 1;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const sx = w / (grid.cols * 8);
  const sy = h / (grid.rows * 8);
  if (sx < 0.5 || sx > 8 || sy < 0.5 || sy > 8) {
    throw new Error(`the solid picture is ${w}x${h}, which is not ${grid.cols}x${grid.rows} cells at any sensible scale: the capture is not the bands probe`);
  }
  return { x0, y0, x1, y1, w, h, sx, sy, ink };
}

/**
 * The bands down the border strip left of the picture: each run of one colour
 * as `{ start, end, rgb }` in picture lines. `inset` is how many pixels left
 * of the picture to sample (inside the border, clear of its edge).
 */
export function measureBands(img, grid, { inset = 3 } = {}) {
  const rect = locateBandsPicture(img, grid);
  const x = Math.max(0, rect.x0 - inset);
  const lines = grid.rows * 8;
  const bands = [];
  for (let line = 0; line < lines; line += 1) {
    const y = Math.min(img.height - 1, rect.y0 + Math.floor((line + 0.5) * rect.sy));
    const rgb = px(img, x, y);
    const last = bands[bands.length - 1];
    if (last && distance(last.rgb, rgb) <= COLOUR_SAME) last.end = line;
    else bands.push({ start: line, end: line, rgb });
  }
  return { rect, bands };
}

/** Each band's first line, for a list of bands. */
export const startsOf = (bands) => bands.map((b) => b.start);

/**
 * Compare two sets of bands (native `a`, wasm `b`) and the lines the program
 * named (`expected`, the first line of each band).
 * @returns {{ ok: boolean, count: boolean, maxOffset: number, colourDiffs: number, rows: object[] }}
 */
export function compareBands(a, b, expected = BAND_STARTS, tolerance = 2) {
  const count = a.length === b.length && b.length === expected.length;
  const rows = [];
  let maxOffset = 0;
  const n = Math.max(a.length, b.length, expected.length);
  for (let i = 0; i < n; i += 1) {
    const native = a[i] ?? null; const wasm = b[i] ?? null; const want = expected[i] ?? null;
    const offset = native && wasm ? wasm.start - native.start : null;
    if (offset !== null) maxOffset = Math.max(maxOffset, Math.abs(offset));
    rows.push({
      band: i, expected: want, native: native?.start ?? null, wasm: wasm?.start ?? null, offset,
      wasmExact: wasm !== null && want !== null && wasm.start === want,
      nativeOffset: native && want !== null ? native.start - want : null,
      colourNative: native?.rgb ?? null, colourWasm: wasm?.rgb ?? null,
      sameColour: native && wasm ? distance(native.rgb, wasm.rgb) <= 48 : null,
    });
  }
  // Lines are the finding. A colour that differs is a palette decision (which VICE palette, which green),
  // reported beside the lines and failing only when asked, as the grid comparison does.
  const ok = count && maxOffset <= tolerance;
  const colourDiffs = rows.filter((r) => r.sameColour === false).length;
  return { ok, count, maxOffset, colourDiffs, rows };
}

/** Compare two captures of the bands probe (PNG bytes). */
export function compareBandCaptures(nativePng, wasmPng, grid, { tolerance = 2, expected = BAND_STARTS } = {}) {
  const native = measureBands(decodePNG(nativePng), grid);
  const wasm = measureBands(decodePNG(wasmPng), grid);
  return { ...compareBands(native.bands, wasm.bands, expected, tolerance), native, wasm, tolerance };
}
