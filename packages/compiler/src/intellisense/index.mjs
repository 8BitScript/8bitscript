// Built-in hover and completion.
//
// The repository has no binder yet, so there is no symbol table to resolve a
// user's own variables or functions against. What *can* be answered honestly
// today is "what does this piece of built-in syntax mean" — a primitive type,
// `volatile`, `ptr`, `array`, `asm6502`, `@address`, `memory.read`/
// `memory.write`, `frames(...)`, its `seconds` unit, `waitFrame()` — because the compiler
// already knows all of it statically, independent of any particular program.
//
// This module is that answer, expressed as a small position-based API
// (`getHoverInfo`, `getCompletions`) that an editor-protocol layer can call
// without knowing anything about 8BitScript itself. When a binder exists, the
// same two functions grow to cover user-defined names; nothing about this
// shape is a dead end.
import { tokenize, TokenKind } from '../lexer/index.mjs';
import { PRIMITIVE_INTEGER_TYPES, resolveIntegerType } from '../types/index.mjs';
import { DURATION_CLOCKS, DURATION_UNITS } from '../fold/index.mjs';

/** Insert thousands separators without touching locale/ICU: `-8388608` -> `-8,388,608`. */
function formatNumber(n) {
  const sign = n < 0 ? '-' : '';
  const digits = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + digits;
}

/**
 * Hover markdown for one spelling of an integer type.
 *
 * The wording depends on *which* spelling was hovered: the canonical name
 * (`utinyint`) explains the type and names its low-level alias; the alias
 * (`u8`) leads by pointing back to the canonical name it stands for.
 *
 * @param {import('../types/index.mjs').IntegerType} type
 * @param {string} spelling
 */
function integerHoverMarkdown(type, spelling) {
  const size = `${type.bytes} byte${type.bytes === 1 ? '' : 's'} / ${type.bits} bits`;
  const range = `${formatNumber(type.min)} through ${formatNumber(type.max)}`;

  if (spelling === type.legacyAlias) {
    return [
      `**${spelling}**`,
      '',
      `Low-level alias for ${type.canonicalName}.`,
      '',
      [
        type.summary,
        `Size: ${size}`,
        `Range: ${range}`,
      ].join('  \n'),
    ].join('\n');
  }

  return [
    `**${spelling}**`,
    '',
    type.summary,
    '',
    [
      `Size: ${size}`,
      `Range: ${range}`,
      `Low-level alias: ${type.legacyAlias}`,
    ].join('  \n'),
  ].join('\n');
}

/** Documentation for the non-integer built-ins, in 8BitScript's own terms. */
const CONSTRUCT_DOCS = {
  volatile: {
    summary: 'Value that may change outside normal program flow.',
    markdown: [
      '**volatile<T>**',
      '',
      'Marks a value whose contents may change outside normal program execution.',
      '',
      'The compiler must preserve reads and writes rather than assuming the value stays unchanged.',
      '',
      'Common uses include memory-mapped hardware registers and values modified by interrupts.',
      '',
      'Most ordinary variables do not need `volatile`.',
    ].join('\n'),
  },
  ptr: {
    summary: 'Pointer to a memory location holding a value of type T.',
    markdown: [
      '**ptr<T>**',
      '',
      'A pointer to a memory location containing a value of type T, for explicit low-level memory access.',
    ].join('\n'),
  },
  array: {
    summary: 'Fixed-size array of N values of type T.',
    markdown: [
      '**array<T, N>**',
      '',
      'A fixed-size array of N values of type T.',
      '',
      'Its size is part of the type, so memory usage is predictable — no hidden allocation or resizing.',
    ].join('\n'),
  },
  asm6502: {
    summary: 'Embeds raw 6502 assembly directly.',
    markdown: [
      '**asm6502**',
      '',
      'Embeds raw 6502 assembly directly in an 8BitScript program.',
      '',
      'Use it when direct machine-level control is required. The block is passed through untouched — 8BitScript does not parse or check the assembly inside it.',
    ].join('\n'),
  },
  address: {
    summary: 'Binds a declaration to a specific memory address.',
    markdown: [
      '**@address(location)**',
      '',
      'Binds a declaration to a specific memory address.',
      '',
      'Commonly used for memory-mapped hardware registers, where a variable\'s storage is a fixed location rather than one the compiler assigns.',
    ].join('\n'),
  },
};

