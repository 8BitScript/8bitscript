// `asm6502 { ... }` — the text between the braces, turned into the same
// Directives every other part of this backend emits.
//
// The language hands this backend an asm statement as raw source
// (`{ kind: 'asm', text }`, packages/compiler/src/ir/index.mjs), because
// nothing before now had any reason to know what 6502 assembly looks like.
// So this is where it is read. What comes out is ordinary `Directive[]`:
// the assembler, the branch relaxer and the linker then treat a hand-written
// `sei` exactly as they treat one the instruction selector chose, which is
// the whole point — an asm block is not a hole in the pipeline, it is a
// different way of writing the same instruction stream.
//
// The syntax is the one the machine packages already use (every asm block
// in the workspace was read before this was written):
//
//     sei                     implied
//     lda #$FF                immediate, $hex / %binary / decimal
//     sta $84                 zero page, by the literal's own width
//     jsr $FF5F               absolute
//     jsr some_routine        absolute, through a symbol
//     lda screen,x            indexed; ($nn,x) and ($nn),y too
//     1:  dex                 a local label...
//         bne 1b              ...and a backward branch to it
//
// Comments run to end of line after `;` or `//`. Case does not matter for
// mnemonics or for the `A`/`X`/`Y` that name a register.
//
// Two things this deliberately does NOT do. It does not evaluate
// expressions — no `label+1`, no arithmetic — because every use in the
// workspace is a bare operand and an expression grammar here would be a
// second, worse copy of the language's own. And it does not invent
// addressing modes: a mnemonic/mode pair the 6502 does not have is refused
// by name against OPCODES rather than encoded as something adjacent.
import { OPCODES } from './encode.ts';
import type { AddressingMode } from './encode.ts';
import type { Directive, Operand } from './assemble.ts';

export type ParseAsmResult =
  | { ok: true; directives: Directive[] }
  | { ok: false; error: string };

// A branch's operand is always a label to be measured from here, never an
// address to be written down, so these take `relative` whatever the operand
// looks like. (mos/asm/relax.ts is what later proves the distance fits.)
const BRANCHES = new Set(['BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ']);

const NAMED_LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCAL_LABEL = /^[0-9]+$/;
const LOCAL_REF = /^([0-9]+)([bBfF])$/;

/** `$FF`, `%1010`, `42` — or null when `text` is a symbol rather than a number. */
function literal(text: string): { value: number; digits: number } | null {
  if (text.startsWith('$')) {
    const body = text.slice(1);
    if (!/^[0-9A-Fa-f]+$/.test(body)) return null;
    return { value: parseInt(body, 16), digits: body.length };
  }
  if (text.startsWith('%')) {
    const body = text.slice(1);
    if (!/^[01]+$/.test(body)) return null;
    return { value: parseInt(body, 2), digits: body.length > 8 ? 4 : 2 };
  }
  if (/^[0-9]+$/.test(text)) {
    const value = parseInt(text, 10);
    return { value, digits: value > 0xff ? 4 : 2 };
  }
  return null;
}

/**
 * The narrow mode and its wide twin. A literal's own width picks the narrow
 * one — `sta $84` is zero page because it was written as two digits — but a
 * mnemonic that has no zero-page form takes the wide one instead, which is
 * how `jsr $84` assembles rather than being refused for a mode JSR does not
 * have. A symbol has no width to read, so it starts wide.
 */
const WIDER: Partial<Record<AddressingMode, AddressingMode>> = {
  zeropage: 'absolute',
  'zeropage,x': 'absolute,x',
  'zeropage,y': 'absolute,y',
};

function modeFor(mnemonic: string, preferred: AddressingMode): AddressingMode | null {
  const forms = OPCODES[mnemonic];
  if (!forms) return null;
  if (forms[preferred] !== undefined) return preferred;
  const wider = WIDER[preferred];
  if (wider !== undefined && forms[wider] !== undefined) return wider;
  return null;
}

