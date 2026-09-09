// The stock NMOS 6502's encoding table: mnemonic + addressing mode → opcode
// byte. The 56 documented instructions, every legal addressing mode each
// one takes — 151 opcodes in total, cross-checked against a published
// reference (masswerk.at/6502/6502_instruction_set.html) rather than typed
// from memory, because a single wrong byte here is a silent, hard-to-catch
// bug in everything built on top of it.
//
// Deliberately absent: the 65C02's extra opcodes (STZ, BRA, PHX, ...) and
// the NMOS chip's undocumented opcodes — both are `CpuVariant` fields in
// ../index.ts already, for whichever machine's backend needs them first
// (not the PET; its CPU entry carries `extraOpcodes: []`). Adding them
// means extending this table and gating lookups by `CpuVariant`, not
// reshaping it — nothing here is designed around their absence.

/** Every addressing mode the stock 6502 has. */
export type AddressingMode =
  | 'implied'
  | 'accumulator'
  | 'immediate'
  | 'zeropage'
  | 'zeropage,x'
  | 'zeropage,y'
  | 'absolute'
  | 'absolute,x'
  | 'absolute,y'
  | 'indirect'
  | '(indirect,x)'
  | '(indirect),y'
  | 'relative';

/** How many operand bytes follow the opcode byte itself, by addressing mode. */
export function operandBytes(mode: AddressingMode): 0 | 1 | 2 {
  if (mode === 'implied' || mode === 'accumulator') return 0;
  if (mode === 'absolute' || mode === 'absolute,x' || mode === 'absolute,y' || mode === 'indirect') return 2;
  return 1;
}

/** Total instruction length in bytes: the opcode plus its operand. */
export function instructionBytes(mode: AddressingMode): 1 | 2 | 3 {
  return (1 + operandBytes(mode)) as 1 | 2 | 3;
}

