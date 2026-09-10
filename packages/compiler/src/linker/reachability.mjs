// What a backend actually has to compile, versus what link() hands it.
//
// link()'s own header still means what it says: every module's globals and
// functions come back whether the entry ever reaches them or not, and stay
// that way — checkHardwareHazards runs against the full, unpruned set
// (dead code with a dangerous write should still be caught), and every
// existing caller that inspects a linked ir.functions/ir.globals directly
// (the linker's own test suite, mostly) keeps seeing exactly what it always
// has.
//
// This module is what changed instead: each backend's own build() calls
// pruneUnreachable(ir) itself, right before lowering, and compiles only
// what comes back. Measured on the real, unmodified hello-world example —
// one namespace import (@8bitscript/text) pulling in putChar, putColor,
// setColor, setReverse and printNumber alongside the print() it actually
// calls — the PET build was paying 280 of its 1130 program bytes (25%) for
// five functions and a const array nothing ever calls or reads. A 3583-byte
// VIC-20 was the trigger link()'s own header named for when this would
// start mattering; a program that size on a PET with 3071 bytes free
// already qualifies.

/**
 * Every name `node` (or anything nested under it) calls, collected into
 * `out`. Deliberately structural rather than a per-kind switch — the same
 * shape mos/index.ts's own collectCallNames uses for cycle detection, for
 * the same reason: the real IR carries far more fields than a narrow
 * per-kind check would name, and a generic walk never goes stale as new
 * node kinds gain fields.
 *
 * @param {unknown} node
 * @param {Set<string>} out
 */
function collectCallNames(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectCallNames(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    if (node.kind === 'call' && typeof node.name === 'string') out.add(node.name);
    for (const value of Object.values(node)) collectCallNames(value, out);
  }
}

/**
 * Every global `node` (or anything nested under it) reads or writes, by
 * name, collected into `out`. A read is always a nested `{ kind: 'ref',
 * name }` — an array/string access's own `.array`/`.string` field is one of
 * these, so the generic recursion below finds it without needing to know
 * that field's name specifically. `assign`'s own `target` is the one bare
 * string this walk has to name explicitly: everywhere else, a name lives
 * inside a `ref` node the recursion already visits.
 *
 * @param {unknown} node
 * @param {Set<string>} out
 */
function collectGlobalNames(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectGlobalNames(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    if (node.kind === 'ref' && typeof node.name === 'string') out.add(node.name);
    if (node.kind === 'assign' && typeof node.target === 'string') out.add(node.target);
    for (const value of Object.values(node)) collectGlobalNames(value, out);
  }
}

/**
 * `ir.functions` and `ir.globals`, pruned to what `ir.entry` can actually
 * reach — the entry itself, every function it calls (directly or
 * transitively), and every global (a `let` or a const array) any surviving
 * function still names. `ir` itself is never mutated; a backend that wants
 * the full, unpruned program (there is no such caller today) still can.
 *
 * A pinned global (a non-null `address` — a hardware register named by
 * `@address(...)`) is pruned exactly like any other: link()'s own "hardware
 * registers are #defines and cost nothing" is true of the mos backend
 * (a pinned global generates no init write either way, referenced or not —
 * see mos/index.ts's own globalInitProgram loop), but not of the wasm one,
 * which refuses every pinned global outright, referenced or not. Dropping
 * an unreferenced one here is a real fix there: a program that never
 * touches some other module's hardware register no longer fails a web
 * build over a register it was never going to read or write.
 *
 * String literals are deliberately left alone — out of scope for this
 * pass; see the header above.
 *
 * Generic over each backend's own function/global shape (mos/index.ts's
 * IrFunction/IrGlobal, wasm/index.ts's own) rather than typed to either —
 * this file only ever reads `.name`/`.body`, but a caller's own narrower
 * fields (`.params`, `.array`, …) still type-check on what comes back.
 *
 * @template {{ name: string, body: unknown }} F
 * @template {{ name: string }} G
 * @param {{ entry: string, functions: F[], globals?: G[] }} ir
 * @returns {{ functions: F[], globals: G[] }}
 */
export function pruneUnreachable(ir) {
  const byName = new Map(ir.functions.map((fn) => [fn.name, fn]));
  const reachable = new Set();
  const stack = [ir.entry];
  while (stack.length > 0) {
    const name = stack.pop();
    if (reachable.has(name)) continue;
    reachable.add(name);
    const fn = byName.get(name);
    if (!fn) continue; // the entry names no function — build() reports that itself
    const calls = new Set();
    collectCallNames(fn.body, calls);
    for (const callee of calls) {
      if (byName.has(callee) && !reachable.has(callee)) stack.push(callee);
    }
  }
  const functions = ir.functions.filter((fn) => reachable.has(fn.name));

  const referenced = new Set();
  for (const fn of functions) collectGlobalNames(fn.body, referenced);
  // ir.globals is required on the mos side's own IrProgram but optional on
  // wasm's (several of its own fixtures omit it) — one backend-agnostic
  // default rather than two callers each guarding it themselves.
  const globals = (ir.globals ?? []).filter((g) => referenced.has(g.name));

  return { functions, globals };
}