/** One line's operand text → the mode it names and the operand itself. */
function operandOf(mnemonic: string, text: string, context: string):
  { ok: true; mode: AddressingMode; operand?: Operand } | { ok: false; error: string } {
  const fail = (why: string) => ({ ok: false as const, error: `${context}: ${why}` });

  if (text === '') {
    const mode = modeFor(mnemonic, 'implied');
    if (!mode) return fail(`${mnemonic} needs an operand`);
    return { ok: true, mode };
  }
  if (/^[Aa]$/.test(text)) {
    const mode = modeFor(mnemonic, 'accumulator');
    if (!mode) return fail(`${mnemonic} has no accumulator form`);
    return { ok: true, mode };
  }

  // A branch names a label and measures it; nothing else about the operand
  // text matters, including whether it looks like a number.
  if (BRANCHES.has(mnemonic)) {
    const name = localOrNamed(text);
    if (!name) return fail(`${mnemonic} needs a label to branch to, got '${text}'`);
    return { ok: true, mode: 'relative', operand: { kind: 'label', name } };
  }

  if (text.startsWith('#')) {
    const body = text.slice(1);
    const number = literal(body);
    if (number === null) {
      if (!NAMED_LABEL.test(body)) return fail(`'#${body}' is not an immediate value`);
      const mode = modeFor(mnemonic, 'immediate');
      if (!mode) return fail(`${mnemonic} has no immediate form`);
      return { ok: true, mode, operand: { kind: 'label', name: body } };
    }
    if (number.value > 0xff) return fail(`'#${body}' does not fit in one byte`);
    const mode = modeFor(mnemonic, 'immediate');
    if (!mode) return fail(`${mnemonic} has no immediate form`);
    return { ok: true, mode, operand: { kind: 'value', value: number.value } };
  }

  // The three parenthesised shapes, before the bare ones: `($nn,x)`,
  // `($nn),y`, `($nnnn)`.
  const indirectX = /^\(\s*(.+?)\s*,\s*[Xx]\s*\)$/.exec(text);
  if (indirectX) return simple(mnemonic, indirectX[1], '(indirect,x)', context);
  const indirectY = /^\(\s*(.+?)\s*\)\s*,\s*[Yy]$/.exec(text);
  if (indirectY) return simple(mnemonic, indirectY[1], '(indirect),y', context);
  const indirect = /^\(\s*(.+?)\s*\)$/.exec(text);
  if (indirect) return simple(mnemonic, indirect[1], 'indirect', context);

  const indexedX = /^(.+?)\s*,\s*[Xx]$/.exec(text);
  if (indexedX) return sized(mnemonic, indexedX[1], 'zeropage,x', context);
  const indexedY = /^(.+?)\s*,\s*[Yy]$/.exec(text);
  if (indexedY) return sized(mnemonic, indexedY[1], 'zeropage,y', context);

  return sized(mnemonic, text, 'zeropage', context);
}

/** A mode whose width is fixed by the mode itself, not by the operand. */
function simple(mnemonic: string, body: string, want: AddressingMode, context: string):
  { ok: true; mode: AddressingMode; operand?: Operand } | { ok: false; error: string } {
  const mode = modeFor(mnemonic, want);
  if (!mode) return { ok: false, error: `${context}: ${mnemonic} has no ${want} form` };
  const operand = operandValue(body);
  if (!operand) return { ok: false, error: `${context}: '${body}' is not an address or a name` };
  return { ok: true, mode, operand };
}

/** A mode the operand's own written width chooses between (zero page or absolute). */
function sized(mnemonic: string, body: string, narrow: AddressingMode, context: string):
  { ok: true; mode: AddressingMode; operand?: Operand } | { ok: false; error: string } {
  const number = literal(body);
  const want: AddressingMode = number === null || number.digits > 2 ? (WIDER[narrow] ?? narrow) : narrow;
  const mode = modeFor(mnemonic, want);
  if (!mode) return { ok: false, error: `${context}: ${mnemonic} has no ${want} form` };
  const operand = operandValue(body);
  if (!operand) return { ok: false, error: `${context}: '${body}' is not an address or a name` };
  return { ok: true, mode, operand };
}

