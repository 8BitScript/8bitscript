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
// Milestone 2 ("arithmetic and control flow") adds real instruction
// selection (./lower.ts) for that body: binop/unop/if/while/for/break/
// continue/return, all `i32`, masked to their declared width. Still no
// globals, no other functions, no strings, no waitFrame() — every later
// milestone's own job is one more IR shape this function stops refusing by
// name.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ExternalKind, Opcode, SectionId, ValType, assembleModule, encodeName, funcType, limits, section, unsignedLEB128, vector } from './encode.ts';
import { lower } from './lower.ts';
import type { IrStatement } from './lower.ts';

export interface IrFunction {
  name: string;
  body: IrStatement[];
  /** `fn.returnType ?? 'void'`, the same convention mos/index.ts holds
   * itself to — wasm has no narrower-than-i32 value type, so any non-void
   * numeric return type becomes a single `i32` result; a narrower type's
   * own width is a `lower.ts` masking concern, not a function-type one. */
  returnType?: string | null;
}

export interface IrGlobal {
  name: string;
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

/** Lowers `ir` to WebAssembly, writes `outFile`, and returns the bytes. */
export async function build(ir: IrProgram, options: BuildOptions): Promise<BuildResult> {
  const entryFn = ir.functions.find((fn) => fn.name === ir.entry);
  if (!entryFn) return { ok: false, error: `the linked entry point '${ir.entry}' names no function in ir.functions` };

  if (ir.functions.length > 1) {
    return {
      ok: false,
      error: 'only the entry function is lowered yet: calling another function is the web track\'s own milestone 4 ("functions and calls")',
    };
  }
  if ((ir.globals ?? []).length > 0) {
    return {
      ok: false,
      error: 'globals are not lowered yet: this is the web track\'s own milestone 3 ("globals and memory")',
    };
  }
  if ((ir.strings ?? []).length > 0) {
    return {
      ok: false,
      error: 'string literals are not lowered yet: this is the web track\'s own milestone 5 ("strings and const data")',
    };
  }
  const lowered = lower(entryFn.body);
  if (!lowered.ok) return { ok: false, error: `'${entryFn.name}': ${lowered.error}` };

  // No parameters yet (milestone 4) — a non-void return is the only way
  // this milestone's own gate (a for-loop sum) can produce an
  // externally-observable result without memoryWrite (milestone 3).
  const results = !entryFn.returnType || entryFn.returnType === 'void' ? [] : [ValType.i32];

  // type section: one type for the entry — the only function this
  // milestone ever emits.
  const typeSection = section(SectionId.type, vector([funcType([], results)]));
  // function section: the entry uses type index 0.
  const functionSection = section(SectionId.function, vector([[0]]));
  // memory section: one memory, MEMORY_PAGES minimum, no declared maximum.
  const memorySection = section(SectionId.memory, vector([limits(MEMORY_PAGES)]));
  // export section: the memory (every host reads screen state through it)
  // and the entry function, under its own linked name — wasm-host.mjs finds
  // the entry by "the one exported function," not by name, so this can stay
  // whatever the program itself calls it.
  const exportSection = section(
    SectionId.export,
    vector([
      [...encodeName('memory'), ExternalKind.memory, 0],
      [...encodeName(ir.entry), ExternalKind.func, 0],
    ]),
  );
  // code section: the entry's one function body — every local `lower()`
  // declared, as one group of `i32`s (nothing lowered yet needs any other
  // value type), then the lowered instructions, then the `end` that closes
  // every function body.
  const localsDecl = lowered.localCount > 0 ? [[...unsignedLEB128(lowered.localCount), ValType.i32]] : [];
  // A non-void function whose every path returns from inside a branch (an
  // `if`/`else` with no code after it, say) reaches this closing `end` with
  // an empty stack once the branch's own `if` frame pops — but the type
  // section declared one result, so the validator refuses it: "expected 1
  // elements on the stack for fallthru, found 0." `unreachable` before the
  // `end` fixes this for every shape, not just this one: it never actually
  // runs when a real `return` already left the function first (dead code,
  // one byte), and it satisfies validation without this file trying to
  // prove the body provably returns on every path.
  const trailer = results.length > 0 ? [Opcode.unreachable, Opcode.end] : [Opcode.end];
  const entryBody = [...vector(localsDecl), ...lowered.code, ...trailer];
  const codeSection = section(SectionId.code, vector([encodeFunctionBody(entryBody)]));

  const bytes = assembleModule([typeSection, functionSection, memorySection, exportSection, codeSection]);

  await mkdir(dirname(options.outFile), { recursive: true });
  await writeFile(options.outFile, bytes);

  return { ok: true, bytes };
}

/** A function body entry in the code section: its own byte length (unsigned LEB128), then the body bytes themselves (locals declarations, then instructions, then `end`). */
function encodeFunctionBody(body: number[]): number[] {
  return [...unsignedLEB128(body.length), ...body];
}
