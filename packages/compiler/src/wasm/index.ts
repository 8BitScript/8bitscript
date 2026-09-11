// The web backend: IR in, .wasm out.
//
// The module this file writes must satisfy the ABI packages/cli/src/
// wasm-host.mjs and packages/cli/src/web-runtime.mjs already host: exactly
// one exported function (the entry), exported memory, and at most one
// import, `env.waitFrame`. Both hosts are already built and tested against
// that contract (the "Hello, WASM" roadmap's own STATUS section) — nothing
// in this file changes either of them.
//
// Milestone 1 ("a module that validates") got just enough of build() to emit
// the smallest legal module for an entry function with an empty body.
// Milestone 2 ("arithmetic and control flow") added real instruction
// selection (./lower.ts): binop/unop/if/while/for/break/continue/return,
// all `i32`, masked to their declared width. Milestone 3 ("globals and
// memory") adds memoryRead/memoryWrite (always byte-granular — there's no
// 16-bit variant at the language level, ir/index.mjs's own
// memoryIntrinsic()) and a wasm global-section entry for every non-pinned
// scalar `let`, no allocator needed. Milestone 4 ("functions and calls")
// lowers every function in ir.functions, not just the entry: each gets its
// own type/function/code-section entry and a real function index, `call`
// pushes its arguments and emits wasm's own `call`, and parameters are a
// function's own leading locals — free from its function type, unlike
// mos's own two-pass zero-page address assignment. Only the entry is
// exported (wasm-host.mjs's own "exactly one exported function" contract).
// Recursion is allowed, not refused for parity with mos's own cycle check:
// wasm's call stack is real, not a shared frame a second call would
// clobber, so there's nothing here that needs refusing.
//
// Milestone 5 ("strings and const data") adds a wasm data section: every
// string literal and every `const` array gets its own fixed address,
// starting at DATA_BASE below, laid out once before any function body is
// lowered (the same two-pass shape as globals/functions). A `string` value
// at runtime is just that address — a pointer to a one-byte length prefix
// followed by the characters (ir/index.mjs's own string-table format) — so
// a `string` parameter needed no lowering rule beyond the one every other
// `i32`-valued parameter already has. As of 0.2.2 a `let` (RAM) array and
// a `string<N>` buffer get linear-memory homes of their own too (zeroed
// by default — wasm memory's own starting state — a data segment only
// when initialized), with `storeIndex`, `stringCopy`, and 2-byte element
// reads lowered to match: milestone 5's two named gaps, closed by the
// first real program that needed them (2048). An `@address`
// (hardware-pinned) global of any kind stays refused by name — hardware
// another machine would map, nothing the web target owns.
//
// Milestone 6 ("waitFrame(), and the real Hello World") wires the
// `env.waitFrame` import: a whole-program scan (containsWaitFrame, below)
// decides once, up front, whether any function anywhere calls waitFrame()
// — if so, the import gets a type-section entry (index 0, ahead of every
// defined function's own type — see importFuncCount below) and an
// import-section entry, and the declared memory becomes shared (limits'
// own `shared` flag, with a max equal to its min — nothing here ever grows
// it) so web-runtime.mjs's worker can hand the page a live view of it
// instead of a one-time snapshot copy. A program that never calls
// waitFrame() gets none of this — plain, unshared memory and no import
// section, unchanged from every earlier milestone.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { storageBytes } from '../types/index.mjs';
import { optimizeReachable } from '../linker/optimize.mjs';
import { ExternalKind, Mutability, Opcode, SectionId, ValType, activeDataSegment, assembleModule, encodeName, funcType, importFunc, limits, section, signedLEB128, unsignedLEB128, vector } from './encode.ts';
import { lower } from './lower.ts';
import type { IrStatement } from './lower.ts';

