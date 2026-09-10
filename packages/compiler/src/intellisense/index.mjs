// Built-in hover and completion.
//
// The repository has no binder yet, so there is no symbol table to resolve a
// user's own variables or functions against. What *can* be answered honestly
// today is "what does this piece of built-in syntax mean" — a primitive type,
// `volatile`, `ptr`, `array`, `asm6502`, `@address`, `memory.read`/
// `memory.write`, `string`, `#frames(...)`, its `seconds` unit, `waitFrame()` — because the compiler
// already knows all of it statically, independent of any particular program.
//
// One more thing can be answered honestly without a binder: what a *named
// import* itself exports. `import { screen } from "@8bitscript/screen"`
// names a module the resolver can already find (see resolveModuleFile
// below); reading that module's own namespace/function/const declarations —
// token-level, the same way this module answers everything else — is enough
// to hover `screen.blank` or complete `screen.bl|` without needing to know
// what a *user's* declarations mean. That stays true right up to the edge of
// a binder: this module still cannot tell you what `let x = ...` holds.
//
// This module is that answer, expressed as a small position-based API
// (`getHoverInfo`, `getCompletions`) that an editor-protocol layer can call
// without knowing anything about 8BitScript itself. When a binder exists, the
// same two functions grow to cover user-defined names; nothing about this
// shape is a dead end.
import { readFileSync } from 'node:fs';

import { tokenize, TokenKind } from '../lexer/index.mjs';
import { PRIMITIVE_INTEGER_TYPES, resolveIntegerType } from '../types/index.mjs';
import { DURATION_CLOCKS, DURATION_UNITS, SYSTEMS } from '../fold/index.mjs';
import { FACTS } from '../fold/facts.mjs';
import { resolveSpecifier, RELEASE_MACHINES } from '../resolver/index.mjs';

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
      'Only the portable character set is allowed — space, `0`-`9`, `A`-`Z`, `a`-`z`, and `! , - . : ?` — and at most 255 of them. A backtick string with `${...}` fields, `\`TICK ${ticks:1}\``, is a template: `text.print(cell, ...)` lays it out at compile time into one `print` per run of text and one `printNumber(cell, value, width)` per field.',
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
      '',
      'A function takes one the same way — `function pick(t: array<u8, 4>, i: u8)` — and the call passes the array by name: the address of its first element, with nothing copied and no length traveling alongside it, since `t.length` is folded from the type. An array parameter is read-only and has no default.',
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

/** `memory.read`/`memory.write`: the one namespace the compiler recognizes itself. */
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

// ---- member hover/completion for a named import's exports -----------------
//
// The pieces below let `screen.blank(...)` hover and `screen.bl|` complete,
// for exactly the shape that makes it possible without a binder: a name
// bound by `import { X } from "specifier"` in *this* file, where `specifier`
// resolves (see resolveModuleFile) to a real `.8bs` file on disk whose own
// declarations can be read the same token-level way the rest of this module
// already reads the current file.

/**
 * Every `import { a, b as c } from "specifier"` binding in `tokens`, as
 * `{ imported, local, specifier }`. Token-level and tolerant, like
 * resolver/index.mjs's findImports — a syntax error elsewhere in the file
 * must not stop an import earlier in it from being understood. A bare
 * `import "specifier"` binds no names, so it contributes nothing here.
 */
function findImportBindings(tokens) {
  const bindings = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].kind !== TokenKind.Keyword || tokens[i].text !== 'import') continue;
    if (tokens[i + 1]?.text !== '{') continue;

    const names = [];
    let j = i + 2;
    while (j < tokens.length && tokens[j].text !== '}') {
      if (tokens[j].kind === TokenKind.Identifier) {
        const imported = tokens[j].text;
        let local = imported;
        if (tokens[j + 1]?.kind === TokenKind.Keyword && tokens[j + 1].text === 'as' && tokens[j + 2]?.kind === TokenKind.Identifier) {
          local = tokens[j + 2].text;
          j += 2;
        }
        names.push({ imported, local });
      }
      j += 1;
    }
    while (j < tokens.length && tokens[j].text !== 'from' && tokens[j].text !== ';') j += 1;
    const source = tokens[j]?.text === 'from' ? tokens[j + 1] : null;
    if (source?.kind === TokenKind.String) {
      const specifier = source.text.slice(1, -1);
      for (const name of names) bindings.push({ ...name, specifier });
    }
  }
  return bindings;
}

