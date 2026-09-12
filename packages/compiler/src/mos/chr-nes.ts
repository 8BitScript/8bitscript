// The NES's character ROM, assembled from the `.chr_rom` native source
// @8bitscript/nes ships.
//
// Every other target this backend builds draws its letters out of a ROM
// that is already in the machine: the PET's, the C64's and the Atari's
// video hardware read a character generator the manufacturer put there, so
// `text.putChar` is a single store of a code into screen memory and the
// build contributes nothing. The NES has no such ROM. Its PPU fetches 8x8
// tile patterns from the CARTRIDGE, which means a cartridge that shows
// text has to CONTAIN its font — so on this one machine the character set
// is part of the build's output file, and something has to turn
// `packages/nes/native/6502/font.s` into the 8 KiB the iNES header
// declares.
//
// That file is GNU-as source (it predates this backend: it was written for
// the llvm-mos toolchain the project used before 0.2.0, and it is the
// artwork itself — see its own header, where every `tile` line's eight
// binary literals ARE the glyph, read top to bottom). It is deliberately
// NOT rewritten into this backend's own `asm6502` syntax, because that
// syntax has no macros, no `.rept` and no expressions (mos/asm/parse.ts's
// header says so outright), and the font's 200-odd lines are almost
// entirely macro calls. Rewriting it would mean expanding 512 tiles by
// hand into 8192 literal bytes and losing the one property that makes the
// file reviewable.
//
// So this reads the small, DATA-ONLY subset of gas that font.s actually
// uses, and nothing else:
//
//     .section NAME,"a"     switches sections; only `.chr_rom`'s bytes are kept
//     .macro N a, b, ...    a macro definition, ended by `.endm`;
//                           `\a` in the body is replaced by the argument
//     .rept N / .endr       the enclosed lines, N times
//     .byte E, E, ...       one byte per expression
//     .space N              N zero bytes (gas's own default fill)
//     NAME arg, arg, ...    a call to a macro defined above
//
// and an expression grammar of exactly what appears there: integer
// literals (`42`, `0x1F`, `0b01100110`), `+ - * / ^ & |`, and parentheses.
// Anything else — an instruction, an unknown directive, a label, a symbol
// in an expression — is refused BY NAME rather than skipped, because a
// font this silently dropped bytes from would not fail, it would just draw
// the wrong letters, which is exactly the class of bug packages/nes's own
// AGENTS.md records being caught by screenshot and by nothing else.

/** One native source to read: where it came from (for error messages) and what it says. */
export interface NativeSource {
  path: string;
  text: string;
}

export type ChrResult =
  /** `bytes` is always exactly the requested size; `defined` is how many of them the sources actually wrote, so a caller can tell "all blank tiles" from "no font at all". */
  | { ok: true; bytes: Uint8Array; defined: number }
  | { ok: false; error: string };

/** The section whose bytes become CHR-ROM. Every other section is refused: this backend has nowhere else to put native bytes yet. */
const CHR_SECTION = '.chr_rom';

/** A macro definition: its parameter names in order, and the body lines `\param` is substituted into. */
interface Macro {
  params: string[];
  body: string[];
}

/** Everything after an unquoted `;` or `//` is a comment, the same two spellings mos/asm/parse.ts accepts. */
function stripComment(line: string): string {
  const semi = line.indexOf(';');
  const slashes = line.indexOf('//');
  let end = line.length;
  if (semi >= 0) end = Math.min(end, semi);
  if (slashes >= 0) end = Math.min(end, slashes);
  return line.slice(0, end);
}

/**
 * `a, b, c` split at top-level commas. Parentheses are tracked so an
 * argument that contains one (nothing in font.s does today, but an
 * expression grammar that allows them has to split as if it does) is not
 * cut in half.
 */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

