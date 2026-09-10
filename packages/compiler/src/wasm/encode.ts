// Low-level WebAssembly binary format encoding: LEB128 varints and section
// framing. No external encoder, no `binaryen`/`wabt` dependency — the
// compiler writes the module bytes itself, the same "own the whole
// pipeline" call packages/compiler/src/mos/asm/encode.ts made for 6502
// opcodes. This file needs far less of that discipline than that one did:
// wasm has no addressing modes to choose between, no relative offsets that
// can drift out of range, nothing to relax.
//
// Reference: the WebAssembly Core Specification's Binary Format
// (webassembly.github.io/spec/core/binary), sections 5.2 (values), 5.4
// (types), 5.5 (modules).

/** A wasm value type, as its one-byte encoding. Every 8bitscript integer
 * type up to 32 bits (utinyint..uint, storageBytes tops out at 4) fits in
 * `i32` — see the wasm rail's own "one value type covers every declared
 * width" note. `i64`/`f32`/`f64` are declared for completeness; nothing
 * lowers to them yet. */
export const ValType = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
} as const;
export type ValType = (typeof ValType)[keyof typeof ValType];

/** Section ids, in the order the binary format requires them to appear. */
export const SectionId = {
  type: 1,
  import: 2,
  function: 3,
  table: 4,
  memory: 5,
  global: 6,
  export: 7,
  start: 8,
  element: 9,
  code: 10,
  data: 11,
} as const;

/** The kind byte an export (or import) entry names what it refers to as. */
export const ExternalKind = {
  func: 0x00,
  table: 0x01,
  memory: 0x02,
  global: 0x03,
} as const;

/** A function type's own tag byte (0x60), ahead of its param/result vectors. */
const FUNC_TYPE_TAG = 0x60;

/**
 * `value` as an unsigned LEB128 byte sequence. Every index, count, and
 * offset in a wasm module is encoded this way — never a fixed-width
 * integer. Uses ordinary arithmetic rather than 32-bit bitwise operators
 * (which JavaScript truncates to a signed 32-bit int) so this stays correct
 * past 2^31, the way a large data-section offset eventually could.
 */
export function unsignedLEB128(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`unsignedLEB128: ${value} is not a non-negative integer`);
  }
  const bytes: number[] = [];
  let v = value;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return bytes;
}

/**
 * `value` as a signed LEB128 byte sequence — how an `i32.const`/`i64.const`
 * operand is encoded. Bitwise operators are correct here: signed LEB128's
 * own sign-extension check (`byte & 0x40`) only needs to see 32 bits, which
 * is the full range this project's widest integer type (`int`/`uint`,
 * 32-bit) ever produces.
 */
export function signedLEB128(value: number): number[] {
  if (!Number.isInteger(value)) throw new RangeError(`signedLEB128: ${value} is not an integer`);
  const bytes: number[] = [];
  let v = value;
  let more = true;
  while (more) {
    let byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    bytes.push(byte);
  }
  return bytes;
}

/** A count (unsigned LEB128) followed by every item's own bytes, concatenated. */
export function vector(items: number[][]): number[] {
  return [...unsignedLEB128(items.length), ...items.flat()];
}

/** A wasm `name`: its UTF-8 byte length (unsigned LEB128), then the bytes themselves. */
export function encodeName(name: string): number[] {
  const bytes = [...new TextEncoder().encode(name)];
  return [...unsignedLEB128(bytes.length), ...bytes];
}

/** A block/loop/if's own result shape. `empty` is by far the common case —
 * a statement-level construct produces no value on the stack. A single
 * value type (e.g. `ValType.i32`) is also legal here directly, with no
 * separate encoding needed: this was part of the binary format from the
 * start (not the later multi-value proposal, which only adds the
 * more-than-one-result/param case, `binop`'s own `&&`/`||` short-circuit
 * lowering doesn't need). */
export const BlockType = {
  empty: 0x40,
} as const;

/** Instruction opcodes. Grows alongside instruction selection; `end` is the
 * one every function body needs regardless — it closes the body itself,
 * not just a nested `block`/`loop`/`if`. Milestone 2 ("arithmetic and
 * control flow") is everything below `end` here — every opcode a `binop`/
 * `unop`/`if`/`while`/`for`/`break`/`continue`/`return` can lower to,
 * restricted to `i32` (see "Hello, WASM"'s own "one value type covers
 * every declared width" note — nothing here needs `i64`/`f32`/`f64` yet). */
export const Opcode = {
  unreachable: 0x00,
  end: 0x0b,
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  br: 0x0c,
  brIf: 0x0d,
  return: 0x0f,
  call: 0x10,
  drop: 0x1a,
  localGet: 0x20,
  localSet: 0x21,
  i32Const: 0x41,
  i32Eqz: 0x45,
  i32Eq: 0x46,
  i32Ne: 0x47,
  i32LtS: 0x48,
  i32LtU: 0x49,
  i32GtS: 0x4a,
  i32GtU: 0x4b,
  i32LeS: 0x4c,
  i32LeU: 0x4d,
  i32GeS: 0x4e,
  i32GeU: 0x4f,
  i32Add: 0x6a,
  i32Sub: 0x6b,
  i32And: 0x71,
  i32Xor: 0x73,
  i32Load8U: 0x2d,
  i32Store8: 0x3a,
  globalGet: 0x23,
  globalSet: 0x24,
} as const;

/** A load/store instruction's own immediate: alignment (a hint, log2 of the
 * expected natural alignment — 0 is always valid, "no particular
 * alignment") and a constant byte offset added to the dynamic address on
 * the stack. `memory.write`/`memory.read` are byte-only at the language
 * level (ir/index.mjs's own `memoryIntrinsic()` — there's no 16-bit
 * variant to fold a second byte's offset into yet), so every load/store
 * this backend emits today uses `memarg(0, 0)`: no alignment claim, the
 * address expression's own value is the whole address. */
export function memarg(align: number, offset: number): number[] {
  return [...unsignedLEB128(align), ...unsignedLEB128(offset)];
}

/** A global's mutability flag, the byte right after its value type in both
 * the global section's own entry and an import's global type. */
export const Mutability = {
  const: 0x00,
  var: 0x01,
} as const;

/** One function type: `0x60`, the param vector, the result vector. */
export function funcType(params: ValType[], results: ValType[]): number[] {
  return [FUNC_TYPE_TAG, ...vector(params.map((p) => [p])), ...vector(results.map((r) => [r]))];
}

/** `limits`: a memory or table's size — `min` pages, and `max` if given (the flag byte records which). */
export function limits(min: number, max?: number): number[] {
  if (max === undefined) return [0x00, ...unsignedLEB128(min)];
  return [0x01, ...unsignedLEB128(min), ...unsignedLEB128(max)];
}

/** One section: its id byte, the encoded byte length of `content`, then `content` itself. Omitted entirely by the caller when `content` would be empty — an empty section is legal but pointless. */
export function section(id: number, content: number[]): number[] {
  return [id, ...unsignedLEB128(content.length), ...content];
}

/** The 8-byte module header every `.wasm` file starts with: magic number, then version 1. */
export const MODULE_HEADER: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** Concatenates the header and every given section (in the order given — callers are responsible for the binary format's own required section order) into the final module bytes. */
export function assembleModule(sections: number[][]): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...MODULE_HEADER, ...sections.flat()]);
}
