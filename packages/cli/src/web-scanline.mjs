// The web target's per-scanline compositor: the one place that knows how a
// raster list (packages/web/src/rasterline.8bs) changes the picture.
//
// Pure, and dependency-free except for the glyph table (font8x8.mjs), so
// both renderers can hold to one rule:
//   - screenshot.mjs imports renderFrame() directly and writes its RGBA
//     buffer out as the PNG;
//   - the generated browser loader (web-loader.mjs) carries a hand-mirrored
//     inline copy of readRasterEntries/rowState and this compositor — the
//     same arrangement borderFor/swipeEdge/gridFor already live under, since
//     the browser code is generated JS in a template string, not a real
//     import — and web-loader.test.mjs holds the two copies pixel-identical.
//
// Rendering is idealized: an entry takes effect exactly at its picture line
// and holds until another entry for the same slot, with no simulated
// write-to-visible delay and no per-line jitter — the web target proves
// semantics, never fit.
import { glyphRows } from './font8x8.mjs';
import { userGlyph } from './web-layout.mjs';
import { vicReadWrites, vicRowBase, vicSprites } from './web-vic.mjs';

// The same four slot numbers every rasterline file names.
export const Slot = {
  BORDER: 0,
  BACKGROUND: 1,
  SCROLL_X: 2,
  CHARSET: 3,
};

/** `[r, g, b]` triples for an array of '#rrggbb' palette strings. */
export function rgbPalette(colors) {
  return colors.map((hex) => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]);
}

/**
 * The raster region as rasterline.8bs writes it: the control byte, the count
 * byte, and `count` three-byte entries from `layout.rasterBase`. Entries come
 * back in stored order, which at()/setValue() keep ascending by line — no
 * sorting here, the same rule the C64's address list enforces on insert.
 *
 * An entry is three bytes — the line's low byte, the slot byte, the value —
 * with the line's ninth bit packed into the slot byte's bit 7, because the
 * resizable Modern host can hand out up to 64 rows (512 picture lines) and a
 * single line byte stops at 255. Slots only need the low bits, so the format
 * stays three bytes wide and every offset in the agreement page stays put.
 *
 * @param {Uint8Array} mem
 * @param {{ rasterControlOffset: number, rasterCountOffset: number, rasterBase: number, rasterMaxEntries?: number }} layout
 * @returns {{ enabled: boolean, entries: Array<{ line: number, slot: number, value: number }> }}
 */
export function readRasterEntries(mem, layout) {
  const enabled = mem[layout.rasterControlOffset] !== 0;
  const max = layout.rasterMaxEntries ?? 64;
  let count = mem[layout.rasterCountOffset];
  if (count > max) count = max;
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = layout.rasterBase + i * 3;
    entries.push({
      line: mem[at] + ((mem[at + 1] & 128) === 0 ? 0 : 256),
      slot: mem[at + 1] & 127,
      value: mem[at + 2],
    });
  }
  return { enabled, entries };
}

/**
 * The border, background, fine scroll and character set in effect at
 * picture row `row` (0-indexed pixel row within the inner picture): walk the
 * ascending entries and hold the last value each slot was given at or before
 * that row, starting from the frame's base colors, a scroll of 0 and the
 * boot character set (0). CHARSET keeps only bit 0 — the web has two sets,
 * the boot one and the alternate (font8x8.mjs glyphRows()) — the same way
 * SCROLL_X keeps only its low three bits.
 *
 * @param {Array<{ line: number, slot: number, value: number }>} entries
 * @param {number} row
 * @param {{ border: number, background: number, scrollX?: number, charset?: number }} base palette indices from mem[0]/mem[1], already masked; a machine whose registers the page reads (layout.vic) also hands in the scroll and character set those registers say
 * @returns {{ border: number, background: number, scrollX: number, charset: number }}
 */
