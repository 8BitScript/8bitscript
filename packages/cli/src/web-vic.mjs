// The VIC-II as the C64's wasm page paints it: the register writes a program
// leaves in raster.8bs's list, and the eight hardware sprites.
//
// Pure functions of the program's linear memory and `layout.vic`
// (web-layout.mjs REAL_MACHINE_LAYOUT.c64), with no imports, so BOTH renderers
// run the very same source:
//   - web-scanline.mjs renderFrame() imports them for the screenshot;
//   - the generated browser loader (web-loader.mjs) embeds their source text
//     (`vicSource()`), so there is no hand-mirrored copy to drift. The
//     functions therefore stay plain ES5-style JS that only call each other.
//
// ---- what is modelled ------------------------------------------------------
//
// The list (packages/c64/src/raster.c64.web.8bs keeps native's memory layout
// byte for byte): the live page is $0200 or $0300 (the byte at $02FF says which),
// its end is the byte at $02FC, and an entry is four bytes — line, address low,
// address high, value — "at `line`, write `value` to `address`". The native
// handler applies an entry from the line AFTER its own (the first store lands in
// the entry line's right border, packages/c64/src/raster.8bs header), so an
// entry at raster line L changes what is drawn from line L + 1. This model
// applies every entry of a frame to the register values the program left in
// memory, in order, line by line; a register the list changed is the program's
// own value again at the next frame's top (native writes the frame table back
// at line 0; a list that leaves a register changed for the next frame relies on
// the handler's last write staying, which this model does not carry over).
//
// The eight sprites (Bauer, "The MOS 6567/6569 video controller" §3.8):
//   - at cycle 55 of each raster line a sprite whose Y register equals the line
//     (low eight bits) and whose DMA is off starts one; it then draws 21 rows
//     (42 lines when expanded in Y) from the NEXT line on, so Y = n draws on
//     lines n + 1 to n + 21;
//   - the DMA ends after the 21st row, in time for the same line's compare, so a
//     list entry that writes a new Y no later than the line before lets the
//     sprite draw again directly below: this is how multiplexer.8bs gets
//     twenty-four sprites from eight;
//   - X is nine bits ($D010 bit n is bit 8 of sprite n's X), the picture's left
//     edge is X = 24 and its top line is raster line 51, a sprite row's three
//     bytes come from the pointer (screen + $3F8 + n) * 64 in the VIC bank;
//   - hires is 24 pixels of one colour, multicolour 12 double-width pixels of
//     %01 shared 0, %10 the sprite's own colour, %11 shared 1; expand doubles
//     the width of each pixel;
//   - among sprites the lowest number is in front; a sprite with its priority
//     bit set is drawn behind the background's foreground (glyph) pixels.
// Not modelled: sprite-sprite and sprite-background collision registers
// ($D01E/$D01F read as the program left them), sprites in the opened border
// (the border covers them), bitmap-mode pointers, a PAL frame's extra lines,
// and the idle-state graphics.

/** First raster line of the 200-line picture (the first text row). */
export const VIC_FIRST_LINE = 51;
/** The sprite coordinate of the picture's left edge. */
export const VIC_LEFT = 24;

/**
 * The live list as an array of { line, address, value }, in stored order.
 * @param {Uint8Array} mem
 * @param {object} vic layout.vic
 */
export function vicReadWrites(mem, vic) {
  var writes = [];
  if (!vic || vic.listLivePage === undefined) return writes;
  var page = mem[vic.listLivePage];
  if (page !== 2 && page !== 3) return writes;
  var end = mem[vic.listEnd];
  if (end > 252) end = 252;
  var base = page * 256;
  for (var at = 0; at + 3 < end; at += 4) {
    writes.push({
      line: mem[base + at],
      address: mem[base + at + 1] + mem[base + at + 2] * 256,
      value: mem[base + at + 3],
    });
  }
  return writes;
}

/**
 * The border, background, fine scroll and character set in effect at picture
 * row `row`, after the list's entries up to that row have been applied to
 * `base` (the registers as the program left them).
 * @param {{border:number, background:number, scrollX:number, charset:number}} base
 */
export function vicRowBase(base, writes, row, vic) {
  var border = base.border;
  var background = base.background;
  var scrollX = base.scrollX;
  var charset = base.charset;
  for (var i = 0; i < writes.length; i += 1) {
    var w = writes[i];
    // An entry at line L changes what is drawn from line L + 1, picture row
    // (L + 1) - VIC_FIRST_LINE.
    if (w.line + 1 - 51 > row) break;
    if (w.address === vic.borderRegister) border = w.value & 15;
    else if (w.address === vic.backgroundRegister) background = w.value & 15;
    else if (w.address === vic.scrollRegister) scrollX = w.value & 7;
    else if (w.address === vic.selectRegister) charset = (w.value & vic.selectMask) !== 0 ? 1 : 0;
  }
  return { border: border, background: background, scrollX: scrollX, charset: charset };
}