function operandValue(body: string): Operand | null {
  const number = literal(body);
  if (number !== null) return { kind: 'value', value: number.value };
  const name = localOrNamed(body);
  return name ? { kind: 'label', name } : null;
}

/** A symbol, or a local-label reference like `1b`, kept in its written form for now. */
function localOrNamed(text: string): string | null {
  if (LOCAL_REF.test(text)) return text;
  if (NAMED_LABEL.test(text)) return text;
  return null;
}

/**
 * Parses one `asm6502` block. `blockId` makes this block's local labels
 * its own: `1:` in two different blocks is two different places, so the
 * name that reaches the assembler carries the block with it.
 */
export function parseAsm(text: string, blockId: string): ParseAsmResult {
  const out: Directive[] = [];
  // Where each numeric label was defined, in order, so `1b` and `1f` can
  // pick the nearest one behind or ahead — the GNU-assembler rule the
  // machine packages are written against.
  const locals: { digit: string; name: string; at: number }[] = [];
  const pendingRefs: { operand: { kind: 'label'; name: string }; digit: string; direction: 'b' | 'f'; at: number; context: string }[] = [];

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    const comment = Math.min(
      ...[line.indexOf(';'), line.indexOf('//')].filter((n) => n >= 0).concat([line.length]),
    );
    line = line.slice(0, comment).trim();
    if (line === '') continue;
    const context = `asm6502 line ${i + 1} ('${line}')`;

    // Leading labels, however many share the line with the instruction.
    for (;;) {
      const labelled = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+)\s*:\s*/.exec(line);
      if (!labelled) break;
      const name = labelled[1];
      if (LOCAL_LABEL.test(name)) {
        const unique = `__asm_${blockId}_${name}_${locals.length}`;
        locals.push({ digit: name, name: unique, at: out.length });
        out.push({ kind: 'label', name: unique });
      } else {
        out.push({ kind: 'label', name });
      }
      line = line.slice(labelled[0].length).trim();
    }
    if (line === '') continue;

    const spaced = /^(\S+)\s*(.*)$/.exec(line)!;
    const mnemonic = spaced[1].toUpperCase();
    if (!OPCODES[mnemonic]) return { ok: false, error: `${context}: '${spaced[1]}' is not a 6502 instruction` };
    const operand = operandOf(mnemonic, spaced[2].trim(), context);
    if (!operand.ok) return operand;

    if (operand.operand?.kind === 'label') {
      const ref = LOCAL_REF.exec(operand.operand.name);
      if (ref) {
        pendingRefs.push({
          operand: operand.operand as { kind: 'label'; name: string },
          digit: ref[1],
          direction: ref[2].toLowerCase() as 'b' | 'f',
          at: out.length,
          context,
        });
      }
    }
    out.push(operand.operand === undefined
      ? { kind: 'instruction', mnemonic, mode: operand.mode }
      : { kind: 'instruction', mnemonic, mode: operand.mode, operand: operand.operand });
  }

  // Now that every definition is known, point each `1b`/`1f` at one.
  for (const ref of pendingRefs) {
    const candidates = locals.filter((l) => l.digit === ref.digit);
    const target = ref.direction === 'b'
      ? [...candidates].reverse().find((l) => l.at <= ref.at)
      : candidates.find((l) => l.at > ref.at);
    if (!target) {
      return { ok: false, error: `${ref.context}: no label '${ref.digit}:' ${ref.direction === 'b' ? 'before' : 'after'} it` };
    }
    ref.operand.name = target.name;
  }

  return { ok: true, directives: out };
}