/**
 * The file a named import's specifier resolves to, from `fromFile` — or
 * `null` when it does not resolve to exactly one file.
 *
 * A plain resolution (a relative `.8bs` path, or a package with a single
 * entry) is used as-is. A machine-conditional package entry — `@8bitscript/
 * screen` and every other hardware API, keyed per target — resolves to
 * `{ path: null }` with no machine in hand (see resolveConditionalEntry):
 * valid, but target-dependent, the same answer `#system()`'s hover already
 * gives honestly rather than guessing a machine. Hover and completion pick
 * one anyway here, because the alternative is no docs at all for exactly the
 * APIs (`screen`, `text`, `input`, ...) this feature exists for — so this is
 * the one place in this module that *does* guess, and says so
 * (`conditional: true`) so the caller can caveat it. RELEASE_MACHINES,
 * first-to-resolve, rather than "first key in the manifest": the machines
 * this release actually builds for, in a fixed order, so the choice is
 * deterministic rather than an artifact of object key order.
 */
function resolveModuleFile(specifier, fromFile) {
  if (!fromFile) return null;
  const plain = resolveSpecifier(specifier, fromFile);
  if (plain?.code) return null;
  if (plain?.path) return { path: plain.path, conditional: false };
  if (plain?.path !== null) return null;

  for (const machine of RELEASE_MACHINES) {
    const branch = resolveSpecifier(specifier, fromFile, { machine });
    if (branch?.path) return { path: branch.path, conditional: true, machine };
  }
  return null;
}

/** One `//` or `/* *\/` comment token's text, without its delimiters. */
function commentText(token) {
  const raw = token.text;
  if (raw.startsWith('//')) return raw.slice(2).trim();
  return raw.slice(2, -2).split('\n').map((line) => line.replace(/^\s*\*?\s?/, '')).join(' ').trim();
}

/**
 * The doc comment immediately before `declIndex` (an optional leading
 * `export` skipped over first, so a comment above `export function` still
 * attaches) — every contiguous `//`/`/* *\/` token with no blank line
 * between it and the declaration, or between it and the next comment up.
 * `null` when nothing is that tightly bound: a comment separated by a blank
 * line is prose about something else, not this declaration's doc.
 */
function leadingDoc(tokens, declIndex, text) {
  let anchor = declIndex;
  if (tokens[anchor - 1]?.kind === TokenKind.Keyword && tokens[anchor - 1].text === 'export') anchor -= 1;

  let cursor = tokens[anchor].start;
  let k = anchor - 1;
  const lines = [];
  while (k >= 0 && tokens[k].kind === TokenKind.Comment) {
    const comment = tokens[k];
    const gap = text.slice(comment.start + comment.length, cursor);
    if ((gap.match(/\n/g) ?? []).length > 1) break;
    lines.unshift(commentText(comment));
    cursor = comment.start;
    k -= 1;
  }
  return lines.length > 0 ? lines.join(' ') : null;
}

/** A comment on the same line right after the token at `index`, if any — `const X: u8 = 1; // like this`. */
function trailingDoc(tokens, index, text) {
  const comment = tokens[index + 1];
  if (comment?.kind !== TokenKind.Comment) return null;
  const gap = text.slice(tokens[index].start + tokens[index].length, comment.start);
  return gap.includes('\n') ? null : commentText(comment);
}