/** mnemonic → the opcode byte for each addressing mode it supports. */
export const OPCODES: Readonly<Record<string, Readonly<Partial<Record<AddressingMode, number>>>>> = {
  ADC: {
    immediate: 0x69, zeropage: 0x65, 'zeropage,x': 0x75, absolute: 0x6d,
    'absolute,x': 0x7d, 'absolute,y': 0x79, '(indirect,x)': 0x61, '(indirect),y': 0x71,
  },
  AND: {
    immediate: 0x29, zeropage: 0x25, 'zeropage,x': 0x35, absolute: 0x2d,
    'absolute,x': 0x3d, 'absolute,y': 0x39, '(indirect,x)': 0x21, '(indirect),y': 0x31,
  },
  ASL: { accumulator: 0x0a, zeropage: 0x06, 'zeropage,x': 0x16, absolute: 0x0e, 'absolute,x': 0x1e },
  BCC: { relative: 0x90 },
  BCS: { relative: 0xb0 },
  BEQ: { relative: 0xf0 },
  BIT: { zeropage: 0x24, absolute: 0x2c },
  BMI: { relative: 0x30 },
  BNE: { relative: 0xd0 },
  BPL: { relative: 0x10 },
  BRK: { implied: 0x00 },
  BVC: { relative: 0x50 },
  BVS: { relative: 0x70 },
  CLC: { implied: 0x18 },
  CLD: { implied: 0xd8 },
  CLI: { implied: 0x58 },
  CLV: { implied: 0xb8 },
  CMP: {
    immediate: 0xc9, zeropage: 0xc5, 'zeropage,x': 0xd5, absolute: 0xcd,
    'absolute,x': 0xdd, 'absolute,y': 0xd9, '(indirect,x)': 0xc1, '(indirect),y': 0xd1,
  },
  CPX: { immediate: 0xe0, zeropage: 0xe4, absolute: 0xec },
  CPY: { immediate: 0xc0, zeropage: 0xc4, absolute: 0xcc },
  DEC: { zeropage: 0xc6, 'zeropage,x': 0xd6, absolute: 0xce, 'absolute,x': 0xde },
  DEX: { implied: 0xca },
  DEY: { implied: 0x88 },
  EOR: {
    immediate: 0x49, zeropage: 0x45, 'zeropage,x': 0x55, absolute: 0x4d,
    'absolute,x': 0x5d, 'absolute,y': 0x59, '(indirect,x)': 0x41, '(indirect),y': 0x51,
  },
  INC: { zeropage: 0xe6, 'zeropage,x': 0xf6, absolute: 0xee, 'absolute,x': 0xfe },
  INX: { implied: 0xe8 },
  INY: { implied: 0xc8 },
  JMP: { absolute: 0x4c, indirect: 0x6c },
  JSR: { absolute: 0x20 },
  LDA: {
    immediate: 0xa9, zeropage: 0xa5, 'zeropage,x': 0xb5, absolute: 0xad,
    'absolute,x': 0xbd, 'absolute,y': 0xb9, '(indirect,x)': 0xa1, '(indirect),y': 0xb1,
  },
  LDX: { immediate: 0xa2, zeropage: 0xa6, 'zeropage,y': 0xb6, absolute: 0xae, 'absolute,y': 0xbe },
  LDY: { immediate: 0xa0, zeropage: 0xa4, 'zeropage,x': 0xb4, absolute: 0xac, 'absolute,x': 0xbc },
  LSR: { accumulator: 0x4a, zeropage: 0x46, 'zeropage,x': 0x56, absolute: 0x4e, 'absolute,x': 0x5e },
  NOP: { implied: 0xea },
  ORA: {
    immediate: 0x09, zeropage: 0x05, 'zeropage,x': 0x15, absolute: 0x0d,
    'absolute,x': 0x1d, 'absolute,y': 0x19, '(indirect,x)': 0x01, '(indirect),y': 0x11,
  },
  PHA: { implied: 0x48 },
  PHP: { implied: 0x08 },
  PLA: { implied: 0x68 },
  PLP: { implied: 0x28 },
  ROL: { accumulator: 0x2a, zeropage: 0x26, 'zeropage,x': 0x36, absolute: 0x2e, 'absolute,x': 0x3e },
  ROR: { accumulator: 0x6a, zeropage: 0x66, 'zeropage,x': 0x76, absolute: 0x6e, 'absolute,x': 0x7e },
  RTI: { implied: 0x40 },
  RTS: { implied: 0x60 },
  SBC: {
    immediate: 0xe9, zeropage: 0xe5, 'zeropage,x': 0xf5, absolute: 0xed,
    'absolute,x': 0xfd, 'absolute,y': 0xf9, '(indirect,x)': 0xe1, '(indirect),y': 0xf1,
  },
  SEC: { implied: 0x38 },
  SED: { implied: 0xf8 },
  SEI: { implied: 0x78 },
  STA: {
    zeropage: 0x85, 'zeropage,x': 0x95, absolute: 0x8d,
    'absolute,x': 0x9d, 'absolute,y': 0x99, '(indirect,x)': 0x81, '(indirect),y': 0x91,
  },
  STX: { zeropage: 0x86, 'zeropage,y': 0x96, absolute: 0x8e },
  STY: { zeropage: 0x84, 'zeropage,x': 0x94, absolute: 0x8c },
  TAX: { implied: 0xaa },
  TAY: { implied: 0xa8 },
  TSX: { implied: 0xba },
  TXA: { implied: 0x8a },
  TXS: { implied: 0x9a },
  TYA: { implied: 0x98 },
};

export type EncodeResult =
  | { ok: true; opcode: number; bytes: 1 | 2 | 3 }
  | { ok: false; error: string };

/** The opcode byte and instruction length for one mnemonic and addressing mode, or why not. */
export function encode(mnemonic: string, mode: AddressingMode): EncodeResult {
  const modes = OPCODES[mnemonic];
  if (!modes) return { ok: false, error: `unknown mnemonic '${mnemonic}'` };
  const opcode = modes[mode];
  if (opcode === undefined) {
    const supported = Object.keys(modes).join(', ');
    return { ok: false, error: `${mnemonic} does not take ${mode} addressing (it takes: ${supported})` };
  }
  return { ok: true, opcode, bytes: instructionBytes(mode) };
}
