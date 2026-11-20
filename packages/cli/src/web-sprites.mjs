// The sprite layer of the synthetic web hosts: pixel sprites, spriteCount of them, read from
// a region of the program's own memory (web-layout.mjs, agreementFor
// `sprites`) and composited over the whole inner picture.
//
// One module, two renderers: web-scanline.mjs renderFrame() imports
// webSprites() for the screenshot, and the generated loader embeds
// webSpritesSource() (the way web-vic.mjs's vicSource() does), so there is no
// hand-mirrored copy to drift.
//
// The rules (the X16's own numbers, so one program lands on the same pixels on
// every machine):
//   - a two-colour palette (a pet-style skin: every entry is its first or second) draws every opaque pixel in ink 1,
//     whatever the tint, since neither own colours nor a tint can be shown;
//   - slot 0 is in front of slot 1, and so on; every sprite is in front of
//     the cells and the background, and none is moved by the horizontal scroll
//     or the raster list;
//   - a sprite pixel is drawn only inside the inner picture: no wrap;
//   - pixels are 4bpp, the left pixel in the high nibble, index 0 clear;
//   - a slot is skipped when its shown flag is clear, its size is not one of
//     8, 16, 32 or 64, or its frame does not lie inside the pool.

/**
 * Composite the `layout.spriteCount` sprites of `mem` into `out.rgb`.
 *
 * @param {Uint8Array} mem the program's memory
 * @param {{ spriteCount: number, spriteTable: number, spritePalettes: number, spritePool: number, spritePoolBytes: number }} layout
 *   the region's addresses (a negative `spriteTable` is a host with none)
 * @param {number} innerW the inner picture's width in pixels
 * @param {number} innerH the inner picture's height in pixels
 * @param {number[][]} palette the host palette as `[r, g, b]` triples
 * @param {{ rgb: Int32Array }} out innerW * innerH entries, `0xRRGGBB` or -1 for none; the caller clears it to -1
 * @returns {boolean} whether any sprite pixel was drawn
 */
export function webSprites(mem, layout, innerW, innerH, palette, out) {
  var table = layout.spriteTable;
  var count = layout.spriteCount ?? 0;
  if (!(table >= 0) || !(count > 0)) return false;
  var drew = false;
  // A two-colour host (the PET's black and green): every entry is palette[0] or palette[1].
  var mono = palette.length >= 2;
  for (var m = 2; m < palette.length; m += 1) {
    var entryInk = palette[m];
    var matches0 = entryInk[0] === palette[0][0] && entryInk[1] === palette[0][1] && entryInk[2] === palette[0][2];
    var matches1 = entryInk[0] === palette[1][0] && entryInk[1] === palette[1][1] && entryInk[2] === palette[1][2];
    if (!matches0 && !matches1) { mono = false; break; }
  }
  for (var slot = 0; slot < count; slot += 1) {
    var entry = table + slot * 10; // SPRITE_ENTRY_BYTES
    if ((mem[entry] & 1) === 0) continue;
    var w = mem[entry + 5];
    var h = mem[entry + 6];
    if ((w !== 8 && w !== 16 && w !== 32 && w !== 64) || (h !== 8 && h !== 16 && h !== 32 && h !== 64)) continue;
    var frame = mem[entry + 7] | (mem[entry + 8] << 8);
    var rowBytes = w >> 1;
    if (frame + rowBytes * h > layout.spritePoolBytes) continue;
    // Positions are signed 16 bit, so a sprite can sit partly off the left or top edge.
    var x0 = ((mem[entry + 1] | (mem[entry + 2] << 8)) << 16) >> 16;
    var y0 = ((mem[entry + 3] | (mem[entry + 4] << 8)) << 16) >> 16;
    var tint = mem[entry + 9];
    var tintInk = null;
    // A two-colour host shows ink only, whatever the tint; otherwise a tint
    // below 16 is a host palette entry and 16 and up the picture's own colours.
    if (mono) tintInk = palette[1];
    else if (tint < 16) tintInk = palette[tint];
    if ((mono || tint < 16) && !tintInk) continue;
    var colors = layout.spritePalettes + slot * 32; // SPRITE_PALETTE_SLOT_BYTES
    var pool = layout.spritePool + frame;
    for (var row = 0; row < h; row += 1) {
      var y = y0 + row;
      if (y < 0 || y >= innerH) continue;
      for (var col = 0; col < w; col += 1) {
        var x = x0 + col;
        if (x < 0 || x >= innerW) continue;
        var byte = mem[pool + row * rowBytes + (col >> 1)];
        var index = (col & 1) === 0 ? byte >> 4 : byte & 15;
        if (index === 0) continue;
        var at = y * innerW + x;
        if (out.rgb[at] !== -1) continue; // a lower-numbered slot is in front
        if (tintInk) {
          out.rgb[at] = (tintInk[0] << 16) | (tintInk[1] << 8) | tintInk[2];
        } else {
          var lo = mem[colors + index * 2];
          var hi = mem[colors + index * 2 + 1];
          out.rgb[at] = ((hi & 15) * 17 << 16) | ((lo >> 4) * 17 << 8) | ((lo & 15) * 17);
        }
        drew = true;
      }
    }
  }
  return drew;
}

/** The source of this module's functions, for the generated browser loader. */
export function webSpritesSource() {
  return [webSprites].map(String).join('\n');
}
