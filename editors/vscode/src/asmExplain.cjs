// The per-instruction commentary "View Generated Assembly" can show beside
// each line — `LDA #$06  ; A = 6`, `JSR $0668  ; call screen_blank`,
// `BEQ $043C  ; if zero, loop back to $043C` — so someone who has never
// read 6502 assembly can follow what the machine is doing, one line at a
// time, and someone who has can turn it off (8bitscript.assemblyView.explain).
//
// Two sources, nothing else:
//   - what the CPU does for each of the 56 documented 6502 instructions,
//     phrased as an effect on registers/memory/flags rather than as what
//     the compiler meant by it (that's what the source-line comment above
//     the run is for);
//   - the debug map's own `symbols` (packages/compiler/src/mos/debug.ts),
//     so an address that *is* a global or a function reads by its name.
//
// The same "no fabricated relationship" rule the debug map follows: an
// address that isn't exactly a known symbol (or a byte inside a known
// multi-byte global) stays as `$26`, a near miss is never rounded to the
// nearest name, and an instruction this module doesn't recognize gets no
// comment at all rather than a guess.

// Bytes one global of each scalar type occupies — the compiler's own widths
// (packages/compiler/src/types/index.mjs: 8/16-bit as-is, 24-bit widened to
// 4). A type not listed here (an array, a struct, an older map with no
// `type`) matches by its first byte only, since its extent isn't known.
const TYPE_BYTES = {
  bool: 1,
  tinyint: 1, utinyint: 1,
  smallint: 2, usmallint: 2,
  mediumint: 4, umediumint: 4,
  int: 4, uint: 4,
};

function hex(value, digits) {
  return '$' + value.toString(16).toUpperCase().padStart(digits, '0');
}

/** A number the way a newcomer reads it: decimal, with the hex the listing shows alongside once it stops being obvious at a glance. */
function num(value) {
  return value < 10 ? String(value) : `${value} (${hex(value, 2)})`;
}

/**
 * Indexes a debug map's `symbols` for the lookups describe() makes:
 * function name by exact address, and global name (+ which byte of it) by
 * any address inside the global's own extent.
 */
function indexSymbols(symbols = []) {
  const functions = new Map();
  const globals = [];
  for (const symbol of symbols) {
    if (!symbol || typeof symbol.address !== 'number' || !symbol.name) continue;
    if (symbol.kind === 'function') functions.set(symbol.address, symbol.name);
    else if (symbol.kind === 'global') globals.push({ name: symbol.name, address: symbol.address, bytes: TYPE_BYTES[symbol.type] ?? 1 });
  }
  return {
    functionAt: (address) => functions.get(address) ?? null,
    globalAt(address) {
      for (const global of globals) {
        const offset = address - global.address;
        if (offset >= 0 && offset < global.bytes) return { name: global.name, offset, bytes: global.bytes };
      }
      return null;
    },
  };
}

/** `score`, `score (lo)`, `score (hi)`, `total (byte 2)` — the global an address lands in, or null. */
function globalName(index, address) {
  const hit = index.globalAt(address);
  if (!hit) return null;
  if (hit.bytes === 1) return hit.name;
  if (hit.bytes === 2) return `${hit.name} (${hit.offset === 0 ? 'lo' : 'hi'})`;
  return `${hit.name} (byte ${hit.offset})`;
}

/** How a memory operand reads in a comment: by name when it is a known global, otherwise as `mem[$E848]` so it can't be mistaken for a register or a number. */
function place(index, address, digits) {
  return globalName(index, address) ?? `mem[${hex(address, digits)}]`;
}

/** `tiles[Y]` when the base is exactly a known global, else `mem[$0EB6 + Y]`. */
function indexedPlace(index, address, digits, register) {
  const hit = index.globalAt(address);
  if (hit && hit.offset === 0) return `${hit.name}[${register}]`;
  return `mem[${hex(address, digits)} + ${register}]`;
}

/**
 * Parses the operand text exactly as the assembler prints it
 * (packages/compiler/src/mos/asm/assemble.ts's operandText()) — every
 * addressing mode has one fixed spelling there, so this is a match on
 * those spellings, not a general assembly parser.
 */