/** `frames(...)`: the compile-time duration builtin (packages/compiler/src/fold). */
const FRAMES_DOC = [
  '**frames(n, unit)**',
  '',
  'Compile-time duration, as a frame count. `n` is an integer or decimal literal — `frames(1, seconds)`, `frames(0.5, seconds)` — never a variable or expression. `unit` says what `n` is measured in and is required; the only unit so far is `seconds`.',
  '',
  'Folds at compile time to however many frames — `waitFrame()` calls — that much time takes at this project\'s configured `frameRate` (`8bs.config.ts`, default 60) — `frames(0.5, seconds)` becomes `30` at the default rate, `25` at a configured 50. Always a plain integer once compiled: no runtime division, no floating point.',
  '',
  'Reserved: a variable, function, parameter, or import named `frames` is a compile error. The unit word is not reserved — it is only a unit in this argument position.',
].join('\n');

/** The units a `frames(...)` duration can be written in, keyed as DURATION_UNITS is. */
const UNIT_DOCS = {};

/** `seconds`: the (only) unit a `frames(...)` duration can be written in. */
UNIT_DOCS.seconds = [
  '**seconds**',
  '',
  'A unit for `frames(...)`: `frames(0.5, seconds)` is half a second, counted in logical frames — `waitFrame()` calls — at this project\'s configured `frameRate` (`8bs.config.ts`, default 60). The unit is required, so the call always says what its literal is measured in.',
  '',
  'Only a unit in the second argument to `frames(...)`; anywhere else, `seconds` is an ordinary name a program is free to declare.',
].join('\n');

/** `waitFrame()`: block until the next logical frame (packages/compiler/src/ir). */
const WAITFRAME_DOC = [
  '**waitFrame()**',
  '',
  'Blocks until the next logical frame, then returns. Call it once per pass through your main loop — `while (true) { waitFrame(); ... }` — the way an 8-bit program waits for vertical blank (cc65\'s `waitvsync()`).',
  '',
  'Frames arrive at this project\'s configured `frameRate` (`8bs.config.ts`, default 60) on every target, whatever the real hardware refreshes at — on the 6502 machines it waits on the video chip\'s own vertical blank, on the web it waits on the page\'s frame clock. Pair it with `frames(...)` to count time: `frames(0.5, seconds)` is how many `waitFrame()` calls make half a second.',
  '',
  'Takes no arguments and returns nothing. Reserved: a variable, function, parameter, or import named `waitFrame` is a compile error.',
].join('\n');

/** `memory.read`/`memory.write`: the one namespace the compiler recognises itself. */
const MEMORY_DOCS = {
  write: [
    '**memory.write(address, value)**',
    '',
    'Writes one byte directly to the target machine\'s address space.',
    '',
    'This is the low-level equivalent of `POKE` on Commodore BASIC systems.',
    '',
    'Prefer a machine API such as `screen` when one exists for what you are trying to do.',
  ].join('\n'),
  read: [
    '**memory.read(address)**',
    '',
    'Reads one byte directly from the target machine\'s address space.',
    '',
    'This is the low-level equivalent of `PEEK` on Commodore BASIC systems.',
    '',
    'Prefer a machine API such as `screen` when one exists for what you are trying to do.',
  ].join('\n'),
};

const TYPE_CONSTRUCTOR_NAMES = ['array', 'ptr', 'volatile'];

/** The index of the token covering `offset` (a cursor right after a word still hits it), or -1. */
function tokenIndexAt(tokens, offset) {
  return tokens.findIndex((t) => offset >= t.start && offset <= t.start + t.length);
}

/**
 * Built-in hover information for the construct at `offset` in `text`.
 *
 * Recognises primitive integer types (canonical spellings like `utinyint` and
 * `int`, or their low-level `u8`/`i32`-style aliases),
 * `volatile`/`ptr`/`array`, `asm6502`, `@address`, the `memory.read`/
 * `memory.write` intrinsic, and the `frames(...)` (with its `seconds` unit)
 * and `waitFrame()` builtins — every built-in this milestone documents. Anything else,
 * including a user's own identifiers or namespace, returns `null`: there is
 * no binder yet to say what they mean.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {{ start: number, length: number, markdown: string } | null}
 */