/**
 * `function name(params): ReturnType { ...` starting at `tokens[i]` (the
 * `function` keyword) — its name, rendered signature, and the index of its
 * own opening `{` (left unconsumed: the caller's generic brace tracking
 * walks the body, so nothing inside it is mistaken for another member).
 * `null` if `tokens[i]` is not actually shaped like a function declaration.
 */
function readFunctionSignature(tokens, i, text) {
  const nameToken = tokens[i + 1];
  const openParen = tokens[i + 2];
  if (nameToken?.kind !== TokenKind.Identifier || openParen?.text !== '(') return null;

  let depth = 1;
  let j = i + 3;
  while (j < tokens.length && depth > 0) {
    if (tokens[j].text === '(') depth += 1;
    else if (tokens[j].text === ')') { depth -= 1; if (depth === 0) break; }
    j += 1;
  }
  const closeParen = tokens[j];
  if (!closeParen) return null;
  const params = text.slice(openParen.start + 1, closeParen.start).replace(/\s+/g, ' ').trim();

  let k = j + 1;
  let returnType = 'void';
  if (tokens[k]?.text === ':') {
    const typeStart = tokens[k + 1]?.start;
    k += 1;
    while (tokens[k] && tokens[k].text !== '{') k += 1;
    const last = tokens[k - 1];
    returnType = last ? text.slice(typeStart, last.start + last.length).replace(/\s+/g, ' ').trim() : returnType;
  } else {
    while (tokens[k] && tokens[k].text !== '{') k += 1;
  }
  if (tokens[k]?.text !== '{') return null;

  return {
    kind: 'function',
    name: nameToken.text,
    signature: `${nameToken.text}(${params}): ${returnType}`,
    bodyIndex: k,
  };
}

/**
 * `const name: Type = value;` starting at `tokens[i]` (the `const` keyword)
 * — its name, rendered signature, value (for a short hover-worthy default
 * like `6` or `#fact(video.columns)`), and the index of its terminating
 * `;`. `null` if `tokens[i]` is not shaped like a const declaration.
 */
function readConstSignature(tokens, i, text) {
  const nameToken = tokens[i + 1];
  if (nameToken?.kind !== TokenKind.Identifier || tokens[i + 2]?.text !== ':') return null;

  let j = i + 3;
  const typeStart = tokens[j]?.start;
  while (tokens[j] && tokens[j].text !== '=' && tokens[j].text !== ';') j += 1;
  const typeEnd = tokens[j - 1];
  if (!typeEnd) return null;
  const type = text.slice(typeStart, typeEnd.start + typeEnd.length).replace(/\s+/g, ' ').trim();

  let value = null;
  if (tokens[j]?.text === '=') {
    const valueStart = tokens[j + 1]?.start;
    j += 1;
    while (tokens[j] && tokens[j].text !== ';') j += 1;
    const valueEnd = tokens[j - 1];
    if (valueEnd) value = text.slice(valueStart, valueEnd.start + valueEnd.length).replace(/\s+/g, ' ').trim();
  }
  if (tokens[j]?.text !== ';') return null;

  return { kind: 'constant', name: nameToken.text, signature: `${nameToken.text}: ${type}`, value, endIndex: j };
}

/**
 * Every top-level `namespace` that `text` (a whole module file, one hop
 * away through an import, not the document being edited) declares, as
 * `Map<namespaceName, Map<memberName, MemberInfo>>`.
 *
 * Only namespaces, because that is the only shape a hardware API's module
 * exports today — `export namespace screen { ... }`, never a bare top-level
 * `export function`/`export const` (every package's src/ follows this; see
 * the intellisense tests) — and a bare `import { x } from "..."` binding an
 * unrecognized name already falls through to "no member info" honestly, the
 * same as any other name this module cannot explain.
 *
 * One generic pass tracking brace depth, rather than a real parse: this
 * reads an *already-resolved* module, one hop away from the file being
 * edited, so — unlike the document under the cursor — it is never mid-edit
 * and does not need to tolerate a broken parse. Namespaces do not nest here,
 * so one `container` (rather than a stack) is enough to track "the
 * namespace body we are directly inside, if any"; a member is only
 * recognized at the depth immediately inside its namespace's braces, so a
 * `let`/`const` local to a member function's body is never mistaken for
 * another member.
 */