function parseOperand(text) {
  if (!text) return { mode: 'implied' };
  if (text === 'A') return { mode: 'accumulator' };
  let m;
  if ((m = /^#\$([0-9A-F]{2})$/.exec(text))) return { mode: 'immediate', value: Number.parseInt(m[1], 16) };
  if ((m = /^\$([0-9A-F]{2}|[0-9A-F]{4})$/.exec(text))) return { mode: 'direct', value: Number.parseInt(m[1], 16), digits: m[1].length };
  if ((m = /^\$([0-9A-F]{2}|[0-9A-F]{4}),([XY])$/.exec(text))) return { mode: 'indexed', value: Number.parseInt(m[1], 16), digits: m[1].length, register: m[2] };
  if ((m = /^\(\$([0-9A-F]{4})\)$/.exec(text))) return { mode: 'indirect', value: Number.parseInt(m[1], 16), digits: 4 };
  if ((m = /^\(\$([0-9A-F]{2}),X\)$/.exec(text))) return { mode: '(indirect,x)', value: Number.parseInt(m[1], 16), digits: 2 };
  if ((m = /^\(\$([0-9A-F]{2})\),Y$/.exec(text))) return { mode: '(indirect),y', value: Number.parseInt(m[1], 16), digits: 2 };
  return null;
}

/** The single bit a one-bit mask names, or -1. */
function singleBit(value) {
  if (value === 0 || (value & (value - 1)) !== 0) return -1;
  return Math.log2(value);
}

/** The operand of a read (LDA/ADC/AND/CMP/...) as a comment reads it: a number, a named or raw place, or an indirect pointer walk. */
function readOperand(index, op) {
  switch (op.mode) {
    case 'immediate': return num(op.value);
    case 'direct': return place(index, op.value, op.digits);
    case 'indexed': return indexedPlace(index, op.value, op.digits, op.register);
    case '(indirect),y': return `mem[pointer at ${place(index, op.value, 2)} + Y]`;
    case '(indirect,x)': return `mem[pointer at ${place(index, op.value, 2)} + X]`;
    default: return null;
  }
}

/** The operand of a write (STA/STX/STY/INC/DEC/ASL/...): the place itself, never a number. */
function writeOperand(index, op) {
  switch (op.mode) {
    case 'direct': return place(index, op.value, op.digits);
    case 'indexed': return indexedPlace(index, op.value, op.digits, op.register);
    case '(indirect),y': return `mem[pointer at ${place(index, op.value, 2)} + Y]`;
    case '(indirect,x)': return `mem[pointer at ${place(index, op.value, 2)} + X]`;
    case 'accumulator': return 'A';
    default: return null;
  }
}

/**
 * Where a branch or jump lands: `go to screen_blank` when the target starts a
 * function, otherwise the address with the direction spelled out — a
 * backward branch is almost always a loop, a forward one almost always
 * skips a block — as `loop back to $043C` / `skip ahead to $049A` for a
 * branch and `jump back to` / `jump ahead to` for a JMP.
 */
function jumpTarget(index, op, from, verbs) {
  const name = index.functionAt(op.value);
  if (name) return `${verbs.named} ${name}`;
  const addr = hex(op.value, 4);
  if (from === undefined || op.value === from) return `${verbs.named} ${addr}`;
  return `${op.value < from ? verbs.back : verbs.ahead} ${addr}`;
}
const BRANCH_VERBS = { named: 'go to', back: 'loop back to', ahead: 'skip ahead to' };
const JUMP_VERBS = { named: 'jump to', back: 'jump back to', ahead: 'jump ahead to' };

/** The bitwise operators, with the one-bit and low-nibble cases read the way a person would. */
function bitwise(op, symbol, bitVerb) {
  if (op.mode !== 'immediate') return null;
  const bit = singleBit(op.value);
  const note = bit >= 0 ? ` (${bitVerb} bit ${bit})`
    : symbol === '&' && op.value === 0x0f ? ' (keep the low nibble)'
    : symbol === '&' && op.value === 0xf0 ? ' (keep the high nibble)'
    : symbol === '^' && op.value === 0xff ? ' (invert every bit)'
    : '';
  return `A = A ${symbol} ${hex(op.value, 2)}${note}`;
}

const BRANCHES = {
  BEQ: 'if zero',
  BNE: 'if not zero',
  BCS: 'if carry set (≥ after a compare)',
  BCC: 'if carry clear (< after a compare)',
  BMI: 'if negative (bit 7 set)',
  BPL: 'if not negative (bit 7 clear)',
  BVS: 'if overflow set',
  BVC: 'if overflow clear',
};

const SHIFTS = {
  ASL: (p) => `${p} <<= 1 (×2; bit 7 → carry)`,
  LSR: (p) => `${p} >>= 1 (÷2; bit 0 → carry)`,
  ROL: (p) => `${p} = (${p} << 1) | carry (continues a multi-byte ×2)`,
  ROR: (p) => `${p} = (${p} >> 1) | (carry << 7) (continues a multi-byte ÷2)`,
};

const FLAGS_AND_STACK = {
  CLC: 'carry = 0 (before an add)',
  SEC: 'carry = 1 (before a subtract)',
  CLI: 'enable interrupts',
  SEI: 'disable interrupts',
  CLD: 'binary (not decimal) arithmetic mode',
  SED: 'decimal (BCD) arithmetic mode',
  CLV: 'overflow = 0',
  PHA: 'push A onto the stack',
  PLA: 'A = pop from the stack',
  PHP: 'push the flags onto the stack',
  PLP: 'flags = pop from the stack',
  TAX: 'X = A', TAY: 'Y = A', TXA: 'A = X', TYA: 'A = Y', TSX: 'X = stack pointer', TXS: 'stack pointer = X',
  INX: 'X += 1', INY: 'Y += 1', DEX: 'X -= 1', DEY: 'Y -= 1',
  RTS: 'return to the caller',
  RTI: 'return from the interrupt',
  NOP: 'do nothing',
  BRK: 'software interrupt (break)',
};

/**
 * One instruction's comment, or '' when there is nothing honest to say.
 *
 * @param {{ assembly: string, address?: number }} instr a debug-map instruction (only `assembly` and `address` are read)
 * @param {ReturnType<typeof indexSymbols>} index from indexSymbols()
 */
function describe(instr, index) {
  const text = (instr.assembly ?? '').trim();
  if (text.startsWith('.byte')) {
    const count = text.slice(5).split(',').filter((s) => s.trim()).length;
    return `data: ${count} byte${count === 1 ? '' : 's'}`;
  }
  const space = text.indexOf(' ');
  const mnemonic = space < 0 ? text : text.slice(0, space);
  if (!/^[A-Z]{3}$/.test(mnemonic)) return '';
  const operandText = space < 0 ? undefined : text.slice(space + 1);
  const op = parseOperand(operandText?.trim());
  if (!op) return '';

  if (FLAGS_AND_STACK[mnemonic]) return FLAGS_AND_STACK[mnemonic];
  if (BRANCHES[mnemonic]) return op.mode === 'direct' ? `${BRANCHES[mnemonic]}, ${jumpTarget(index, op, instr.address, BRANCH_VERBS)}` : '';
  if (SHIFTS[mnemonic]) { const p = writeOperand(index, op); return p ? SHIFTS[mnemonic](p) : ''; }

  const r = () => readOperand(index, op);
  const w = () => writeOperand(index, op);
  switch (mnemonic) {
    case 'LDA': return r() ? `A = ${r()}` : '';
    case 'LDX': return r() ? `X = ${r()}` : '';
    case 'LDY': return r() ? `Y = ${r()}` : '';
    case 'STA': return w() ? `${w()} = A` : '';
    case 'STX': return w() ? `${w()} = X` : '';
    case 'STY': return w() ? `${w()} = Y` : '';
    case 'ADC': return r() ? `A = A + ${r()} + carry` : '';
    case 'SBC': return r() ? `A = A - ${r()} - borrow` : '';
    case 'AND': return bitwise(op, '&', 'keep') ?? (r() ? `A = A & ${r()}` : '');
    case 'ORA': return bitwise(op, '|', 'set') ?? (r() ? `A = A | ${r()}` : '');
    case 'EOR': return bitwise(op, '^', 'flip') ?? (r() ? `A = A ^ ${r()}` : '');
    case 'CMP': return r() ? `compare A with ${r()} (sets the flags for the next branch)` : '';
    case 'CPX': return r() ? `compare X with ${r()} (sets the flags for the next branch)` : '';
    case 'CPY': return r() ? `compare Y with ${r()} (sets the flags for the next branch)` : '';
    case 'BIT': return r() ? `test ${r()} against A (flags only; A unchanged)` : '';
    case 'INC': return w() ? `${w()} += 1` : '';
    case 'DEC': return w() ? `${w()} -= 1` : '';
    case 'JSR': return op.mode === 'direct' ? `call ${index.functionAt(op.value) ?? `the subroutine at ${hex(op.value, 4)}`}` : '';
    case 'JMP':
      if (op.mode === 'direct') return jumpTarget(index, op, instr.address, JUMP_VERBS);
      if (op.mode === 'indirect') return `jump to the address stored at ${place(index, op.value, 4)}`;
      return '';
    default: return '';
  }
}

module.exports = { describe, indexSymbols, parseOperand, TYPE_BYTES };