export function getHoverInfo(text, offset) {
  const { tokens } = tokenize(text);
  const index = tokenIndexAt(tokens, offset);
  if (index === -1) return null;
  const token = tokens[index];

  if (token.kind === TokenKind.Type) {
    const integer = resolveIntegerType(token.text);
    if (integer) {
      return { start: token.start, length: token.length, markdown: integerHoverMarkdown(integer, token.text) };
    }
    const construct = CONSTRUCT_DOCS[token.text];
    if (construct) return { start: token.start, length: token.length, markdown: construct.markdown };
    return null;
  }

  if (token.kind === TokenKind.Keyword && token.text === 'asm6502') {
    return { start: token.start, length: token.length, markdown: CONSTRUCT_DOCS.asm6502.markdown };
  }

  if (token.kind === TokenKind.Decorator && token.text.slice(1) === 'address') {
    return { start: token.start, length: token.length, markdown: CONSTRUCT_DOCS.address.markdown };
  }

  if (token.kind === TokenKind.Identifier && (token.text === 'read' || token.text === 'write')) {
    const dot = tokens[index - 1];
    const object = tokens[index - 2];
    if (dot?.text === '.' && object?.kind === TokenKind.Identifier && object.text === 'memory') {
      return { start: token.start, length: token.length, markdown: MEMORY_DOCS[token.text] };
    }
  }

  // `frames` and `waitFrame` are reserved (see checker/index.mjs's
  // RESERVED_BUILTIN_NAMES), so unlike memory.read/write there is no
  // namespace to require — any bare occurrence of the identifier means the
  // builtin, not a user's own name.
  if (token.kind === TokenKind.Identifier && token.text === 'frames') {
    return { start: token.start, length: token.length, markdown: FRAMES_DOC };
  }
  // The unit word is *not* reserved — it only means the unit in the second
  // argument slot of a clock call, `frames(0.5, seconds)`, so the hover has
  // to check it is actually in that slot before claiming so.
  if (token.kind === TokenKind.Identifier && DURATION_UNITS.has(token.text) && isDurationUnitSlot(tokens, index)) {
    return { start: token.start, length: token.length, markdown: UNIT_DOCS[token.text] };
  }
  if (token.kind === TokenKind.Identifier && token.text === 'waitFrame') {
    return { start: token.start, length: token.length, markdown: WAITFRAME_DOC };
  }

  return null;
}

/**
 * Is the identifier at `index` the unit argument of a duration clock call —
 * the `seconds` in `frames(0.5, seconds)`? Matches the exact shape the fold
 * accepts: `<clock> ( <number> , <unit>`.
 */
function isDurationUnitSlot(tokens, index) {
  const [callee, open, literal, comma] = [tokens[index - 4], tokens[index - 3], tokens[index - 2], tokens[index - 1]];
  return comma?.text === ','
    && literal?.kind === TokenKind.Number
    && open?.text === '('
    && callee?.kind === TokenKind.Identifier
    && DURATION_CLOCKS.has(callee.text);
}

/**
 * Is `offset` a position where a type name belongs?
 *
 * Only two shapes introduce a type in this grammar: a `:` annotation (`let x:`,
 * a parameter, a return type) and a type argument after a type constructor
 * (`ptr<`, `array<`, `volatile<`). Both are checked by token, not regex, so
 * `x < 5` does not get mistaken for `ptr<u8>`.
 */
function isTypePosition(text, offset) {
  const { tokens } = tokenize(text);
  const before = tokens.filter((t) => t.start < offset);

  let i = before.length - 1;
  // A word the cursor is still inside/at the end of is the thing being typed,
  // not context — step back to whatever precedes it.
  const current = before[i];
  if (
    current
    && current.start + current.length >= offset
    && [TokenKind.Identifier, TokenKind.Type, TokenKind.Keyword].includes(current.kind)
  ) {
    i -= 1;
  }

  const context = before[i];
  if (!context) return false;
  if (context.text === ':') return true;
  if (context.text === '<') return before[i - 1]?.kind === TokenKind.Type;
  return false;
}

/**
 * Built-in completion items available at `offset` in `text`.
 *
 * First slice of IntelliSense: built-in type names only, offered where a type
 * can syntactically appear. No project-wide or member completion — that needs
 * the binder this milestone deliberately does not add.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {{ label: string, sortRank: number, detail: string, documentation: string }[]}
 */
export function getCompletions(text, offset) {
  if (!isTypePosition(text, offset)) return [];

  const items = [];

  for (const type of PRIMITIVE_INTEGER_TYPES) {
    items.push({
      label: type.canonicalName,
      sortRank: 0,
      detail: `${type.summary} (${type.min}..${type.max})`,
      documentation: integerHoverMarkdown(type, type.canonicalName),
    });
  }
  for (const name of TYPE_CONSTRUCTOR_NAMES) {
    items.push({
      label: name,
      sortRank: 0,
      detail: CONSTRUCT_DOCS[name].summary,
      documentation: CONSTRUCT_DOCS[name].markdown,
    });
  }
  for (const type of PRIMITIVE_INTEGER_TYPES) {
    items.push({
      label: type.legacyAlias,
      sortRank: 1,
      detail: `Low-level alias for ${type.canonicalName}`,
      documentation: integerHoverMarkdown(type, type.legacyAlias),
    });
  }

  return items;
}