function scanModule(text) {
  const { tokens } = tokenize(text);
  const namespaces = new Map();
  let container = null;
  let depth = 0;
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (!container && depth === 0 && token.kind === TokenKind.Keyword && token.text === 'namespace') {
      const nameToken = tokens[i + 1];
      if (nameToken?.kind === TokenKind.Identifier && tokens[i + 2]?.text === '{') {
        const members = new Map();
        namespaces.set(nameToken.text, members);
        container = { depth: 1, members };
        depth = 1;
        i += 3;
        continue;
      }
    }

    if (container && depth === container.depth && token.kind === TokenKind.Keyword && token.text === 'function') {
      const info = readFunctionSignature(tokens, i, text);
      if (info) {
        info.doc = leadingDoc(tokens, i, text);
        container.members.set(info.name, info);
        i = info.bodyIndex;
        continue;
      }
    }

    if (container && depth === container.depth && token.kind === TokenKind.Keyword && token.text === 'const') {
      const info = readConstSignature(tokens, i, text);
      if (info) {
        info.doc = trailingDoc(tokens, info.endIndex, text) ?? leadingDoc(tokens, i, text);
        container.members.set(info.name, info);
        i = info.endIndex + 1;
        continue;
      }
    }

    if (token.text === '{') { depth += 1; i += 1; continue; }
    if (token.text === '}') {
      if (container && depth === container.depth) container = null;
      depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }

  return namespaces;
}

/** Markdown for one namespace member — `screen.blank`, `BorderColor.BLUE`. */
function memberMarkdown(objectName, member, resolved) {
  const heading = member.kind === 'function'
    ? `**${objectName}.${member.signature}**`
    : `**${objectName}.${member.signature}**${member.value ? ` = ${member.value}` : ''}`;
  const lines = [heading, ''];
  if (member.doc) lines.push(member.doc, '');
  if (resolved.conditional) {
    lines.push(`Shown as implemented for the \`${resolved.machine}\` target — another target's version may differ.`);
  }
  return lines.join('\n').trimEnd();
}

/**
 * The namespace a `local` import binding names, resolved from `fromFile` —
 * or `null` when `local` is not a known import, its specifier does not
 * resolve, or the exported name it binds is not a namespace (a plain
 * imported function/const has no members to look up).
 */
function importedNamespace(tokens, local, fromFile) {
  const binding = findImportBindings(tokens).find((b) => b.local === local);
  if (!binding) return null;
  const resolved = resolveModuleFile(binding.specifier, fromFile);
  if (!resolved) return null;
  const members = scanModule(readFileSync(resolved.path, 'utf8')).get(binding.imported);
  return members ? { members, resolved } : null;
}

/**
 * Built-in hover information for the construct at `offset` in `text`.
 *
 * Recognizes primitive integer types (canonical spellings like `utinyint` and
 * `int`, or their low-level `u8`/`i32`-style aliases),
 * `volatile`/`ptr`/`array`, `asm6502`, `@address`, the `memory.read`/
 * `memory.write` intrinsic, and the `#frames(...)` (with its `seconds` unit),
 * `#system()`, and `waitFrame()` builtins — every built-in this milestone documents — plus,
 * given `options.path`, a member of a named import's own namespace
 * (`screen.blank`, `BorderColor.BLUE`; see importedNamespace). Anything
 * else, including a user's own variables or functions, returns `null`:
 * there is no binder yet to say what they mean.
 *
 * @param {string} text
 * @param {number} offset
 * @param {{ path?: string }} [options] `path`: absolute path of `text`'s
 *   file, needed to resolve a named import to the module it names — see
 *   resolveModuleFile. Without it, member hover is unavailable, the same
 *   way import-resolution diagnostics are unavailable for a document with
 *   no path on disk (packages/language-server/src/server.mjs's `validate`).
 * @returns {{ start: number, length: number, markdown: string } | null}
 */
