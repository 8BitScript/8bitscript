// Game Gear (and later SMS) cartridge prefix the Z80 backend prepends:
// interrupt stubs, a 1bpp→Mode-4 font, VDP/CRAM setup, then JP into the
// compiled program. Without this, hello-world's stores hit CPU address 0
// (ROM) and the LCD stays blank — the VDP is never enabled.
//
// Font bytes are Daniel Hepper's font8x8_basic, ASCII 32–122, bit 0 =
// leftmost in the source table; each row is reversed here so SMS/GG bit 7
// is leftmost.

const FONT_AT = 0x0a00;
export const SEGA_CODE_ORIGIN = 0x2000;
const CRT0_AT = 0x0100;
const TILE_SPACE = 32;
const NAME_VRAM = 0x3800;
const GLYPHS = 91;

const GLYPHS_32_122_HEX = '0000000000000000183c3c1818001800363600000000000036367f367f3636000c3e031e301f0c00006333180c6663001c361c6e3b336e000606030000000000180c0606060c1800060c1818180c060000663cff3c660000000c0c3f0c0c000000000000000c0c060000003f0000000000000000000c0c006030180c060301003e63737b6f673e000c0e0c0c0c0c3f001e33301c06333f001e33301c30331e00383c36337f3078003f031f3030331e001c06031f33331e003f3330180c0c0c001e33331e33331e001e33333e30180e00000c0c00000c0c00000c0c00000c0c06180c0603060c180000003f00003f0000060c1830180c06001e3330180c000c003e637b7b7b031e000c1e33333f3333003f66663e66663f003c66030303663c001f36666666361f007f46161e16467f007f46161e16060f003c66030373667c003333333f333333001e0c0c0c0c0c1e007830303033331e006766361e366667000f06060646667f0063777f7f6b63630063676f7b736363001c36636363361c003f66663e06060f001e3333333b1e38003f66663e366667001e33070e38331e003f2d0c0c0c0c1e003333333333333f0033333333331e0c006363636b7f7763006363361c1c3663003333331e0c0c1e007f6331184c667f001e06060606061e0003060c18306040001e18181818181e00081c36630000000000000000000000ff0c0c18000000000000001e303e336e000706063e66663b0000001e3303331e003830303e33336e0000001e333f031e001c36060f06060f0000006e33333e301f0706366e666667000c000e0c0c0c1e00300030303033331e070666361e3667000e0c0c0c0c0c1e000000337f7f6b630000001f333333330000001e3333331e0000003b66663e060f00006e33333e307800003b6e66060f0000003e031e301f00080c3e0c0c2c18000000333333336e0000003333331e0c000000636b7f7f3600000063361c36630000003333333e301f00003f190c263f00';

function reverseBits(byte: number) {
  let out = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    if (byte & (1 << bit)) out |= 1 << (7 - bit);
  }
  return out;
}

function fontBytes() {
  const raw = Buffer.from(GLYPHS_32_122_HEX, 'hex');
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = reverseBits(raw[i]);
  return out;
}

function emitVdpReg(code: number[], data: number, reg: number) {
  code.push(0x3e, data & 0xff, 0xd3, 0xbf, 0x3e, 0x80 | (reg & 0x0f), 0xd3, 0xbf);
}

