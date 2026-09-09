// The two-pass assembler: a program of instructions, labels, and raw bytes
// in, machine code and a listing out.
//
// "Two-pass" is only about labels, not instruction size: every 6502
// instruction's length is fixed by its addressing mode alone (unlike a
// variable-length ISA, there is no encoding to relax), so pass one just
// walks the program once to learn where each label lands, and pass two
// emits real bytes now that every label a branch or an operand names
// resolves to something, forward references included.
import { encode, operandBytes } from './encode.ts';
import type { AddressingMode } from './encode.ts';

export type Operand =
  | { kind: 'value'; value: number }
  | { kind: 'label'; name: string };

export type Directive =
  | { kind: 'label'; name: string }
  | { kind: 'instruction'; mnemonic: string; mode: AddressingMode; operand?: Operand }
  | { kind: 'byte'; values: number[] };

export interface ListingLine {
  address: number;
  bytes: number[];
  text: string;
}

export type AssembleResult =
  | { ok: true; bytes: Uint8Array; listing: ListingLine[]; labels: Map<string, number> }
  | { ok: false; error: string };

/** Where every label lands, or the first problem (a duplicate, or a size the address alone already knows). */
function placeLabels(program: Directive[], origin: number): { ok: true; labels: Map<string, number> } | { ok: false; error: string } {
  const labels = new Map<string, number>();
  let address = origin;
  for (const directive of program) {
    if (directive.kind === 'label') {
      if (labels.has(directive.name)) return { ok: false, error: `label '${directive.name}' is defined more than once` };
      labels.set(directive.name, address);
    } else if (directive.kind === 'instruction') {
      address += 1 + operandBytes(directive.mode);
    } else {
      address += directive.values.length;
    }
  }
  return { ok: true, labels };
}

function resolve(operand: Operand | undefined, labels: Map<string, number>, context: string): { ok: true; value: number } | { ok: false; error: string } {
  if (!operand) return { ok: false, error: `${context} needs an operand` };
  if (operand.kind === 'value') return { ok: true, value: operand.value };
  const value = labels.get(operand.name);
  if (value === undefined) return { ok: false, error: `${context}: undefined label '${operand.name}'` };
  return { ok: true, value };
}

function hex(value: number, digits: 2 | 4): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

/** Conventional 6502 assembly syntax for one operand, in the addressing mode it was encoded with. */
function operandText(mode: AddressingMode, value: number): string {
  switch (mode) {
    case 'implied': return '';
    case 'accumulator': return 'A';
    case 'immediate': return `#$${hex(value, 2)}`;
    case 'zeropage': return `$${hex(value, 2)}`;
    case 'zeropage,x': return `$${hex(value, 2)},X`;
    case 'zeropage,y': return `$${hex(value, 2)},Y`;
    case 'absolute': return `$${hex(value, 4)}`;
    case 'absolute,x': return `$${hex(value, 4)},X`;
    case 'absolute,y': return `$${hex(value, 4)},Y`;
    case 'indirect': return `($${hex(value, 4)})`;
    case '(indirect,x)': return `($${hex(value, 2)},X)`;
    case '(indirect),y': return `($${hex(value, 2)}),Y`;
    case 'relative': return `$${hex(value, 4)}`;
  }
}

/** Assembles `program`, placed starting at `origin`. */
export function assemble(program: Directive[], origin: number): AssembleResult {
  const placed = placeLabels(program, origin);
  if (!placed.ok) return placed;
  const { labels } = placed;

  const bytes: number[] = [];
  const listing: ListingLine[] = [];
  let address = origin;

  for (const directive of program) {
    if (directive.kind === 'label') continue;

    if (directive.kind === 'byte') {
      for (const value of directive.values) {
        if (value < 0 || value > 0xff) {
          return { ok: false, error: `.byte ${value} at $${hex(address, 4)} does not fit in one byte` };
        }
      }
      listing.push({ address, bytes: [...directive.values], text: `.byte ${directive.values.map((v) => `$${hex(v, 2)}`).join(', ')}` });
      bytes.push(...directive.values);
      address += directive.values.length;
      continue;
    }

    const { mnemonic, mode } = directive;
    const context = `${mnemonic} at $${hex(address, 4)}`;
    const encoded = encode(mnemonic, mode);
    if (!encoded.ok) return { ok: false, error: `${context}: ${encoded.error}` };

    const operandByteCount = operandBytes(mode);
    if (operandByteCount === 0) {
      listing.push({ address, bytes: [encoded.opcode], text: mode === 'accumulator' ? `${mnemonic} A` : mnemonic });
      bytes.push(encoded.opcode);
      address += 1;
      continue;
    }

    const resolved = resolve(directive.operand, labels, context);
    if (!resolved.ok) return resolved;

    if (mode === 'relative') {
      // The offset is relative to the address *after* this two-byte
      // instruction — the PC's value once the CPU has fetched it — not to
      // the branch opcode's own address.
      const delta = resolved.value - (address + 2);
      if (delta < -128 || delta > 127) {
        return {
          ok: false,
          error: `${context}: branch to $${hex(resolved.value, 4)} is ${delta} bytes away, out of range (-128..127)`,
        };
      }
      const offset = delta & 0xff;
      listing.push({ address, bytes: [encoded.opcode, offset], text: `${mnemonic} ${operandText(mode, resolved.value)}` });
      bytes.push(encoded.opcode, offset);
      address += 2;
      continue;
    }

    if (operandByteCount === 1) {
      if (resolved.value < 0 || resolved.value > 0xff) {
        return { ok: false, error: `${context}: operand $${hex(resolved.value, 4)} does not fit in ${mode}'s one byte` };
      }
      listing.push({ address, bytes: [encoded.opcode, resolved.value], text: `${mnemonic} ${operandText(mode, resolved.value)}` });
      bytes.push(encoded.opcode, resolved.value);
      address += 2;
      continue;
    }

    // operandByteCount === 2: little-endian.
    if (resolved.value < 0 || resolved.value > 0xffff) {
      return { ok: false, error: `${context}: operand $${hex(resolved.value, 4)} does not fit in ${mode}'s two bytes` };
    }
    const lo = resolved.value & 0xff;
    const hi = (resolved.value >> 8) & 0xff;
    listing.push({ address, bytes: [encoded.opcode, lo, hi], text: `${mnemonic} ${operandText(mode, resolved.value)}` });
    bytes.push(encoded.opcode, lo, hi);
    address += 3;
  }

  return { ok: true, bytes: new Uint8Array(bytes), listing, labels };
}