export interface IrParam {
  name: string;
  /** `'array'` here is a parameter shape not lowered yet — checked by name
   * in `build()`, the same refusal-by-name every other unhandled shape in
   * this backend gets rather than a guess. `'string'` is lowered as of
   * milestone 5: a string parameter is just an `i32` pointer, the same as
   * any other scalar parameter, so it needs no special case here at all. */
  type: string;
  /** An array parameter's own element type (ir/index.mjs's own
   * `function()`); irrelevant to every scalar parameter, and to the array
   * refusal itself, which reads only `type`. */
  elementType?: string;
}

export interface IrFunction {
  name: string;
  body: IrStatement[];
  params?: IrParam[];
  /** `fn.returnType ?? 'void'`, the same convention mos/index.ts holds
   * itself to — wasm has no narrower-than-i32 value type, so any non-void
   * numeric return type becomes a single `i32` result; a narrower type's
   * own width is a `lower.ts` masking concern, not a function-type one. */
  returnType?: string | null;
}

export interface IrGlobal {
  name: string;
  type: string;
  /** Non-null for an `@address(...)`-pinned global — a hardware register,
   * or, for an array, hardware-mapped memory (a screen RAM, say) — not
   * owned by this backend either way; not lowered yet (nothing in
   * @8bitscript/web declares one today, per mos/index.ts's own precedent
   * this backend reads for the same field). */
  address: number | null;
  /** A scalar global's own initial value (always a plain number by the
   * time linked IR reaches a backend — linker/index.mjs resolves every
   * initializer first), or a const array's own element values in
   * declaration order (ir/index.mjs's own arrayGlobal()) when `array` is
   * set. Never an IrExpr. */
  init?: number | number[] | null;
  /** Set (to the array's own element count) for an array global — const
   * (`constant: true`, lowered as of milestone 5, data-section bytes no
   * code ever writes) or `let` (RAM, still refused by name: nothing in
   * @8bitscript/web declares one). */
  array?: number;
  /** True for `const NAME: array<T, N> = [...]`, false for `let`. Only
   * meaningful alongside `array`. */
  constant?: boolean;
}

/** One entry of the linked IR's own string table (ir/index.mjs's own
 * `strings`, merged and deduplicated by the linker) — `ir.strings[i]` is
 * this, and a `{ kind: 'string', index: i }` IR node names it by that same
 * index. */
export interface IrString {
  text: string;
  bytes: number[];
}

/** The linked IR's top-level shape this backend reads — the same real IR
 * mos/index.ts's own IrProgram describes, narrowed to what this milestone
 * looks at. Grows alongside instruction selection, not ahead of it. */
export interface IrProgram {
  entry: string;
  functions: IrFunction[];
  globals?: IrGlobal[];
  strings?: IrString[];
}

export interface BuildOptions {
  outFile: string;
  frameRate: number;
  /** Asks for `BuildResult`'s own `sizeReport` — the CLI's `--size` flag (packages/cli/src/build.mjs), same option mos/index.ts's own BuildOptions carries. */
  report?: boolean;
}

/** One named piece of the module `options.report` breaks a build's own size down into — mirrors mos/index.ts's own SizeReportEntry. */
export interface SizeReportEntry {
  name: string;
  bytes: number;
}

export type BuildResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; sizeReport?: SizeReportEntry[] }
  | { ok: false; error: string };

// One page (64 KiB) of linear memory, minimum — @8bitscript/web's own
// WebRegisters layout (packages/web/src/index.8bs) uses under 2.5 KiB of
// it today. Milestone 5 places string/const-array data starting at
// DATA_BASE below and grows the memory section's own declared minimum
// past one page only when a program's own data genuinely needs it
// (buildDataLayout, in build()) — most programs still get exactly one
// page, unchanged from milestone 1.
const MEMORY_PAGES = 1;
const PAGE_BYTES = 64 * 1024;