export function rowState(entries, row, base) {
  let border = base.border;
  let background = base.background;
  let scrollX = base.scrollX ?? 0;
  let charset = base.charset ?? 0;
  for (const entry of entries) {
    if (entry.line > row) break;
    if (entry.slot === Slot.BORDER) border = entry.value & 15;
    else if (entry.slot === Slot.BACKGROUND) background = entry.value & 15;
    else if (entry.slot === Slot.SCROLL_X) scrollX = entry.value & 7;
    else if (entry.slot === Slot.CHARSET) charset = entry.value & 1;
  }
  return { border, background, scrollX, charset };
}

/**
 * The whole frame, one scanline at a time, at the full border a screenshot
 * always draws (a screenshot has no viewport to measure a smaller one from).
 * Outside the inner picture every row is the frame's base border color;
 * inside it, each row resolves its own rowState(), paints the left/right
 * border strips in that row's border, and composes each inner column from
 * the source column `x - scrollX` — a source column below 0 paints that
 * row's background. With the list disabled (or empty) this collapses to
 * exactly the plain cell-major picture.
 *
 * @param {Uint8Array} mem
 * @param {object} layout an agreementFor() layout, with `cols`/`rows` already
 *   resolved to the live grid; `border` overrides the 24 px default.
 * @param {number[][]} palette `[r, g, b]` triples (see rgbPalette)
 * @returns {{ width: number, height: number, rgba: Uint8Array }}
 */