// ---- expressions ----------------------------------------------------------
//
// Precedence-climbing over the operators font.s uses, in C's own order (the
// order gas inherits): `*` and `/` bind tightest, then `+` and `-`, then
// the bitwise `&`, `^` and `|`. Two of the three levels exist only because
// the file uses one operator from each — `.space 33 * 16` and
// `0xff^\r0` — and writing the third by itself would be a grammar with a
// hole in it.

interface Cursor {
  text: string;
  at: number;
}

function skipSpace(c: Cursor): void {
  while (c.at < c.text.length && /\s/.test(c.text[c.at])) c.at++;
}

/** A literal or a parenthesized expression. Returns null (rather than throwing) so the caller can name the offending text. */
function parsePrimary(c: Cursor): number | null {
  skipSpace(c);
  if (c.text[c.at] === '(') {
    c.at++;
    const value = parseBitwise(c);
    if (value === null) return null;
    skipSpace(c);
    if (c.text[c.at] !== ')') return null;
    c.at++;
    return value;
  }
  if (c.text[c.at] === '-') {
    c.at++;
    const value = parsePrimary(c);
    return value === null ? null : -value;
  }
  const rest = c.text.slice(c.at);
  const hex = /^0[xX][0-9A-Fa-f]+/.exec(rest);
  if (hex) { c.at += hex[0].length; return parseInt(hex[0].slice(2), 16); }
  const bin = /^0[bB][01]+/.exec(rest);
  if (bin) { c.at += bin[0].length; return parseInt(bin[0].slice(2), 2); }
  const dec = /^[0-9]+/.exec(rest);
  if (dec) { c.at += dec[0].length; return parseInt(dec[0], 10); }
  return null;
}

function parseProduct(c: Cursor): number | null {
  let left = parsePrimary(c);
  if (left === null) return null;
  for (;;) {
    skipSpace(c);
    const op = c.text[c.at];
    if (op !== '*' && op !== '/') return left;
    c.at++;
    const right = parsePrimary(c);
    if (right === null) return null;
    left = op === '*' ? left * right : Math.floor(left / right);
  }
}

function parseSum(c: Cursor): number | null {
  let left = parseProduct(c);
  if (left === null) return null;
  for (;;) {
    skipSpace(c);
    const op = c.text[c.at];
    if (op !== '+' && op !== '-') return left;
    c.at++;
    const right = parseProduct(c);
    if (right === null) return null;
    left = op === '+' ? left + right : left - right;
  }
}

function parseBitwise(c: Cursor): number | null {
  let left = parseSum(c);
  if (left === null) return null;
  for (;;) {
    skipSpace(c);
    const op = c.text[c.at];
    if (op !== '&' && op !== '^' && op !== '|') return left;
    c.at++;
    const right = parseSum(c);
    if (right === null) return null;
    left = op === '&' ? left & right : op === '^' ? left ^ right : left | right;
  }
}

/** The value of `text`, or null if it is not an expression this understands end to end (a trailing symbol is as much a failure as a leading one). */
function evaluate(text: string): number | null {
  const c: Cursor = { text, at: 0 };
  const value = parseBitwise(c);
  if (value === null) return null;
  skipSpace(c);
  return c.at === text.length ? value : null;
}

// ---- the reader -----------------------------------------------------------

/** `\name` replaced by the matching argument, longest parameter name first so `\r1` is never eaten by a shorter `\r` that happens to be a parameter too. */
function substitute(line: string, params: string[], args: string[]): string {
  let out = line;
  const order = params.map((name, i) => ({ name, arg: args[i] ?? '' }))
    .sort((a, b) => b.name.length - a.name.length);
  for (const { name, arg } of order) out = out.split(`\\${name}`).join(arg);
  return out;
}

/**
 * Reads `lines` (already comment-stripped and trimmed, macro bodies
 * expanded as they are reached) into `out`, which only receives bytes
 * while the current section is `.chr_rom`.
 */