// Where this backend's own data section starts. No formal contract exists
// yet between this backend and a package's own `.8bs` source about which
// low memory addresses are "taken" — @8bitscript/web's own WebRegisters
// (packages/web/src/index.8bs) is just ordinary program code computing
// ordinary literal addresses (0 through 2002 today), not something this
// backend can see or reason about structurally the way it owns wasm
// globals or its own const-array table. Placing data right after
// WebRegisters' own current high-water mark would work today and break
// silently the day that package adds one more byte. 8192 (0x2000) is a
// deliberately generous, round, memorable boundary — four times what the
// only real user of low memory needs today — chosen to survive that
// growth without this backend needing to know about it. This is the
// "Hello, WASM" roadmap's own "linear memory: shared vs. plain, sized how,
// laid out how" decision, narrowed but not fully closed: a real
// cross-package memory-map convention (every hardware-style package
// declaring the range it needs, checked for overlap) is still better than
// a guessed boundary, and isn't built yet.
const DATA_BASE = 8192;

/** Whether any function in the whole program calls waitFrame() anywhere —
 * `build()`'s own one whole-program pass, before any function body is
 * lowered, to decide whether the module needs the `env.waitFrame` import
 * at all (see the file header). `waitFrame` has no expression form
 * (ir/index.mjs refuses it outside statement position), so this only ever
 * needs to walk statement lists — no expression tree to descend into.
 * `for`'s own `init`/`update` don't need a recursive call of their own:
 * they're always a single `local` or `assign` statement (ir/index.mjs's
 * own grammar), never a kind that itself holds a nested statement list, so
 * the top of this loop already checks them everywhere they can appear
 * (`for`'s own `body` — where the actual loop contents live — is covered
 * by the `s.body` branch below like every other loop). */
function containsWaitFrame(statements: IrStatement[]): boolean {
  for (const s of statements) {
    if (s.kind === 'waitFrame') return true;
    if (s.then && containsWaitFrame(s.then)) return true;
    if (s.else && containsWaitFrame(s.else)) return true;
    if (s.body && containsWaitFrame(s.body)) return true;
  }
  return false;
}

