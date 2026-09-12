// Branch relaxation: when a relative branch assemble() refuses for being out
// of range, rewrite it as an inverted branch over a JMP and try again. This
// is a codegen-time convenience, not a new instruction-selection rule — no
// milestone-6 lowering rule ever has to reason about branch range itself, it
// just emits ordinary conditional branches and this pass fixes the ones that
// don't fit, the same way a real assembler's own "long branch" pseudo-op
// does.
//
// One relaxation grows the program by 3 bytes (a 2-byte branch becomes a
// 2-byte inverted branch + a 3-byte JMP), which can push a *different*
// branch out of range for the first time. So this doesn't stop at the first
// fix: it re-assembles and re-fixes until assemble() is clean, bounded so a
// pathological program errors instead of looping forever.
import { assemble } from './assemble.ts';
import type { AssembleResult, Directive } from './assemble.ts';
import { operandBytes } from './encode.ts';

// Every relative-mode mnemonic asm/encode.ts's OPCODES table defines, paired
// with the branch that fires on the opposite condition — used to flip
// `Bcc target` into `B~cc +3; JMP target`, which reaches anywhere in the
// 16-bit address space instead of just ±127 bytes.
const INVERSE: Readonly<Record<string, string>> = {
  BEQ: 'BNE', BNE: 'BEQ',
  BCC: 'BCS', BCS: 'BCC',
  BVC: 'BVS', BVS: 'BVC',
  BPL: 'BMI', BMI: 'BPL',
};

const OUT_OF_RANGE = /^(\w+) at \$([0-9A-F]{4}): branch to /;

// Long enough that a real program never hits it (each pass fixes at least
// one branch, and a program has finitely many), short enough that a bug
// causing the same branch to relax forever fails fast instead of hanging.
const MAX_PASSES = 64;

/** How many bytes a directive occupies once placed — mirrors assemble.ts's own placeLabels() walk, the only other place this arithmetic lives. */
function directiveBytes(directive: Directive): number {
  if (directive.kind === 'label' || directive.kind === 'equate') return 0;
  if (directive.kind === 'byte') return directive.values.length;
  return 1 + operandBytes(directive.mode);
}

let relaxCounter = 0;

/** Rewrites the one relative-mode instruction at `targetAddress` into an inverted branch over a JMP, or returns null if none sits there (a bug in the caller, not a program to fix). */
function relaxOne(program: Directive[], origin: number, targetAddress: number, inverse: string): Directive[] | null {
  const out: Directive[] = [];
  let address = origin;
  let relaxed = false;

  for (const directive of program) {
    if (!relaxed && directive.kind === 'instruction' && directive.mode === 'relative' && address === targetAddress) {
      const skip = `__8bs_relax_${relaxCounter++}`;
      out.push(
        { kind: 'instruction', mnemonic: inverse, mode: 'relative', operand: { kind: 'label', name: skip } },
        { kind: 'instruction', mnemonic: 'JMP', mode: 'absolute', operand: directive.operand },
        { kind: 'label', name: skip },
      );
      relaxed = true;
      continue;
    }
    out.push(directive);
    address += directiveBytes(directive);
  }

  return relaxed ? out : null;
}

/** assemble(), but a relative branch too far away is rewritten to a long form and retried instead of failing the build. */
export function assembleRelaxed(program: Directive[], origin: number): AssembleResult {
  let current = program;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const result = assemble(current, origin);
    if (result.ok) return result;

    const match = OUT_OF_RANGE.exec(result.error);
    if (!match) return result; // not a branch-range problem — nothing here can fix it

    const [, mnemonic, atHex] = match;
    const inverse = INVERSE[mnemonic];
    if (!inverse) return result; // every relative mnemonic this backend emits is in INVERSE; an unknown one is a real bug, not ours to paper over

    const relaxed = relaxOne(current, origin, Number.parseInt(atHex, 16), inverse);
    if (!relaxed) return result;
    current = relaxed;
  }
  return { ok: false, error: `assembleRelaxed: branches still out of range after ${MAX_PASSES} relaxation passes — a genuine bug, not a program this large` };
}
