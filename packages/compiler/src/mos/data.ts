// The data section: string literals and const arrays, laid out as labeled
// bytes so the code that references them (lower/index.ts's `string`,
// `stringLength`, `stringByte`, and `index` rules) can name them as
// ordinary assembler labels. Two label-naming functions are exported here
// specifically so both sides agree on a name without either one needing the
// other's data — lower/index.ts names a label from a bare index or a
// global's name, and mos/index.ts (which actually owns the string table and
// the global list) builds the bytes those same names point at.
//
// This is appended to the END of the combined program in mos/index.ts,
// after every function's own code — not passed to link()'s separate `data`
// section. link() assembles code and data as two independent passes, each
// with its own label map, and only merges the two maps afterward — so a
// `LDA #<label` in code, where `label` is one of these, would resolve
// against a label map that doesn't have it yet and fail "undefined label."
// One assembly pass over one program, code then data with no gap, sees
// every label regardless of which half defines it and which half uses it.
import type { Directive } from './asm/assemble.ts';
import { storageBytes } from '../types/index.mjs';

/** One entry of the linked IR's own string table (packages/compiler/src/ir/index.mjs, merged and deduplicated by the linker) — ir.strings[i] is this. */
export interface IrString {
  text: string;
  bytes: number[];
}

/** A const array global (packages/compiler/src/ir/index.mjs's arrayGlobal()) with everything the data section needs to lay it out: its element type (for width), its element count, and its fully-resolved initializer (every element a plain number by the time the linker hands this to a backend — see linker/index.mjs's own global-init resolution). */
export interface DataArrayGlobal {
  name: string;
  type: string;
  array: number;
  init: number[];
}

/** The label a string literal's data lands at, by its index in ir.strings — shared between this module (which defines the bytes) and lower/index.ts (which references them by name only, never the bytes themselves). */
export function stringLabel(index: number): string {
  return `__8bs_str_${index}`;
}

/** The label a const array global's data lands at, by the global's own (already link-renamed) name. */
export function arrayLabel(name: string): string {
  return `__8bs_arr_${name}`;
}

function byteDirective(values: number[]): Directive {
  return { kind: 'byte', values };
}

/**
 * String literals and const arrays, laid out as `label` / `.byte` pairs.
 * A string is length-prefixed (one byte, 0..255 — ir/index.mjs's own
 * format, and the checker's STRING_TOO_LONG already refuses anything
 * longer). When `usedIndexes` is passed, a literal the optimizer already
 * folded into stores is omitted. A const array is its elements' raw bytes,
 * little-endian for a 2-byte element type (the 6502 is little-endian
 * throughout this backend — see prg.ts, encode.ts's own operand encoding).
 */
export function buildDataSection(strings: IrString[], arrays: DataArrayGlobal[], usedIndexes?: Set<number>): Directive[] {
  const out: Directive[] = [];
  strings.forEach((s, index) => {
    if (usedIndexes && !usedIndexes.has(index)) return;
    out.push({ kind: 'label', name: stringLabel(index) }, byteDirective([s.bytes.length, ...s.bytes]));
  });
  for (const array of arrays) {
    const width = storageBytes(array.type);
    const values: number[] = [];
    for (const element of array.init) {
      values.push(element & 0xff);
      if (width === 2) values.push((element >> 8) & 0xff);
    }
    out.push({ kind: 'label', name: arrayLabel(array.name) }, byteDirective(values));
  }
  return out;
}