/** Lowers `ir` to WebAssembly, writes `outFile`, and returns the bytes. */
export async function build(ir: IrProgram, options: BuildOptions): Promise<BuildResult> {
  const entryFn = ir.functions.find((fn) => fn.name === ir.entry);
  if (!entryFn) return { ok: false, error: `the linked entry point '${ir.entry}' names no function in ir.functions` };

  // Everything from here on compiles only what the entry can actually
  // reach — see linker/optimize.mjs's optimizeReachable (prune, fold,
  // prune) and mos/index.ts's identical call right after its own
  // equivalent check.
  const { functions, globals } = optimizeReachable(ir);

  // Every non-pinned scalar global gets a wasm global-section entry,
  // addressed by declaration order — no allocator, no budget, unlike the
  // mos backend's own zero page (see "Hello, WASM"'s own "globals need no
  // allocator" note). A const array gets a data-section entry instead (its
  // own fixed address in linear memory, laid out below); a `let`
  // (RAM) array, an `@address`-pinned global of any kind, and a
  // `string<N>` variable are all still refused by name — real gaps, not
  // this milestone's own scope (see the file header).
  const globalDefs: { name: string; init: number }[] = [];
  const arrayGlobals: { name: string; type: string; length: number; init: number[] | null; mutable: boolean }[] = [];
  for (const g of globals) {
    if (g.address !== null && g.address !== undefined) {
      return { ok: false, error: `'${g.name}': a pinned global (@address(...)) is not lowered yet` };
    }
    if (g.array !== undefined) {
      // Const and `let` arrays alike get a fixed linear-memory address
      // (0.2.2 — the `let` case was milestone 5's named gap). A mutable
      // array with no initializer needs no data segment at all: wasm
      // linear memory starts zeroed, which is exactly the language's own
      // "zero unless written `= [..]`" rule (ir/index.mjs's arrayGlobal).
      // A `string<N>` variable arrives here as this same shape — a
      // mutable utinyint array of capacity+1 bytes, its init already
      // length-prefixed (ir/index.mjs's stringGlobal) — so its buffer
      // needs nothing extra beyond what any other `let` array gets.
      arrayGlobals.push({ name: g.name, type: g.type, length: g.array, init: g.init as number[] | null, mutable: !g.constant });
      continue;
    }
    if (g.type === 'string') {
      return { ok: false, error: `'${g.name}' is a bare string global: never produced by the front end (ir/index.mjs refuses a capacity-less string variable) — kept refused as defense, same as the mos backend` };
    }
    globalDefs.push({ name: g.name, init: typeof g.init === 'number' ? g.init : 0 });
  }
  const globalIndex = new Map(globalDefs.map((g, i) => [g.name, i]));

  // Data layout: every string literal, then every const array, placed
  // back to back starting at DATA_BASE — order between the two doesn't
  // matter (nothing reads across the boundary), only that each gets a
  // fixed address before any function body (which might reference it) is
  // lowered. A const array wider than 1 byte per element is refused where
  // it's actually read (lower.ts's own 'index' rule), not here: nothing in
  // @8bitscript/web declares one today to have tested this against, and
  // refusing by name at the read site keeps this loop from guessing at a
  // 2-byte layout it can't verify.
  let cursor = DATA_BASE;
  const dataSegments: number[][] = [];
  const stringAddrs: number[] = [];
  for (const s of ir.strings ?? []) {
    const address = cursor;
    stringAddrs.push(address);
    const bytes = [s.bytes.length, ...s.bytes];
    dataSegments.push(activeDataSegment(address, bytes));
    cursor += bytes.length;
  }
  const arrayIndex = new Map<string, { address: number; elementWidth: number; mutable: boolean }>();
  for (const a of arrayGlobals) {
    const elementWidth = storageBytes(a.type);
    if (elementWidth !== 1 && elementWidth !== 2) {
      return { ok: false, error: `'${a.name}' is an array<${a.type}, ${a.length}>: only a 1- or 2-byte element is lowered yet` };
    }
    const address = cursor;
    arrayIndex.set(a.name, { address, elementWidth, mutable: a.mutable });
    if (a.init) {
      const bytes: number[] = [];
      for (const value of a.init) {
        bytes.push(value & 0xff);
        if (elementWidth === 2) bytes.push((value >> 8) & 0xff);
      }
      dataSegments.push(activeDataSegment(address, bytes));
    }
    // An initializer-less `let` array emits no segment: linear memory is
    // already zero, which is its declared starting state.
    cursor += a.length * elementWidth;
  }
  // MEMORY_PAGES stays the floor; a program whose own data outgrows one
  // page gets exactly as many more as its own layout needs, rounded up —
  // most programs' data is nowhere close, and still get one page, same as
  // every earlier milestone.
  const memoryPages = Math.max(MEMORY_PAGES, Math.ceil(cursor / PAGE_BYTES));

  // Whether the module needs the `env.waitFrame` import at all — decided
  // once, up front, from the whole program, the same two-pass shape as
  // globals/functions/data. `importFuncCount` is 0 or 1 only: this backend
  // never declares any import but this one.
  const usesWaitFrame = functions.some((fn) => containsWaitFrame(fn.body));
  const importFuncCount = usesWaitFrame ? 1 : 0;

  // Every function's own wasm function index, assigned once, up front, in
  // declaration order — before any body is lowered, so a call can reach a
  // function declared later in this array, or itself (recursion; see
  // lower.ts's own Ctx.functions doc). `importFuncCount` accounts for the
  // `env.waitFrame` import, when declared: it occupies function index 0,
  // ahead of every defined function, which is why every defined function's
  // own index is computed from here rather than assumed to start at 0.
  const functionSites = new Map(functions.map((fn, i) => [
    fn.name,
    {
      index: importFuncCount + i,
      paramCount: (fn.params ?? []).length,
      returnsValue: !!fn.returnType && fn.returnType !== 'void',
    },
  ]));
  if (functionSites.size !== functions.length) {
    return { ok: false, error: 'two functions in ir.functions share the same name — a linker bug, not something this backend can guess a fix for' };
  }
  const waitFrameIndex = usesWaitFrame ? 0 : null;

  const loweredFns: { index: number; paramCount: number; returnsValue: boolean; localCount: number; code: number[] }[] = [];
  for (const fn of functions) {
    for (const p of fn.params ?? []) {
      if (p.type === 'array') return { ok: false, error: `'${fn.name}(${p.name})': an array parameter is not lowered yet — a real gap milestone 5 left open` };
    }
    const site = functionSites.get(fn.name)!;
    const lowered = lower(fn.body, { params: fn.params ?? [], globals: globalIndex, functions: functionSites, strings: stringAddrs, arrays: arrayIndex, waitFrameIndex });
    if (!lowered.ok) return { ok: false, error: `'${fn.name}': ${lowered.error}` };
    loweredFns.push({ index: site.index, paramCount: site.paramCount, returnsValue: site.returnsValue, localCount: lowered.localCount, code: lowered.code });
  }
  const entryIndex = functionSites.get(ir.entry)!.index;

  // type section: the `env.waitFrame` import's own type first, when
  // declared (type index 0 — it always occupies the function index space
  // ahead of every defined function, so its type has to lead the type
  // section the same way), then one type per defined function, in the
  // same order. Deduplicating identical signatures between two defined
  // functions is a real optimization but not a correctness requirement,
  // so it's left for whenever a program's own type section size is worth
  // spending on.
  const waitFrameType = usesWaitFrame ? [funcType([], [])] : [];
  const typeSection = section(
    SectionId.type,
    vector([
      ...waitFrameType,
      ...loweredFns.map((f) => funcType(Array(f.paramCount).fill(ValType.i32), f.returnsValue ? [ValType.i32] : [])),
    ]),
  );
  // import section: `env.waitFrame`, importing type index 0 — omitted
  // entirely when the program never calls waitFrame(), the same
  // "pay only for what you use" rule every other section follows.
  const importSection = usesWaitFrame
    ? section(SectionId.import, vector([importFunc('env', 'waitFrame', 0)]))
    : null;
  // function section: defined function `i` uses type index
  // `importFuncCount + i` — the import (if any) took type index 0 ahead
  // of these, in the type section built above, so the two indices still
  // agree without a lookup.
  const functionSection = section(SectionId.function, vector(loweredFns.map((_, i) => [importFuncCount + i])));
  // memory section: memoryPages minimum. A waitFrame()-calling program
  // declares its memory shared, with a max equal to its own min (nothing
  // here ever grows it) — see the file header on why: it's the only way
  // web-runtime.mjs's worker can hand the page a live view instead of a
  // one-time snapshot. Every other program keeps the plain, unbounded
  // memory every earlier milestone already had — shared memory that
  // nothing ever paints mid-run would only cost validation surface for
  // nothing gained.
  const memorySection = section(
    SectionId.memory,
    vector([usesWaitFrame ? limits(memoryPages, memoryPages, true) : limits(memoryPages)]),
  );
  // global section: one mutable i32 per non-pinned scalar `let`, initial
  // value its own declared init — wasm's global-init expression only
  // allows a constant, which every scalar global's `init` already is by
  // the time linked IR reaches a backend. Omitted entirely when the
  // program declares none, the same "pay only for what you use" rule
  // every earlier section already follows.
  const globalSection = globalDefs.length > 0
    ? section(SectionId.global, vector(globalDefs.map((g) => [ValType.i32, Mutability.var, Opcode.i32Const, ...signedLEB128(g.init), Opcode.end])))
    : null;
  // export section: the memory (every host reads screen state through it)
  // and the entry function alone, under its own linked name —
  // wasm-host.mjs finds the entry by "the one exported function," not by
  // name, and refuses a module that exports more than one; every other
  // function this module defines gets a real function index (so calls
  // reach it) but no export entry.
  const exportSection = section(
    SectionId.export,
    vector([
      [...encodeName('memory'), ExternalKind.memory, 0],
      [...encodeName(ir.entry), ExternalKind.func, entryIndex],
    ]),
  );
  // code section: every function's own body, in function-index order —
  // its own locals (every `lower()` declared beyond its parameters, which
  // wasm already gives indices from the function type, as one group of
  // `i32`s — nothing lowered yet needs any other value type), the lowered
  // instructions, then the `end` that closes the body.
  const codeSection = section(SectionId.code, vector(loweredFns.map((f) => encodeFunctionBody(functionBody(f)))));
  // data section: every string literal and const array's own bytes, each
  // its own active segment at its own fixed address (see the layout loop
  // above) — omitted entirely when the program declares neither, the same
  // "pay only for what you use" rule every earlier section follows.
  const dataSection = dataSegments.length > 0 ? section(SectionId.data, vector(dataSegments)) : null;

  const sections = [typeSection, importSection, functionSection, memorySection, globalSection, exportSection, codeSection, dataSection]
    .filter((s): s is number[] => s !== null);
  const bytes = assembleModule(sections);

  await mkdir(dirname(options.outFile), { recursive: true });
  await writeFile(options.outFile, bytes);

  let sizeReport: SizeReportEntry[] | undefined;
  if (options.report) {
    // Each function's own encoded body (locals declaration + instructions
    // + closing end) — exactly what the code section's own vector holds
    // for it, byte for byte. Everything else (every other section, the
    // module preamble, and the code/data sections' own length-prefix
    // framing) is one remainder bucket rather than decomposed section by
    // section: wasm's LEB128-length-prefixed sections don't split into
    // fixed-cost pieces as cleanly as mos's own fixed-address prologue/
    // epilogue/stub do, and a remainder defined this way always sums to
    // the real bytes.length exactly, by construction.
    // functions and loweredFns were built in the same single pass above
    // (one push per function, same order), so they line up index for index.
    const functionEntries = functions.map((fn, i) => ({ name: fn.name, bytes: encodeFunctionBody(functionBody(loweredFns[i])).length }));
    const functionTotal = functionEntries.reduce((a, e) => a + e.bytes, 0);
    const entries = [...functionEntries, { name: '(module sections & framing: type/import/function/memory/global/export, data, preamble)', bytes: bytes.length - functionTotal }];
    sizeReport = entries.filter((e) => e.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  }

  return { ok: true, bytes, ...(sizeReport ? { sizeReport } : {}) };
}

/** One function's own locals declaration, its lowered instructions, and the
 * closing `end` (or `unreachable, end` — see the code below on why a
 * non-void function needs the extra byte). */
function functionBody(f: { paramCount: number; returnsValue: boolean; localCount: number; code: number[] }): number[] {
  const localsDecl = f.localCount > 0 ? [[...unsignedLEB128(f.localCount), ValType.i32]] : [];
  // A non-void function whose every path returns from inside a branch (an
  // `if`/`else` with no code after it, say) reaches this closing `end` with
  // an empty stack once the branch's own `if` frame pops — but the type
  // section declared one result, so the validator refuses it: "expected 1
  // elements on the stack for fallthru, found 0." `unreachable` before the
  // `end` fixes this for every shape, not just this one: it never actually
  // runs when a real `return` already left the function first (dead code,
  // one byte), and it satisfies validation without this file trying to
  // prove the body provably returns on every path.
  const trailer = f.returnsValue ? [Opcode.unreachable, Opcode.end] : [Opcode.end];
  return [...vector(localsDecl), ...f.code, ...trailer];
}

/** A function body entry in the code section: its own byte length (unsigned LEB128), then the body bytes themselves (locals declarations, then instructions, then `end`). */
function encodeFunctionBody(body: number[]): number[] {
  return [...unsignedLEB128(body.length), ...body];
}
