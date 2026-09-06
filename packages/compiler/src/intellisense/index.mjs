// Built-in hover and completion.
//
// The repository has no binder yet, so there is no symbol table to resolve a
// user's own variables or functions against. What *can* be answered honestly
// today is "what does this piece of built-in syntax mean" — a primitive type,
// `volatile`, `ptr`, `array`, `asm6502`, `@address`, `memory.read`/
// `memory.write`, `string`, `#frames(...)`, its `seconds` unit, `waitFrame()` — because the compiler
// already knows all of it statically, independent of any particular program.
//
// This module is that answer, expressed as a small position-based API
// (`getHoverInfo`, `getCompletions`) that an editor-protocol layer can call
// without knowing anything about 8BitScript itself. When a binder exists, the
// same two functions grow to cover user-defined names; nothing about this
// shape is a dead end.
import { tokenize, TokenKind } from '../lexer/index.mjs';
import { PRIMITIVE_INTEGER_TYPES, resolveIntegerType } from '../types/index.mjs';
import { DURATION_CLOCKS, DURATION_UNITS, SYSTEMS } from '../fold/index.mjs';
import { FACTS } from '../fold/facts.mjs';

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
  string: {
    summary: 'Constant text in the program image, as a parameter type.',
    markdown: [
      '**string**',
      '',
      'Text that lives in the program image — ROM on a cartridge, the `.prg` on a Commodore, a data segment on the web — written as a literal: `"TICK"`. A `string` parameter receives one; `s.length` is its byte count and `s[i]` its i-th character (ASCII), so a loop can put it on screen one cell at a time.',
      '',
      'Only the portable character set is allowed — space, `0`-`9`, `A`-`Z`, and `! , - . : ?` (upper case only), the characters every target can show — and at most 255 of them. A backtick string with `${...}` fields, `\`TICK ${ticks:1}\``, is a template: `text.print(cell, ...)` lays it out at compile time into one `print` per run of text and one `printNumber(cell, value, width)` per field.',
      '',
      '`const Label: string = "..."` names constant text. `let name: string<8>` is text that changes: 8 characters of RAM behind a length byte — the shape a literal has, so it goes wherever a `string` goes. `name = "..."` or `name = other` copies at runtime, cut to the capacity (a literal that does not fit is a diagnostic); `name.length` and `name[i]` read it. There is no concatenation.',
    ].join('\n'),
  },
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
      'A fixed-size array of N values of type T, read and written one element at a time: `a[i]`, `a[i] = v`. `a.length` is N, a number 8bitscript fills in.',
      '',
      '`let a: array<T, N>` is N values in RAM (zero until written, or `= [..]`); `const Table: array<T, N> = [..]` is N values of data in the program, never in RAM; `@address(0x0400) let screenRam: array<T, N>` is N cells of hardware. N is a literal or a `const`, and the size is part of the type, so memory usage is predictable — no hidden allocation or resizing.',
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

/** `#frames(...)`: the compile-time duration builtin (packages/compiler/src/fold). */
const FRAMES_DOC = [
  '**#frames(n, unit)**',
  '',
  'Compile-time duration, as a frame count. `n` is an integer or decimal literal — `#frames(1, seconds)`, `#frames(0.5, seconds)` — never a variable or expression. `unit` says what `n` is measured in and is required; the only unit so far is `seconds`.',
  '',
  'Folds at compile time to however many frames — `waitFrame()` calls — that much time takes at this project\'s configured `frameRate` (`8bs.config.ts`, default 60) — `#frames(0.5, seconds)` becomes `30` at the default rate, `25` at a configured 50. Always a plain integer once compiled: no runtime division, no floating point.',
  '',
  'The `#` says 8bitscript evaluates this before any target toolchain runs; a plain `name(...)` always runs on the machine. Nothing is reserved: `#frames` is its own token, and the unit word is only a unit in this argument position.',
].join('\n');