/**
 * Compose the eight hardware sprites into per-pixel buffers over the inner
 * picture: `color[y * width + x]` is the palette index of the front-most
 * sprite pixel there (-1: none) and `behind[...]` is 1 when that sprite is
 * behind the background's foreground pixels.
 * @param {Uint8Array} mem
 * @param {object} vic layout.vic
 * @param {Array<{line:number,address:number,value:number}>} writes vicReadWrites()
 * @param {number} width inner picture width in pixels (320)
 * @param {number} height inner picture height in pixels (200)
 * @param {{color: Int8Array, behind: Uint8Array}} out buffers of width * height
 * @returns {boolean} whether any sprite pixel was drawn
 */
export function vicSprites(mem, vic, writes, width, height, out) {
  var color = out.color;
  var behind = out.behind;
  var regs = [];
  var i;
  for (i = 0; i < 0x30; i += 1) regs.push(mem[vic.spriteRegs + i]);
  var pointers = [];
  for (i = 0; i < 8; i += 1) pointers.push(mem[vic.spritePointers + i]);
  var any = regs[0x15] !== 0;
  for (i = 0; i < writes.length && !any; i += 1) {
    if (writes[i].address === vic.spriteRegs + 0x15 && writes[i].value !== 0) any = true;
  }
  if (!any) return false;
  color.fill(-1);
  behind.fill(0);
  var active = [0, 0, 0, 0, 0, 0, 0, 0];
  var rowOf = [0, 0, 0, 0, 0, 0, 0, 0];
  var half = [0, 0, 0, 0, 0, 0, 0, 0];
  var next = 0;
  var drew = false;
  // A sprite's Y can name any line from 0; its rows reach the picture from
  // line 51 on. Lines past the picture's last row cannot show anything.
  for (var line = 0; line < 51 + height; line += 1) {
    while (next < writes.length && writes[next].line < line) {
      var w = writes[next];
      var offset = w.address - vic.spriteRegs;
      if (offset >= 0 && offset < 0x30) regs[offset] = w.value;
      else if (w.address >= vic.spritePointers && w.address < vic.spritePointers + 8) pointers[w.address - vic.spritePointers] = w.value;
      next += 1;
    }
    var enable = regs[0x15];
    var row = line - 51;
    var h;
    // 1. rows of the DMAs already running draw on this line
    for (h = 0; h < 8; h += 1) {
      if (!active[h]) continue;
      var expandY = (regs[0x17] >> h) & 1;
      if (row >= 0 && ((enable >> h) & 1) !== 0) {
        if (vicSpriteRow(mem, vic, regs, pointers, h, rowOf[h], row, width, out)) drew = true;
      }
      if (expandY && half[h] === 0) {
        half[h] = 1;
      } else {
        half[h] = 0;
        rowOf[h] += 1;
        if (rowOf[h] >= 21) active[h] = 0;
      }
    }
    // 2. cycle 55: a sprite whose Y matches starts its DMA (drawing from the next line)
    for (h = 0; h < 8; h += 1) {
      if (active[h] || ((enable >> h) & 1) === 0) continue;
      if (regs[h * 2 + 1] === (line & 255)) {
        active[h] = 1;
        rowOf[h] = 0;
        half[h] = 0;
      }
    }
  }
  return drew;
}

// One row of sprite h (row `r` of its 21) onto picture row `row`.
function vicSpriteRow(mem, vic, regs, pointers, h, r, row, width, out) {
  var color = out.color;
  var behind = out.behind;
  var at = vic.spriteBank + pointers[h] * 64 + r * 3;
  var bits = (mem[at] << 16) | (mem[at + 1] << 8) | mem[at + 2];
  if (bits === 0) return false;
  var x0 = regs[h * 2] + (((regs[0x10] >> h) & 1) !== 0 ? 256 : 0) - 24;
  var expandX = ((regs[0x1d] >> h) & 1) !== 0;
  var multi = ((regs[0x1c] >> h) & 1) !== 0;
  var own = regs[0x27 + h] & 15;
  var shared0 = regs[0x25] & 15;
  var shared1 = regs[0x26] & 15;
  var back = ((regs[0x1b] >> h) & 1) !== 0 ? 1 : 0;
  var unit = multi ? 2 : 1;
  if (expandX) unit *= 2;
  var steps = multi ? 12 : 24;
  var drew = false;
  for (var s = 0; s < steps; s += 1) {
    var ink;
    if (multi) {
      var pair = (bits >> (22 - s * 2)) & 3;
      if (pair === 0) continue;
      ink = pair === 1 ? shared0 : pair === 2 ? own : shared1;
    } else {
      if (((bits >> (23 - s)) & 1) === 0) continue;
      ink = own;
    }
    for (var k = 0; k < unit; k += 1) {
      var x = x0 + s * unit + k;
      if (x < 0 || x >= width) continue;
      var index = row * width + x;
      if (color[index] !== -1) continue; // a lower-numbered sprite is in front
      color[index] = ink;
      behind[index] = back;
      drew = true;
    }
  }
  return drew;
}

/** The source of this module's functions, for the generated browser loader. */
export function vicSource() {
  return [vicReadWrites, vicRowBase, vicSprites, vicSpriteRow].map(String).join('\n');
}