export function getHoverInfo(text, offset, options = {}) {
  const { tokens } = tokenize(text);
  return hoverAt(tokens, offset, text, options.path);
}

function hoverAt(tokens, offset, text, filePath) {
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
    return hoverAt(inner, offset, text, filePath);
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

  // A member of a named import's own namespace — `screen.blank`,
  // `BorderColor.BLUE` — read from the module the import resolves to (see
  // importedNamespace). Checked before the `memory.read`/`memory.write`
  // intrinsic below: `memory` is not actually reserved (unlike `waitFrame`
  // — see checker/index.mjs's RESERVED_BUILTIN_NAMES), so a program that
  // imports its own `memory` namespace is rare but legal, and its own
  // `read`/`write` should win over the builtin's docs.
  if (token.kind === TokenKind.Identifier) {
    const dot = tokens[index - 1];
    const object = tokens[index - 2];
    if (dot?.text === '.' && object?.kind === TokenKind.Identifier) {
      const namespace = importedNamespace(tokens, object.text, filePath);
      const member = namespace?.members.get(token.text);
      if (member) {
        return {
          start: token.start,
          length: token.length,
          markdown: memberMarkdown(object.text, member, namespace.resolved),
        };
      }
    }
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
 * recognizes for hover, one token earlier.
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
 * The object name right before the cursor, when the cursor sits right after
 * its `.` — `screen.|` or `screen.bl|` — both `null` and `object` come back
 * `undefined`/absent when it does not, e.g. `#fact(video.col|)`, which
 * isFactKeyPosition already claims first in completionsAt so this is never
 * reached for it.
 */
function memberPosition(tokens, offset) {
  const { before, i } = contextIndex(tokens, offset);
  const dot = before[i];
  const object = before[i - 1];
  return dot?.text === '.' && object?.kind === TokenKind.Identifier ? object.text : null;
}

/**
 * Built-in completion items available at `offset` in `text`.
 *
 * Built-ins — the type names where a type can appear, the compile-time
 * functions after a `#`, and the unit words inside a `#frames(...)` call —
 * plus, given `options.path`, the members of a named import's own namespace
 * right after `object.` (`screen.bl|` -> `blank`; see importedNamespace).
 * No project-wide completion, and no member completion for a local variable
 * or a namespace not reached through a named import: that needs the binder
 * this milestone deliberately does not add. Inside a template string, a
 * `${...}` field is ordinary source and gets the same answers it would
 * outside one.
 *
 * @param {string} text
 * @param {number} offset
 * @param {{ path?: string }} [options] See getHoverInfo's `options.path`.
 * @returns {{ label: string, kind: 'type'|'function'|'constant', sortRank: number,
 *   detail: string, documentation: string, insertText?: string }[]}
 */
export function getCompletions(text, offset, options = {}) {
  const { tokens } = tokenize(text);
  return completionsAt(tokens, offset, text, options.path);
}

function completionsAt(tokens, offset, text, filePath) {
  const index = tokenIndexAt(tokens, offset);
  const token = tokens[index];
  if (token?.kind === TokenKind.Template) {
    const field = token.parts.find((p) => p.kind === 'field'
      && offset >= p.sourceStart && offset <= p.sourceEnd);
    if (!field) return [];
    const inner = tokenize(text.slice(field.sourceStart, field.sourceEnd)).tokens;
    for (const t of inner) t.start += field.sourceStart;
    return completionsAt(inner, offset, text, filePath);
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

  const object = memberPosition(tokens, offset);
  if (object) {
    const namespace = importedNamespace(tokens, object, filePath);
    if (!namespace) return [];
    return [...namespace.members.values()].map((member) => ({
      label: member.name,
      kind: member.kind,
      sortRank: 0,
      detail: `${object}.${member.signature}`,
      documentation: memberMarkdown(object, member, namespace.resolved),
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