/** `#system()`: the machine this build is for (packages/compiler/src/fold). */
const SYSTEM_DOC = [
  '**#system()**',
  '',
  'Compile-time: the machine this build is for, as a number. Compare it with the names `@8bitscript/system` exports — `if (#system() == System.NES) { ... }` — and the other machines\' branches fold away in the generated code. Takes no arguments: the build already knows which machine.',
  '',
  `The machines, in the order \`8bs build --target\` lists them: ${[...SYSTEMS.keys()].map((name) => `\`${name}\``).join(', ')}. With no machine in hand — \`8bs check\`, this editor — the call is valid and target-dependent, like a \`.<machine>.8bs\` file.`,
  '',
  'Prefer a fact to the name where one exists: `text.COLUMNS` is right on a machine this list has never heard of; `#system() == System.PET` says nothing about a C128 in 80 columns.',
].join('\n');

const FACT_DOC = [
  '**#fact(...)**',
  '',
  'Compile-time: one fact about the machine this build is for — a number or a yes/no from its hardware fact sheet, written as words: `#fact(video.columns)`, `#fact(memory.banked)`. The value is the machine package\'s catalog entry for the stock machine, changed by whatever hardware the build was fitted with (`--profile`, `--hardware`), so the branch for hardware this build lacks folds away.',
  '',
  'A program rarely writes this itself: `@8bitscript/system` gives every fact a name — `Video.COLUMNS`, `Audio.VOICES`, `Input.KEYBOARD`, `Memory.RAM` — and reads it this way. A fact marked *run time* there means "this build may use it"; whether the hardware is really there is the capability\'s answer on the machine.',
  '',
  `The keys: ${[...FACTS].filter(([, f]) => f.program).map(([key]) => `\`${key}\``).join(', ')}. With no machine in hand — \`8bs check\`, this editor — every fact is its placeholder (0 or false) and target-dependent, like \`#system()\`.`,
].join('\n');

/** One fact key's hover, inside a `#fact(...)`. */
const factKeyDoc = (key) => {
  const fact = FACTS.get(key);
  return [
    `**${key}**`,
    '',
    `${fact.doc} A ${fact.type === 'flag' ? 'yes/no' : 'count'}, settled ${fact.when === 'run' ? 'at run time: the const says this build may use it, and the capability says whether it is there' : 'by the build'}.${fact.program ? '' : ' Not on the program\'s sheet: the CLI reads it.'}`,
    '',
    'Only a key inside `#fact(...)`; anywhere else these words are ordinary names a program is free to declare.',
  ].join('\n');
};

/** Every `#name` the compiler evaluates, with what completion says about it. */
const COMPILE_TIME_DOCS = {
  // `insert` is what goes into the buffer after a `#` the user has typed;
  // when the lexer already made a `#name` token the whole token is
  // replaced, by the label itself unless `insert` adds something to it.
  frames: { detail: 'Compile-time duration, as a frame count.', documentation: FRAMES_DOC, insert: 'frames' },
  system: { detail: 'Compile-time: the machine this build is for.', documentation: SYSTEM_DOC, insert: 'system()' },
  fact: { detail: 'Compile-time: one fact about the machine this build is for.', documentation: FACT_DOC, insert: 'fact' },
};

/** The units a `#frames(...)` duration can be written in, keyed as DURATION_UNITS is. */
const UNIT_DOCS = {};

/** `seconds`: the (only) unit a `#frames(...)` duration can be written in. */
UNIT_DOCS.seconds = [
  '**seconds**',
  '',
  'A unit for `#frames(...)`: `#frames(0.5, seconds)` is half a second, counted in logical frames — `waitFrame()` calls — at this project\'s configured `frameRate` (`8bs.config.ts`, default 60). The unit is required, so the call always says what its literal is measured in.',
  '',
  'Only a unit in the second argument to `#frames(...)`; anywhere else, `seconds` is an ordinary name a program is free to declare.',
].join('\n');