function readLines(
  lines: string[],
  macros: Map<string, Macro>,
  state: { section: string | null },
  out: number[],
  path: string,
  depth: number,
): string | null {
  if (depth > 16) return `${path}: macro expansion nested more than 16 deep`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;

    const space = line.search(/\s/);
    const head = (space === -1 ? line : line.slice(0, space)).toLowerCase();
    const rest = space === -1 ? '' : line.slice(space).trim();

    if (head === '.macro') {
      const args = splitArgs(rest);
      const nameSplit = args[0].search(/\s/);
      const name = nameSplit === -1 ? args[0] : args[0].slice(0, nameSplit);
      const firstParam = nameSplit === -1 ? [] : [args[0].slice(nameSplit).trim()];
      const params = [...firstParam, ...args.slice(1)];
      const body: string[] = [];
      i++;
      for (; i < lines.length && lines[i].toLowerCase() !== '.endm'; i++) body.push(lines[i]);
      if (i >= lines.length) return `${path}: '.macro ${name}' has no matching .endm`;
      macros.set(name, { params, body });
      continue;
    }

    if (head === '.rept') {
      const count = evaluate(rest);
      if (count === null) return `${path}: '.rept ${rest}' is not a count this reads`;
      const body: string[] = [];
      i++;
      for (; i < lines.length && lines[i].toLowerCase() !== '.endr'; i++) body.push(lines[i]);
      if (i >= lines.length) return `${path}: '.rept ${rest}' has no matching .endr`;
      for (let n = 0; n < count; n++) {
        const error = readLines(body, macros, state, out, path, depth + 1);
        if (error) return error;
      }
      continue;
    }

    if (head === '.section') {
      state.section = splitArgs(rest)[0] ?? null;
      continue;
    }

    if (head === '.byte') {
      for (const arg of splitArgs(rest)) {
        const value = evaluate(arg);
        if (value === null) return `${path}: '${arg}' in a .byte is not a constant expression this reads`;
        if (state.section === CHR_SECTION) out.push(value & 0xff);
      }
      continue;
    }

    if (head === '.space' || head === '.skip') {
      const count = evaluate(rest);
      if (count === null) return `${path}: '${head} ${rest}' is not a size this reads`;
      if (state.section === CHR_SECTION) for (let n = 0; n < count; n++) out.push(0);
      continue;
    }

    // A macro call: the head word, case-sensitively (gas macro names are,
    // unlike its directives), followed by its arguments.
    const macro = macros.get(space === -1 ? line : line.slice(0, space));
    if (macro) {
      const args = splitArgs(rest);
      const expanded = macro.body.map((body) => substitute(body, macro.params, args));
      const error = readLines(expanded, macros, state, out, path, depth + 1);
      if (error) return error;
      continue;
    }

    return `${path}: '${line}' is not something the NES image's CHR reader understands (it reads .section/.macro/.rept/.byte/.space and macro calls, nothing else)`;
  }
  return null;
}

/**
 * The CHR-ROM bytes `sources` define, padded with zeros (blank tiles) to
 * exactly `size`. Only bytes inside a `.chr_rom` section count; a source
 * that contributes none is not an error on its own — a machine package may
 * ship native code for some other purpose — but a program whose sources
 * define no CHR at all is refused by the caller, which is the one that
 * knows the NES cannot show anything without it.
 */
export function assembleChrRom(sources: NativeSource[], size: number): ChrResult {
  const out: number[] = [];
  for (const source of sources) {
    const lines = source.text.split('\n').map((line) => stripComment(line).trim());
    const macros = new Map<string, Macro>();
    const state = { section: null as string | null };
    const error = readLines(lines, macros, state, out, source.path, 0);
    if (error) return { ok: false, error };
  }
  if (out.length > size) {
    return {
      ok: false,
      error: `the NES image's CHR-ROM is ${size} bytes and the linked program's .chr_rom sections define ${out.length}`,
    };
  }
  const bytes = new Uint8Array(size);
  bytes.set(out, 0);
  return { ok: true, bytes, defined: out.length };
}
