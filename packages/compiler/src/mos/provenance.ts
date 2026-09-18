// Where a directive came from, threaded from IR statement spans (ir/index.mjs
// — every node already carries `start`/`length`, the same span a diagnostic
// uses) through lowering, branch relaxation, and the assembler, so a listing
// or a debug map can answer "what source caused this instruction" without a
// second, parallel source-location system.

/** A span into one file's text — file, plus the same start/length offsets `diagnostic()` (compiler/src/diagnostics/index.mjs) already takes. No line/column here: those are derived on demand from the file's own text (`positionAt`), not carried on every directive. */
export interface SourceSpan {
  file: string;
  start: number;
  length: number;
}

/** Why a directive exists that a source span alone doesn't explain — set only on instructions a lowering pass inserted rather than selected directly for a source construct (branch relaxation today; a future strength-reduction or spill would be another `reason`). */
export interface Generated {
  reason: string;
}

/** Carried on a Directive (asm/assemble.ts) once emitted, and copied onto the ListingLine assemble() produces for it. `source` is the exact statement/expression responsible, when one is known; `function` is the 8BitScript function (or component) currently being lowered; `origin` is the function an inlined block's body came from, distinct from `function` per the design in the source-aware-assembly plan: the source stays with the callee's own statement, but the instructions physically live in the caller. `component`/`instance` are carried for forward compatibility with 8BX — mos/index.ts does not set them yet, since a component lowers to an ordinary function today (bx/elaborate.mjs) and `function` already names it. */
export interface Provenance {
  source: SourceSpan | null;
  function: string | null;
  origin: string | null;
  component: string | null;
  instance: string | null;
  generated?: Generated;
}

export const NO_PROVENANCE: Provenance = {
  source: null, function: null, origin: null, component: null, instance: null,
};