/** `waitFrame()`: block until the next logical frame (packages/compiler/src/ir). */
const WAITFRAME_DOC = [
  '**waitFrame()**',
  '',
  'Blocks until the next logical frame, then returns. Call it once per pass through your main loop — `while (true) { waitFrame(); ... }` — the way an 8-bit program waits for vertical blank (cc65\'s `waitvsync()`).',
  '',
  'Frames arrive at this project\'s configured `frameRate` (`8bs.config.ts`, default 60) on every target, whatever the real hardware refreshes at — on the 6502 machines it waits on the video chip\'s own vertical blank, on the web it waits on the page\'s frame clock. Pair it with `#frames(...)` to count time: `#frames(0.5, seconds)` is how many `waitFrame()` calls make half a second.',
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
 * `memory.write` intrinsic, and the `#frames(...)` (with its `seconds` unit),
 * `#system()`, and `waitFrame()` builtins — every built-in this milestone documents. Anything else,
 * including a user's own identifiers or namespace, returns `null`: there is
 * no binder yet to say what they mean.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {{ start: number, length: number, markdown: string } | null}
 */
export function getHoverInfo(text, offset) {
  const { tokens } = tokenize(text);
  return hoverAt(tokens, offset, text);
}

function hoverAt(tokens, offset, text) {
  const index = tokenIndexAt(tokens, offset);
  if (index === -1) return null;
  const token = tokens[index];

  // Inside a template string, a `${...}` field is ordinary source: re-lex
  // the field the parser's way (offsets shifted back into the file) and
  // answer for the token under the cursor there — `#frames`, its unit, a
  // type in a future cast — as if it stood outside the string.
  if (token.kind === TokenKind.Template) {
    const field = token.parts.find((p) => p.kind === 'field' && offset >= p.sourceStart && offset <= p.sourceEnd);
    if (!field) return null;
    const inner = tokenize(text.slice(field.sourceStart, field.sourceEnd)).tokens;
    for (const t of inner) t.start += field.sourceStart;
    return hoverAt(inner, offset, text);
  }

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

  // `#frames` is its own token kind, so any occurrence is the compile-time
  // function; `waitFrame` is reserved (see checker/index.mjs's
  // RESERVED_BUILTIN_NAMES), so unlike memory.read/write there is no
  // namespace to require — any bare occurrence means the builtin.
  if (token.kind === TokenKind.CompileTime && DURATION_CLOCKS.has(token.text.slice(1))) {
    return { start: token.start, length: token.length, markdown: FRAMES_DOC };
  }
  if (token.kind === TokenKind.CompileTime && token.text === '#system') {
    return { start: token.start, length: token.length, markdown: SYSTEM_DOC };
  }
  if (token.kind === TokenKind.CompileTime && token.text === '#fact') {
    return { start: token.start, length: token.length, markdown: FACT_DOC };
  }
  // A fact key's words are not reserved either — `video.columns` only
  // means the fact inside `#fact(...)` — so the hover finds the whole key
  // the hovered word is part of, and only claims it there.
  if (token.kind === TokenKind.Identifier) {
    const key = factKeyAt(tokens, index);
    if (key) return { start: key.start, length: key.length, markdown: factKeyDoc(key.text) };
  }
  // The unit word is *not* reserved — it only means the unit in the second
  // argument slot of a clock call, `#frames(0.5, seconds)`, so the hover has
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
 * the `seconds` in `#frames(0.5, seconds)`? Matches the exact shape the fold
 * accepts: `#<clock> ( <number> , <unit>`.
 */
/**
 * The fact key the identifier at `index` belongs to — `video.columns` for
 * either word — when it sits inside a `#fact(...)` call and is a key the
 * compiler knows; null otherwise.
 *
 * @returns {{ text: string, start: number, length: number } | null}
 */
function factKeyAt(tokens, index) {
  let first = index;
  while (tokens[first - 1]?.text === '.' && tokens[first - 2]?.kind === TokenKind.Identifier) first -= 2;
  let last = index;
  while (tokens[last + 1]?.text === '.' && tokens[last + 2]?.kind === TokenKind.Identifier) last += 2;
  const open = tokens[first - 1];
  const callee = tokens[first - 2];
  const close = tokens[last + 1];
  if (open?.text !== '(' || close?.text !== ')' || callee?.kind !== TokenKind.CompileTime || callee.text !== '#fact') return null;
  const text = tokens.slice(first, last + 1).map((t) => t.text).join('');
  if (!FACTS.has(text)) return null;
  return { text, start: tokens[first].start, length: tokens[last].start + tokens[last].length - tokens[first].start };
}

function isDurationUnitSlot(tokens, index) {
  const [callee, open, literal, comma] = [tokens[index - 4], tokens[index - 3], tokens[index - 2], tokens[index - 1]];
  return comma?.text === ','
    && literal?.kind === TokenKind.Number
    && open?.text === '('
    && callee?.kind === TokenKind.CompileTime
    && DURATION_CLOCKS.has(callee.text.slice(1));
}

/**
 * The token index the cursor is asking *about*: a word the cursor is still
 * inside or at the end of is the thing being typed, not context, so step
 * back to whatever precedes it.
 */
function contextIndex(tokens, offset) {
  const before = tokens.filter((t) => t.start < offset);
  let i = before.length - 1;
  const current = before[i];
  if (
    current
    && current.start + current.length >= offset
    && [TokenKind.Identifier, TokenKind.Type, TokenKind.Keyword, TokenKind.CompileTime].includes(current.kind)
  ) {
    i -= 1;
  }
  return { before, i };
}

/**
 * Is `offset` a position where a type name belongs?
 *
 * Only two shapes introduce a type in this grammar: a `:` annotation (`let x:`,
 * a parameter, a return type) and a type argument after a type constructor
 * (`ptr<`, `array<`, `volatile<`). Both are checked by token, not regex, so
 * `x < 5` does not get mistaken for `ptr<u8>`.
 */
function isTypePosition(tokens, offset) {
  const { before, i } = contextIndex(tokens, offset);
  const context = before[i];
  if (!context) return false;
  if (context.text === ':') return true;
  if (context.text === '<') return before[i - 1]?.kind === TokenKind.Type;
  return false;
}

/**
 * Is `offset` inside the `#name` spelling — either a `#` just typed (which
 * is not a token on its own: the lexer only makes one when an identifier
 * character follows) or a `#name` being typed?
 */
function compileTimePosition(tokens, offset, text) {
  const at = tokens.find((t) => t.kind === TokenKind.CompileTime
    && offset > t.start && offset <= t.start + t.length);
  if (at) return { replacing: true };
  return text[offset - 1] === '#' ? { replacing: false } : null;
}

/**
 * Is `offset` the unit argument of a compile-time clock call — the
 * `seconds` in `#frames(0.5, |)`? The same shape isDurationUnitSlot()
 * recognises for hover, one token earlier.
 */
/**
 * Is `offset` the key argument of a `#fact(...)` call — `#fact(|)`, or a
 * key already partly typed, `#fact(vid|)` / `#fact(video.col|)`?
 */
function isFactKeyPosition(tokens, offset) {
  const { before, i } = contextIndex(tokens, offset);
  let j = i;
  // Step back over a partly typed dotted key: the word being typed is
  // already behind `i`, so what is left is `video.` or `video`, or nothing.
  if (before[j]?.text === '.') j -= 1;
  while (before[j]?.kind === TokenKind.Identifier) {
    if (before[j - 1]?.text === '.') { j -= 2; continue; }
    j -= 1;
    break;
  }
  return before[j]?.text === '(' && before[j - 1]?.kind === TokenKind.CompileTime && before[j - 1].text === '#fact';
}

function isDurationUnitPosition(tokens, offset) {
  const { before, i } = contextIndex(tokens, offset);
  const [callee, open, literal, comma] = [before[i - 3], before[i - 2], before[i - 1], before[i]];
  return comma?.text === ','
    && literal?.kind === TokenKind.Number
    && open?.text === '('
    && callee?.kind === TokenKind.CompileTime
    && DURATION_CLOCKS.has(callee.text.slice(1));
}

/**
 * Built-in completion items available at `offset` in `text`.
 *
 * Built-ins only — the type names where a type can appear, the compile-time
 * functions after a `#`, and the unit words inside a `#frames(...)` call.
 * No project-wide or member completion: that needs the binder this
 * milestone deliberately does not add. Inside a template string, a
 * `${...}` field is ordinary source and gets the same answers it would
 * outside one.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {{ label: string, kind: 'type'|'function'|'constant', sortRank: number,
 *   detail: string, documentation: string, insertText?: string }[]}
 */
export function getCompletions(text, offset) {
  const { tokens } = tokenize(text);
  return completionsAt(tokens, offset, text);
}

function completionsAt(tokens, offset, text) {
  const index = tokenIndexAt(tokens, offset);
  const token = tokens[index];
  if (token?.kind === TokenKind.Template) {
    const field = token.parts.find((p) => p.kind === 'field'
      && offset >= p.sourceStart && offset <= p.sourceEnd);
    if (!field) return [];
    const inner = tokenize(text.slice(field.sourceStart, field.sourceEnd)).tokens;
    for (const t of inner) t.start += field.sourceStart;
    return completionsAt(inner, offset, text);
  }

  const compileTime = compileTimePosition(tokens, offset, text);
  if (compileTime) {
    return Object.entries(COMPILE_TIME_DOCS).map(([name, doc]) => ({
      label: `#${name}`,
      kind: 'function',
      sortRank: 0,
      detail: doc.detail,
      documentation: doc.documentation,
      // The `#` is already in the buffer unless the lexer made a token of
      // it, in which case the whole `#name` is what gets replaced — by the
      // label, unless the insertion adds the call's parentheses.
      ...(compileTime.replacing
        ? (doc.insert === name ? {} : { insertText: `#${doc.insert}` })
        : { insertText: doc.insert }),
    }));
  }

  if (isFactKeyPosition(tokens, offset)) {
    return [...FACTS].filter(([, fact]) => fact.program).map(([key, fact]) => ({
      label: key,
      kind: 'constant',
      sortRank: 0,
      detail: fact.doc,
      documentation: factKeyDoc(key),
    }));
  }

  if (isDurationUnitPosition(tokens, offset)) {
    return [...DURATION_UNITS.keys()].map((name) => ({
      label: name,
      kind: 'constant',
      sortRank: 0,
      detail: 'A unit a #frames(...) duration can be written in.',
      documentation: UNIT_DOCS[name],
    }));
  }

  if (!isTypePosition(tokens, offset)) return [];

  const items = [];

  for (const type of PRIMITIVE_INTEGER_TYPES) {
    items.push({
      label: type.canonicalName,
      kind: 'type',
      sortRank: 0,
      detail: `${type.summary} (${type.min}..${type.max})`,
      documentation: integerHoverMarkdown(type, type.canonicalName),
    });
  }
  for (const name of ['string', ...TYPE_CONSTRUCTOR_NAMES]) {
    items.push({
      label: name,
      kind: 'type',
      sortRank: 0,
      detail: CONSTRUCT_DOCS[name].summary,
      documentation: CONSTRUCT_DOCS[name].markdown,
    });
  }
  for (const type of PRIMITIVE_INTEGER_TYPES) {
    items.push({
      label: type.legacyAlias,
      kind: 'type',
      sortRank: 1,
      detail: `Low-level alias for ${type.canonicalName}`,
      documentation: integerHoverMarkdown(type, type.legacyAlias),
    });
  }

  return items;
}
