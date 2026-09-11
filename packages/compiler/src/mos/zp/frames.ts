// Call-graph-aware zero-page frames (0.2.2).
//
// Through 0.2.1 every function's parameters and locals got their own,
// never-shared zero-page bytes — mos/AGENTS.md's own "naive,
// obviously-correct choice", recorded there with the condition for
// replacing it: "worth building once a real program's byte count says
// this is what's actually stopping it from fitting, not before." 2048 is
// that program: ~30 functions' parameters alone outgrow the PET's whole
// $8E-$FF budget before a single local is placed.
//
// The replacement is the classic static-overlay layout for a
// recursion-free call graph (this backend already refuses recursion by
// name — mos/index.ts's findCallCycle — which is exactly what makes this
// sound): each function's parameters, 16-bit return slot, and
// locals/temporaries form one contiguous FRAME, and a frame starts where
// the deepest frame that can be live at the same time ends. Two functions
// that can never be on the call stack together — siblings in the call
// tree — land on the same bytes, and the total budget is the deepest call
// chain's sum, not the whole program's.
//
// "Live at the same time" is more than "calls": a call's own argument
// list holds the callee's parameter slots live while later arguments are
// still being evaluated (callSite stores each argument the moment it's
// evaluated — mos/AGENTS.md), so a function invoked from inside argument
// two of a call to `f` runs while `f`'s first parameter slot already
// holds a value. Every call named anywhere inside arguments 2..n of a
// call to `f` therefore counts as called BY `f` here, placing its frame
// past f's. (Argument one needs no edge: it is evaluated before any slot
// of f is written.) The one shape this refuses that separate-frames
// allowed is `f` itself reappearing inside its own later arguments —
// `f(a, f(b))` — reported as a cycle rather than silently misplaced.
import type { IrFunction } from '../lower/index.ts';
import type { ZpHole } from './index.ts';

/** What one function's frame must hold: parameter bytes + return-slot bytes + the locals/temporaries high-water mark the measurement pass observed. */
export interface FrameNeed {
  bytes: number;
}

export type FrameLayout =
  | { ok: true; starts: Map<string, number>; floor: number }
  | { ok: false; error: string };

interface CallNode {
  kind?: string;
  name?: string;
  args?: unknown[];
}

function collectCalls(node: unknown, out: CallNode[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCalls(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as CallNode;
    if (obj.kind === 'call' && typeof obj.name === 'string') out.push(obj);
    for (const value of Object.values(obj)) collectCalls(value, out);
  }
}

/**
 * Every function's live-parents: the functions whose frames must sit
 * below its own — its real callers, plus (see the file header) any
 * function `f` whose call carries this one inside arguments 2..n.
 */
export function collectLiveParents(functions: IrFunction[]): Map<string, Set<string>> {
  const known = new Set(functions.map((fn) => fn.name));
  const parents = new Map<string, Set<string>>(functions.map((fn) => [fn.name, new Set<string>()]));
  const add = (child: string, parent: string) => {
    if (!known.has(child) || child === parent) {
      if (child === parent) parents.get(child)?.add(parent); // a self-edge is a real cycle, keep it visible
      return;
    }
    parents.get(child)!.add(parent);
  };
  for (const fn of functions) {
    const calls: CallNode[] = [];
    collectCalls(fn.body, calls);
    for (const call of calls) {
      add(call.name!, fn.name);
      const args = call.args ?? [];
      for (let i = 1; i < args.length; i++) {
        const nested: CallNode[] = [];
        collectCalls(args[i], nested);
        for (const inner of nested) add(inner.name!, call.name!);
      }
    }
  }
  return parents;
}

function hex(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** The lowest start >= `from` where a whole frame of `bytes` avoids every hole. A frame never straddles a hole: its own parameters and locals are laid out contiguously from its start. */
function pastHoles(from: number, bytes: number, holes: ZpHole[]): number {
  let start = from;
  for (;;) {
    const hole = holes.find((h) => start < h.end && start + bytes > h.start);
    if (!hole) return start;
    start = hole.end;
  }
}

/**
 * Assigns every function's frame start: topological over the live-parent
 * graph, each frame starting where its deepest live parent's frame ends
 * (the entry's at `origin`), skipped past any hole it would straddle.
 * `floor` is one past the deepest byte any frame reaches — the budget the
 * whole program actually needs.
 */
export function layoutFrames(
  functions: IrFunction[],
  entry: string,
  needs: Map<string, FrameNeed>,
  origin: number,
  ceiling: number,
  holes: ZpHole[] = [],
): FrameLayout {
  const parents = collectLiveParents(functions);
  const remaining = new Map<string, number>();
  const children = new Map<string, string[]>(functions.map((fn) => [fn.name, []]));
  for (const [child, parentSet] of parents) {
    remaining.set(child, parentSet.size);
    for (const parent of parentSet) children.get(parent)?.push(child);
  }

  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  let floor = origin;
  const ready = functions.filter((fn) => (remaining.get(fn.name) ?? 0) === 0).map((fn) => fn.name);
  if (!ready.includes(entry) && (remaining.get(entry) ?? 0) === 0) ready.push(entry);
  let processed = 0;
  while (ready.length > 0) {
    const name = ready.pop()!;
    processed += 1;
    let from = origin;
    for (const parent of parents.get(name) ?? []) from = Math.max(from, ends.get(parent)!);
    const bytes = needs.get(name)?.bytes ?? 0;
    const start = pastHoles(from, bytes, holes);
    if (start + bytes > ceiling) {
      return {
        ok: false,
        error: `out of zero page: '${name}'s frame needs ${bytes} byte(s) at ${hex(start)} but the budget ends at ${hex(ceiling - 1)} — the deepest call chain's frames (${hex(origin)} up) no longer fit`,
      };
    }
    starts.set(name, start);
    ends.set(name, start + bytes);
    floor = Math.max(floor, start + bytes);
    for (const child of children.get(name) ?? []) {
      const left = remaining.get(child)! - 1;
      remaining.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  if (processed < functions.length) {
    const stuck = functions.filter((fn) => !starts.has(fn.name)).map((fn) => fn.name);
    return {
      ok: false,
      error: `frame layout found a cycle through ${stuck.join(' -> ')}: a function reappearing inside its own call's later arguments (f(a, f(b))) isn't layable-out — hoist the inner call into a local first`,
    };
  }
  return { ok: true, starts, floor };
}
