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
// clobber, so there's nothing here that needs refusing. Still no strings,
// no waitFrame() — every later milestone's own job is one more IR shape
// this function stops refusing by name.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ExternalKind, Mutability, Opcode, SectionId, ValType, assembleModule, encodeName, funcType, limits, section, signedLEB128, unsignedLEB128, vector } from './encode.ts';
import { lower } from './lower.ts';
import type { IrStatement } from './lower.ts';

export interface IrParam {
  name: string;
  /** `'array'` or `'string'` here is a parameter shape not lowered yet —
   * checked by name in `build()`, the same refusal-by-name every other
   * unhandled shape in this backend gets rather than a guess. */
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
   * not RAM this backend owns; not lowered yet (nothing in
   * @8bitscript/web declares one today, per mos/index.ts's own precedent
   * this backend reads for the same field). */
  address: number | null;
  /** A scalar global's own initial value, always a plain number by the
   * time linked IR reaches a backend (linker/index.mjs resolves every
   * initializer first) — never present (array's elements) or an IrExpr. */
  init?: number | null;
  /** Set for a const array; not lowered yet — the web track's own
   * milestone 5. */
  array?: number;
}

/** The linked IR's top-level shape this backend reads — the same real IR
 * mos/index.ts's own IrProgram describes, narrowed to what this milestone
 * looks at. Grows alongside instruction selection, not ahead of it. */
export interface IrProgram {
  entry: string;
  functions: IrFunction[];
  globals?: IrGlobal[];
  strings?: unknown[];
}

export interface BuildOptions {
  outFile: string;
  frameRate: number;
}

export type BuildResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; error: string };

// One page (64 KiB) of linear memory — @8bitscript/web's own WebRegisters
// layout (packages/web/src/index.8bs) uses under 2.5 KiB of it today, and
// nothing in this milestone needs more than the module's own empty body.
// Sized here rather than computed because nothing lowered yet has an
// opinion on how much memory a program needs; a later milestone (data
// section placement, "Hello, WASM"'s own open decision) may need to grow
// this from the linked program's own const-data size.
const MEMORY_PAGES = 1;

// No import lands before milestone 6's own `env.waitFrame` — see the
// function-index comment in `build()` for why this is a named constant
// rather than every call/export site assuming the entry is index 0.
const IMPORT_FUNC_COUNT = 0;

/** Lowers `ir` to WebAssembly, writes `outFile`, and returns the bytes. */
export async function build(ir: IrProgram, options: BuildOptions): Promise<BuildResult> {
  const entryFn = ir.functions.find((fn) => fn.name === ir.entry);
  if (!entryFn) return { ok: false, error: `the linked entry point '${ir.entry}' names no function in ir.functions` };

  if ((ir.strings ?? []).length > 0) {
    return {
      ok: false,
      error: 'string literals are not lowered yet: this is the web track\'s own milestone 5 ("strings and const data")',
    };
  }

  // Every non-pinned scalar global gets a wasm global-section entry,
  // addressed by declaration order — no allocator, no budget, unlike the
  // mos backend's own zero page (see "Hello, WASM"'s own "globals need no
  // allocator" note). A pinned or array global is refused by name instead
  // of guessed at: nothing in @8bitscript/web declares either today.
  const globalDefs: { name: string; init: number }[] = [];
  for (const g of ir.globals ?? []) {
    if (g.address !== null && g.address !== undefined) {
      return { ok: false, error: `'${g.name}': a pinned global (@address(...)) is not lowered yet` };
    }
    if (g.array !== undefined) {
      return { ok: false, error: `'${g.name}' is an array: not lowered yet — the web track's own milestone 5 ("strings and const data")` };
    }
    if (g.type === 'string') {
      return { ok: false, error: `'${g.name}' is a string<N>: not lowered yet — the web track's own milestone 5 ("strings and const data")` };
    }
    globalDefs.push({ name: g.name, init: typeof g.init === 'number' ? g.init : 0 });
  }
  const globalIndex = new Map(globalDefs.map((g, i) => [g.name, i]));

  // Every function's own wasm function index, assigned once, up front, in
  // declaration order — before any body is lowered, so a call can reach a
  // function declared later in this array, or itself (recursion; see
  // lower.ts's own Ctx.functions doc). No import lands before these yet
  // (IMPORT_FUNC_COUNT is milestone 6's own `env.waitFrame` reservation:
  // once that import exists, it takes index 0 and every defined function's
  // own index shifts by one — computed from here, not hardcoded, so that
  // milestone's own change is this one constant, not an audit of every
  // `call`/export site that assumed index 0 was the entry).
  const functionSites = new Map(ir.functions.map((fn, i) => [
    fn.name,
    {
      index: IMPORT_FUNC_COUNT + i,
      paramCount: (fn.params ?? []).length,
      returnsValue: !!fn.returnType && fn.returnType !== 'void',
    },
  ]));
  if (functionSites.size !== ir.functions.length) {
    return { ok: false, error: 'two functions in ir.functions share the same name — a linker bug, not something this backend can guess a fix for' };
  }

  const loweredFns: { index: number; paramCount: number; returnsValue: boolean; localCount: number; code: number[] }[] = [];
  for (const fn of ir.functions) {
    for (const p of fn.params ?? []) {
      if (p.type === 'array') return { ok: false, error: `'${fn.name}(${p.name})': an array parameter is not lowered yet — the web track's own milestone 5 ("strings and const data")` };
      if (p.type === 'string') return { ok: false, error: `'${fn.name}(${p.name})': a string parameter is not lowered yet — the web track's own milestone 5 ("strings and const data")` };
    }
    const site = functionSites.get(fn.name)!;
    const lowered = lower(fn.body, { params: fn.params ?? [], globals: globalIndex, functions: functionSites });
    if (!lowered.ok) return { ok: false, error: `'${fn.name}': ${lowered.error}` };
    loweredFns.push({ index: site.index, paramCount: site.paramCount, returnsValue: site.returnsValue, localCount: lowered.localCount, code: lowered.code });
  }
  const entryIndex = functionSites.get(ir.entry)!.index;

  // type section: one type per function, in the same order — deduplicating
  // identical signatures is a real optimization (two functions that both
  // take one utinyint and return void share nothing here today) but not a
  // correctness requirement, so it's left for whenever a program's own
  // type section size is worth spending on.
  const typeSection = section(
    SectionId.type,
    vector(loweredFns.map((f) => funcType(Array(f.paramCount).fill(ValType.i32), f.returnsValue ? [ValType.i32] : []))),
  );
  // function section: function index `IMPORT_FUNC_COUNT + i` uses type
  // index `i` — one type per function, declared in the same order, so the
  // two indices already agree without a lookup. This stops being true once
  // milestone 6 adds an import: an imported function also occupies a
  // type-section entry (before any of these), so `i` here will need to
  // become `IMPORT_FUNC_COUNT + i` too, not stay a bare position.
  const functionSection = section(SectionId.function, vector(loweredFns.map((_, i) => [i])));
  // memory section: one memory, MEMORY_PAGES minimum, no declared maximum.
  const memorySection = section(SectionId.memory, vector([limits(MEMORY_PAGES)]));
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

  const sections = [typeSection, functionSection, memorySection, globalSection, exportSection, codeSection]
    .filter((s): s is number[] => s !== null);
  const bytes = assembleModule(sections);

  await mkdir(dirname(options.outFile), { recursive: true });
  await writeFile(options.outFile, bytes);

  return { ok: true, bytes };
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