function emitCrt0(userOrigin: number) {
  const code: number[] = [];
  const rel = (from: number, to: number) => {
    const d = to - (from + 2);
    if (d < -128 || d > 127) throw new Error(`sega crt0: branch ${d} out of range`);
    return d & 0xff;
  };

  // VDP registers: Mode 4, display off while we load, nametable $3800.
  emitVdpReg(code, 0x04, 0);
  emitVdpReg(code, 0x00, 1);
  emitVdpReg(code, 0x0e, 2);
  emitVdpReg(code, 0xff, 3);
  emitVdpReg(code, 0xff, 4);
  emitVdpReg(code, 0x7f, 5);
  emitVdpReg(code, 0x07, 6);
  emitVdpReg(code, 0x00, 7);
  emitVdpReg(code, 0x00, 8);
  emitVdpReg(code, 0x00, 9);
  emitVdpReg(code, 0xff, 10);

  // CRAM 0 = black, 1 = white (Game Gear 12-bit, two bytes each).
  code.push(0x3e, 0x00, 0xd3, 0xbf, 0x3e, 0xc0, 0xd3, 0xbf);
  code.push(0xaf, 0xd3, 0xbe, 0xd3, 0xbe);
  code.push(0x3e, 0xff, 0xd3, 0xbe, 0x3e, 0x0f, 0xd3, 0xbe);

  // VRAM write at tile 32 (VRAM $0400).
  code.push(0x3e, 0x00, 0xd3, 0xbf, 0x3e, 0x44, 0xd3, 0xbf);
  // LD HL, FONT_AT / LD B, GLYPHS
  code.push(0x21, FONT_AT & 0xff, (FONT_AT >>> 8) & 0xff, 0x06, GLYPHS);
  const glyphLoop = CRT0_AT + code.length;
  code.push(0x0e, 0x08); // LD C, 8
  const rowLoop = CRT0_AT + code.length;
  code.push(0x7e, 0x23, 0xd3, 0xbe); // LD A,(HL) / INC HL / OUT (BE),A
  code.push(0xaf, 0xd3, 0xbe, 0xd3, 0xbe, 0xd3, 0xbe); // planes 1–3 = 0
  code.push(0x0d); // DEC C
  const jrRow = CRT0_AT + code.length;
  code.push(0x20, rel(jrRow, rowLoop));
  const djnzGlyph = CRT0_AT + code.length;
  code.push(0x10, rel(djnzGlyph, glyphLoop));

  // Fill nametable with space (tile 32), 32×24 entries.
  code.push(0x3e, NAME_VRAM & 0xff, 0xd3, 0xbf, 0x3e, 0x40 | ((NAME_VRAM >>> 8) & 0x3f), 0xd3, 0xbf);
  code.push(0x01, 0x00, 0x03); // LD BC, 768
  const fillLoop = CRT0_AT + code.length;
  code.push(0x3e, TILE_SPACE, 0xd3, 0xbe, 0xaf, 0xd3, 0xbe);
  code.push(0x0b, 0x78, 0xb1); // DEC BC / LD A,B / OR C
  const jrFill = CRT0_AT + code.length;
  code.push(0x20, rel(jrFill, fillLoop));

  emitVdpReg(code, 0x40, 1); // display on
  code.push(0xc3, userOrigin & 0xff, (userOrigin >>> 8) & 0xff); // JP user
  return new Uint8Array(code);
}

export function stampSegaCrt0(rom: Uint8Array, userOrigin: number) {
  const crt0 = emitCrt0(userOrigin);
  if (CRT0_AT + crt0.length > FONT_AT) throw new Error('sega crt0 overlaps font');
  rom[0] = 0xc3;
  rom[1] = CRT0_AT & 0xff;
  rom[2] = (CRT0_AT >>> 8) & 0xff;
  rom[0x38] = 0xed;
  rom[0x39] = 0x4d;
  rom[0x66] = 0xed;
  rom[0x67] = 0x45;
  rom.set(crt0, CRT0_AT);
  rom.set(fontBytes(), FONT_AT);
  if (rom.length >= 0x8000) {
    const header = Buffer.from('TMR SEGA');
    rom.set(header, 0x7ff0);
    rom[0x7fff] = 0x5b; // GG export, 32 KiB
  }
}

export function segaCartSize(origin: number, codeLength: number, hardware: { build: { defsym: Record<string, number>; output?: string } }) {
  if (hardware.build.output !== 'gg') {
    return hardware.build.defsym.__rom_size ?? Math.max(8192, origin + codeLength);
  }
  return hardware.build.defsym.__rom_size ?? 32768;
}

export function segaCodeOrigin(hardware: { build: { defsym: Record<string, number>; output?: string } }) {
  if (hardware.build.output === 'gg') return SEGA_CODE_ORIGIN;
  return hardware.build.defsym.__load_address ?? 0;
}