export function renderFrame(mem, layout, palette) {
  const cols = layout.cols;
  const cw = layout.charWidth ?? 8;
  const ch = layout.charHeight ?? 8;
  const border = layout.border ?? 24;
  const innerW = cols * cw;
  const innerH = layout.rows * ch;
  const width = innerW + border * 2;
  const height = innerH + border * 2;
  const rgba = new Uint8Array(width * height * 4);
  const colorPerCell = layout.colorPerCell !== false;
  // A machine whose chip registers are bytes of the program's own memory
  // (layout.vic, web-layout.mjs REAL_MACHINE_LAYOUT.c64): the border, the
  // background, the horizontal scroll and which of the two character sets is
  // live are read from the registers a program writes, and every glyph is
  // read from the character RAM the program holds — the VIC-II's own way.
  const vic = layout.vic ?? null;
  const switchRegister = layout.charsetSwitch ?? null;
  const packed = vic ? null : layout.packedRegisters ?? null;
  const base = vic ? {
    border: mem[vic.borderRegister] & 15,
    background: mem[vic.backgroundRegister] & 15,
    scrollX: mem[vic.scrollRegister] & 7,
    charset: (mem[vic.selectRegister] & vic.selectMask) !== 0 ? 1 : 0,
  } : packed ? {
    // One register holds both colours (the VIC-20's $900F): the border in its
    // low bits, the background in the high ones. Which character set is live
    // is the layout's charsetSwitch ($9005's chargen base), as for any machine
    // with two ROM sets.
    border: mem[packed.colorRegister] & packed.borderMask,
    background: (mem[packed.colorRegister] >> packed.backgroundShift) & 15,
    charset: switchRegister ? ((mem[switchRegister.register] & switchRegister.mask) !== 0 ? 1 : 0) : 0,
  } : {
    border: colorPerCell ? mem[0] & 15 : 0,
    background: colorPerCell ? mem[1] & 15 : 0,
    // A real machine with two ROM sets (the PET, the VIC-20): the register its
    // own hardware reads says which one is live (web-layout.mjs charsetSwitch).
    charset: switchRegister ? ((mem[switchRegister.register] & switchRegister.mask) !== 0 ? 1 : 0) : 0,
  };
  const raster = readRasterEntries(mem, layout);
  // Every slot applies on every skin. A skin without per-cell color keeps its
  // per-cell foreground fixed (palette[1], below), but BORDER and BACKGROUND
  // still resolve through the skin's palette — on the PET that is black or
  // green, which is exactly what a split means there.
  const entries = raster.enabled ? raster.entries : [];
  // The C64's own list (raster.8bs, kept byte for byte by its wasm twin) and
  // its eight sprites: web-vic.mjs, the one source both renderers run.
  const vicWrites = vic ? vicReadWrites(mem, vic) : [];
  const spriteLayer = vic && vic.spriteRegs !== undefined
    ? { color: new Int8Array(innerW * innerH), behind: new Uint8Array(innerW * innerH) }
    : null;
  const spritesDrawn = spriteLayer ? vicSprites(mem, vic, vicWrites, innerW, innerH, spriteLayer) : false;
  const put = (x, y, ink) => {
    const i = (y * width + x) * 4;
    rgba[i] = ink[0];
    rgba[i + 1] = ink[1];
    rgba[i + 2] = ink[2];
    rgba[i + 3] = 255;
  };
  // A sprite pixel over the picture's own: the front-most sprite wins, and one
  // behind the background hides under a foreground (glyph) pixel.
  const spriteInk = (x, row, foreground, picture) => {
    if (!spritesDrawn) return picture;
    const at = row * innerW + x;
    const sprite = spriteLayer.color[at];
    if (sprite === -1 || (spriteLayer.behind[at] === 1 && foreground)) return picture;
    return palette[sprite];
  };
  for (let y = 0; y < height; y += 1) {
    const row = y - border;
    if (row < 0 || row >= innerH) {
      const ink = palette[base.border];
      for (let x = 0; x < width; x += 1) put(x, y, ink);
      continue;
    }
    const state = rowState(entries, row, vic ? vicRowBase(base, vicWrites, row, vic) : base);
    const borderInk = palette[state.border];
    const backgroundInk = palette[state.background];
    for (let x = 0; x < border; x += 1) put(x, y, borderInk);
    for (let x = border + innerW; x < width; x += 1) put(x, y, borderInk);
    const glyphY = row % ch;
    const cellRow = (row - glyphY) / ch;
    for (let x = 0; x < innerW; x += 1) {
      const srcX = x - state.scrollX;
      if (srcX < 0) {
        put(border + x, y, spriteInk(x, row, false, backgroundInk));
        continue;
      }
      const gx = srcX % cw;
      const col = (srcX - gx) / cw;
      const cell = cellRow * cols + col;
      const colorByte = mem[layout.colorBase + cell];
      const raw = mem[layout.charBase + cell];
      if (vic) {
        // The character RAM, set by set: eight bytes a glyph, bit 7 the
        // leftmost pixel, a reversed glyph a screen code's bit 7 (the ROM
        // image holds the reversed copies itself), the colour RAM's low four
        // bits the ink.
        const at = vic.charsetBase + (state.charset === 1 ? vic.setStride : 0) + raw * 8 + glyphY;
        const set = ((mem[at] >> (7 - gx)) & 1) !== 0;
        put(border + x, y, spriteInk(x, row, set, set ? palette[colorByte & 15] : backgroundInk));
        continue;
      }
      const reverse = (colorByte & 128) !== 0;
      // A program's own redefined glyph (web-layout.mjs, GLYPH_FIRST..) wins
      // over the font; an undefined one (all eight rows zero) falls to it.
      // A machine with a second ROM set of its own (layout.fontAlt) draws that
      // table whole when the set is live; the web's alternate (capitals) is
      // glyphRows()'s own charset argument and has no fontAlt.
      const font = state.charset === 1 && layout.fontAlt ? layout.fontAlt : layout.font;
      const glyph = userGlyph(mem, layout.glyphBase ?? -1, raw) ?? glyphRows(raw, font, layout.fontAlt ? 0 : state.charset);
      const bits = glyph === null ? 0 : glyph[glyphY];
      const on = ((bits >> gx) & 1) !== 0;
      const fg = colorPerCell ? palette[colorByte & 15] : palette[1];
      const ink = reverse ? (on ? backgroundInk : fg) : (on ? fg : backgroundInk);
      put(border + x, y, ink);
    }
  }
  return { width, height, rgba };
}
