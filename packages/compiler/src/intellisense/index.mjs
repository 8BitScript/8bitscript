// Hover, completion and go-to-definition.
//
// Two layers. The built-ins are answered token-level, independent of any
// particular program: "what does this piece of built-in syntax mean" — a
// primitive type, `volatile`, `ptr`, `array`, `asm6502`, `@address`,
// `memory.read`/`memory.write`, `string`, `#frames(...)`, its `seconds`
// unit, `waitFrame()` — because the compiler knows all of it statically.
// The program's own names — its components, functions, variables, and the
// ones it imports — are answered by the binder, in symbols.mjs: what is
// under the cursor, what is visible from it, and in 8BX which component a
// tag names and which props it takes.
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
// (`getHoverInfo`, `getCompletions`, `getDefinition`) that an
// editor-protocol layer can call without knowing anything about 8BitScript
// itself.
import { readFileSync, statSync } from 'node:fs';

import { isOperandToken, tokenize, TokenKind } from '../lexer/index.mjs';
import { PRIMITIVE_INTEGER_TYPES, resolveIntegerType } from '../types/index.mjs';
import { DURATION_CLOCKS, DURATION_UNITS, SYSTEMS } from '../fold/index.mjs';
import { FACTS } from '../fold/facts.mjs';
import { SymbolKind } from '../binder/index.mjs';
import { machineOfVariant } from '../resolver/index.mjs';
import { MACHINES, sourceKindOf } from '../source/index.mjs';
import {
  bindModule, bxPosition, propsOf, resolvePortableModule, scopeAt, symbolAt, symbolMarkdown, visibleSymbols,
} from './symbols.mjs';

export { getDefinition } from './symbols.mjs';

/** The source kind hover and completion lex as: the option, else the file's extension, else `.8bs`. */
const kindOf = (options) => options.sourceKind ?? sourceKindOf(options.path ?? '') ?? '.8bs';

/** Insert thousands separators without touching locale/ICU: `-8388608` -> `-8,388,608`. */
function formatNumber(n) {
  const sign = n < 0 ? '-' : '';
  const digits = Math.abs(n).toString();
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return sign + out;
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
  'Folds at compile time to however many frames — `waitFrame()` calls — that much time takes at this project\'s configured `frameRate` (`8bitscript.config.ts`, default 60) — `#frames(0.5, seconds)` becomes `30` at the default rate, `25` at a configured 50. Always a plain integer once compiled: no runtime division, no floating point.',
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

/** `#package("version")`: a field of the program's own package.json (packages/compiler/src/fold/package.mjs). */
const PACKAGE_DOC = [
  '**#package("version")**',
  '',
  'Compile-time: one field of the program\'s own `package.json` — the nearest one above this file, the package boundary as Node draws it — as a string literal. `#package("version")` is the version the package was published as, so a title screen prints it and nobody bumps a const by hand; `#package("name")` is the other readable field. Once folded it *is* the literal: the same bytes as writing `"0.6.0"`, the same portable-character check where it is printed.',
  '',
  'One field name in quotes, `"version"` or `"name"`; anything else is `8BS1041`. No `package.json` above the file, one that does not parse, or one without the field is `8BS1042`, naming the file. `8bs check` and this editor resolve it from the file exactly as a build does.',
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
  package: { detail: 'Compile-time: a field of the program\'s own package.json.', documentation: PACKAGE_DOC, insert: 'package("version")' },
};

/** The units a `#frames(...)` duration can be written in, keyed as DURATION_UNITS is. */
const UNIT_DOCS = {};

/** `seconds`: the (only) unit a `#frames(...)` duration can be written in. */
UNIT_DOCS.seconds = [
  '**seconds**',
  '',
  'A unit for `#frames(...)`: `#frames(0.5, seconds)` is half a second, counted in logical frames — `waitFrame()` calls — at this project\'s configured `frameRate` (`8bitscript.config.ts`, default 60). The unit is required, so the call always says what its literal is measured in.',
  '',
  'Only a unit in the second argument to `#frames(...)`; anywhere else, `seconds` is an ordinary name a program is free to declare.',
].join('\n');

/** `waitFrame()`: block until the next logical frame (packages/compiler/src/ir). */
const WAITFRAME_DOC = [
  '**waitFrame()**',
  '',
  'Blocks until the next logical frame, then returns. Call it once per pass through your main loop — `while (true) { waitFrame(); ... }` — the way an 8-bit program waits for vertical blank (cc65\'s `waitvsync()`).',
  '',
  'Frames arrive at this project\'s configured `frameRate` (`8bitscript.config.ts`, default 60) on every target, whatever the real hardware refreshes at — on the 6502 machines it waits on the video chip\'s own vertical blank, on the web it waits on the page\'s frame clock. Pair it with `#frames(...)` to count time: `#frames(0.5, seconds)` is how many `waitFrame()` calls make half a second.',
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
export function scanModule(text) {
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

// ---- the portable view of a machine-keyed package -------------------------
//
// `@8bitscript/screen`'s entry is one file per machine, so the file a hover
// reads is a choice — and the wrong one to make silently. The editor is
// where a program is written for nine machines at once, so a member is
// shown as the API every machine agrees on: each machine's module is
// scanned, the members are merged by name, and what differs between
// machines is said (which machines have it, whose signature disagrees,
// whose doc is being shown) rather than shown as one machine's version
// with a footer hoping nobody notices. See packages/compiler/AGENTS.md,
// "IntelliSense shows the portable API".

/** scanModule's result per file, kept until the file's mtime changes — nine module scans per hover is fine once, not every keystroke. */
const scanCache = new Map();

function scanModuleCached(path) {
  let mtimeMs;
  try {
    ({ mtimeMs } = statSync(path));
  } catch {
    return null;
  }
  const cached = scanCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.namespaces;
  const namespaces = scanModule(readFileSync(path, 'utf8'));
  scanCache.set(path, { mtimeMs, namespaces });
  return namespaces;
}

/** `a, b and c` — a list the way a sentence says it. */
function listOf(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The text most machines share, among those with a value: the majority,
 * ties to the earlier machine in `8bs targets` order. Returns the winning
 * text and the machines carrying it.
 */
function mostShared(values) {
  const counts = new Map();
  for (const [machine, value] of values) {
    if (value === null || value === undefined || value === '') continue;
    if (!counts.has(value)) counts.set(value, []);
    counts.get(value).push(machine);
  }
  let best = null;
  for (const [value, machines] of counts) {
    if (!best || machines.length > best.machines.length) best = { value, machines };
  }
  return best;
}

/**
 * One member as every machine sees it, merged from each machine's own
 * scan of it. `signature`, `kind`, `value` and `doc` are the portable
 * reading (mostShared); `machines` lists where the member exists at all;
 * `signatures` and `docs` keep each machine's own, for the differences the
 * markdown states.
 */
function mergeMember(name, perMachine) {
  const machines = perMachine.map(([machine]) => machine);
  const signature = mostShared(perMachine.map(([m, info]) => [m, info.signature]));
  const doc = mostShared(perMachine.map(([m, info]) => [m, info.doc]));
  const value = mostShared(perMachine.map(([m, info]) => [m, info.value]));
  const kinds = new Set(perMachine.map(([, info]) => info.kind));
  return {
    name,
    kind: kinds.size === 1 ? perMachine[0][1].kind : 'function',
    signature: signature.value,
    value: value?.value ?? null,
    doc: doc?.value ?? null,
    docShared: doc?.machines ?? [],
    docs: perMachine.filter(([, info]) => info.doc).map(([m, info]) => [m, info.doc]),
    machines,
    dissent: perMachine.filter(([, info]) => info.signature !== signature.value).map(([m, info]) => [m, info.signature]),
  };
}

/**
 * The namespace `name` merged across `branches` (`[{ machine, path }]`):
 * `Map<memberName, MergedMember>` in first-seen order, or null when no
 * branch declares the namespace.
 */
function mergeNamespace(name, branches) {
  const perMember = new Map();
  const declaring = [];
  for (const { machine, path } of branches) {
    const members = scanModuleCached(path)?.get(name);
    if (!members) continue;
    declaring.push(machine);
    for (const [memberName, info] of members) {
      if (!perMember.has(memberName)) perMember.set(memberName, []);
      perMember.get(memberName).push([machine, info]);
    }
  }
  if (declaring.length === 0) return null;
  const merged = new Map();
  for (const [memberName, perMachine] of perMember) merged.set(memberName, mergeMember(memberName, perMachine));
  return { members: merged, machines: declaring };
}

/**
 * Markdown for one namespace member — `screen.blank`, `BorderColor.BLUE`.
 *
 * For a member of a single-file module, the heading, and the doc if there
 * is one. For a member merged across machines (`portable`), the same, and
 * then only what differs: which machines have it when not all do (and
 * whether this file's or project's machine is among them), whose
 * signature disagrees with the portable one, and — when no two machines
 * share a doc — whose doc is being shown, so a note about one machine's
 * KERNAL is never mistaken for the contract. Nothing is said when nothing
 * differs: the portable API is the ordinary case, and reads as such.
 *
 * @param {string} objectName
 * @param {object} member
 * @param {{ portable: { machines: string[] } | null, machine: string|null, machineWhy: string|null }} context
 */
function memberMarkdown(objectName, member, context) {
  const heading = member.kind === 'function'
    ? `**${objectName}.${member.signature}**`
    : `**${objectName}.${member.signature}**${member.value ? ` = ${member.value}` : ''}`;
  const lines = [heading, ''];

  if (!context.portable) {
    if (member.doc) lines.push(member.doc, '');
    return lines.join('\n').trimEnd();
  }

  const all = context.portable.machines;
  const missing = all.filter((m) => !member.machines.includes(m));
  const perMachineDocs = member.doc && member.docShared.length < 2 && member.docs.length > 1;

  if (member.doc) {
    if (perMachineDocs) {
      // Every machine documents it in its own words: show the one this
      // file or project is for when known, else the first, and say so.
      const pick = member.docs.find(([m]) => m === context.machine) ?? member.docs[0];
      lines.push(`On ${pick[0]}: ${pick[1]}`, '');
      const others = member.docs.length - 1;
      lines.push(`Each machine documents this in its own words — ${others} more in the machines' modules.`, '');
    } else {
      lines.push(member.doc, '');
    }
  }

  if (missing.length > 0) {
    if (context.machine && missing.includes(context.machine)) {
      lines.push(`**Not on ${context.machine}** — ${context.machineWhy}.`, '');
    }
    lines.push(`Available on ${listOf(member.machines)}; not on ${listOf(missing)}.`, '');
  }

  for (const [machine, signature] of member.dissent) {
    lines.push(`On ${machine}: \`${objectName}.${signature}\``, '');
  }

  if (context.portable) {
    // The module a jump lands in: this file's or project's machine when it
    // has the member, else the first machine that does — never a module
    // the member is missing from.
    const target = member.machines.includes(context.machine) ? context.machine : member.machines[0];
    const why = target === context.machine ? context.machineWhy : 'the first machine that has it';
    lines.push(`Go to Definition opens ${target}'s module (${why}).`);
  }
  return lines.join('\n').trimEnd();
}

/**
 * The namespace a `local` import binding names, resolved from `fromFile`
 * — merged across every machine's module when the import is
 * target-dependent — or `null` when `local` is not a known import, its
 * specifier does not resolve, or the exported name it binds is not a
 * namespace (a plain imported function/const has no members to look up).
 *
 * `machine` is the machine to read the import *for* when it matters — this
 * file's own twin, or the project's single target: it decides which
 * per-machine doc is shown, which machine's absence is called out, and
 * which module Go to Definition opens.
 *
 * @returns {{ members: Map<string, object>, context: object } | null}
 */
function importedNamespace(tokens, local, fromFile, checkout, machine = null) {
  const binding = findImportBindings(tokens).find((b) => b.local === local);
  if (!binding) return null;
  const resolved = resolvePortableModule(binding.specifier, fromFile, checkout);
  if (!resolved) return null;

  if (!resolved.conditional) {
    const members = scanModuleCached(resolved.path)?.get(binding.imported);
    if (!members) return null;
    return { members, context: { portable: null, machine: null, machineWhy: null } };
  }

  const merged = mergeNamespace(binding.imported, resolved.branches);
  if (!merged) return null;
  return {
    members: merged.members,
    context: { portable: { machines: merged.machines }, machine, machineWhy: null },
  };
}

/**
 * The machine the file at `path` is read for: its own twin's (`x.pet.8bs`
 * is the PET's file, whatever the project builds), else the project's
 * single target when the language server passed one, else null — with
 * the reason, for the hover to say.
 */
function machineFor(path, options) {
  const twin = path ? machineOfVariant(path) : null;
  if (twin) return { machine: twin, why: "this file's machine" };
  if (options.machine) return { machine: options.machine, why: "this project's target" };
  return { machine: null, why: null };
}

/**
 * Built-in hover information for the construct at `offset` in `text`.
 *
 * Recognizes primitive integer types (canonical spellings like `utinyint` and
 * `int`, or their low-level `u8`/`i32`-style aliases),
 * `volatile`/`ptr`/`array`, `asm6502`, `@address`, the `memory.read`/
 * `memory.write` intrinsic, and the `#frames(...)` (with its `seconds` unit),
 * `#system()`, `#fact(...)`, `#package(...)`, and `waitFrame()` builtins — plus,
 * given `options.path`, a member of a named import's own namespace
 * (`screen.blank`, `BorderColor.BLUE`; see importedNamespace). Anything
 * else, including a user's own variables or functions, returns `null`:
 * there is no binder yet to say what they mean.
 *
 * @param {string} text
 * @param {number} offset
 * @param {{ path?: string, checkout?: string|null }} [options] `path`: absolute path of `text`'s
 *   file, needed to resolve a named import to the module it names — see
 *   resolveModuleFile. Without it, member hover is unavailable, the same
 *   way import-resolution diagnostics are unavailable for a document with
 *   no path on disk (packages/language-server/src/server.mjs's `validate`).
 *   `checkout` is the same local 8BitScript tree `8bs --checkout` names.
 *   `machine`: the project's single configured target, if it has exactly
 *   one (the language server reads 8bitscript.config.ts) — the machine a
 *   target-dependent import is read *for* when the file is not itself a
 *   twin; see machineFor.
 * @returns {{ start: number, length: number, markdown: string } | null}
 */
export function getHoverInfo(text, offset, options = {}) {
  const { tokens } = tokenize(text, options.path ?? '<unknown>', { sourceKind: kindOf(options) });
  const machine = machineFor(options.path, options);
  const builtin = hoverAt(tokens, offset, text, options.path, options.checkout, machine);
  if (builtin) return builtin;
  // Not a built-in: one of the program's own names, if the binder knows it.
  const module = bindModule(text, options.path ?? null, { sourceKind: kindOf(options), checkout: options.checkout, machine: machine.machine });
  const hit = symbolAt(module, offset);
  const markdown = hit ? symbolMarkdown(module, hit.symbol) : null;
  return markdown ? { start: hit.token.start, length: hit.token.length, markdown } : null;
}

function hoverAt(tokens, offset, text, filePath, checkout, machine = { machine: null, why: null }) {
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
    return hoverAt(inner, offset, text, filePath, checkout);
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
      const namespace = importedNamespace(tokens, object.text, filePath, checkout, machine.machine);
      const member = namespace?.members.get(token.text);
      if (member) {
        return {
          start: token.start,
          length: token.length,
          markdown: memberMarkdown(object.text, member, { ...namespace.context, machineWhy: machine.why }),
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
  if (token.kind === TokenKind.CompileTime && token.text === '#package') {
    return { start: token.start, length: token.length, markdown: PACKAGE_DOC };
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
 * Then the program's own: in `.8bx`, the components a `<` can name, the
 * element a `</` closes, and a component's props inside its tag; anywhere
 * an expression could go, every name visible from there. Inside a template
 * string, a `${...}` field is ordinary source and gets the same answers it
 * would outside one.
 *
 * @param {string} text
 * @param {number} offset
 * @param {{ path?: string, checkout?: string|null, sourceKind?: string, machine?: string|null }} [options] See getHoverInfo's `options`.
 * @returns {{ label: string, kind: string, sortRank: number,
 *   detail: string, documentation: string, insertText?: string, snippet?: boolean }[]}
 *   `snippet` marks an `insertText` with `$1` cursor stops.
 */
export function getCompletions(text, offset, options = {}) {
  const sourceKind = kindOf(options);
  const { tokens } = tokenize(text, options.path ?? '<unknown>', { sourceKind });
  const machine = machineFor(options.path, options);
  const program = () => bindModule(text, options.path ?? null, { sourceKind, checkout: options.checkout, machine: machine.machine });
  return completionsAt(tokens, offset, text, options.path, options.checkout, program, sourceKind === '.8bx', machine);
}

/** The completion item for one of the program's own symbols. */
function symbolItem(module, sym) {
  const kind = sym.kind === SymbolKind.Import ? (sym.target?.kind ?? SymbolKind.Import) : sym.kind;
  return {
    label: sym.name,
    kind: SYMBOL_ITEM_KIND[kind] ?? 'variable',
    sortRank: 0,
    detail: kind === SymbolKind.Import ? `imported from ${sym.source}` : kind.toLowerCase(),
    documentation: symbolMarkdown(module, sym) ?? '',
  };
}

const SYMBOL_ITEM_KIND = {
  [SymbolKind.Function]: 'function',
  [SymbolKind.Component]: 'component',
  [SymbolKind.Constant]: 'constant',
  [SymbolKind.Namespace]: 'namespace',
  [SymbolKind.Variable]: 'variable',
  [SymbolKind.Parameter]: 'variable',
  [SymbolKind.State]: 'variable',
  [SymbolKind.Import]: 'variable',
};

/**
 * Completion inside 8BX syntax, or null when `offset` is not in any:
 * after `<` (or on the name being typed there) the components visible
 * from here and `slot`; after `</` the innermost element still open;
 * after a tag's name, the props it takes that are not yet given. Inside
 * a `{ … }` in a tag, ordinary completion applies.
 */
function bxCompletions(tokens, offset, text, program) {
  const position = bxPosition(tokens, offset);
  let { tag } = position;
  // A `<` with nothing after it yet is not a tag to the lexer (it opens
  // one only before a name, `/` or `>`); where an operand does not
  // precede it, it is a tag being started.
  if (!tag) {
    const before = tokens.filter((t) => t.kind !== TokenKind.Comment && t.start < offset);
    const last = before.at(-1);
    if (last?.kind === TokenKind.Operator && last.text === '<' && last.start + 1 === offset && !isOperandToken(before.at(-2))) {
      tag = { name: null, closing: false, nameDone: false };
    }
  }
  if (!tag || position.inExpression) return null;
  if (tag.closing) {
    const name = position.open.at(-1);
    return name ? [{ label: `</${name}>`, kind: 'component', sortRank: 0, insertText: `${name}>`, detail: 'closes the open element', documentation: '' }] : [];
  }
  const module = program();
  if (!tag.nameDone) {
    const scope = scopeAt(module, offset);
    const items = visibleSymbols(scope)
      .filter((sym) => sym.kind === SymbolKind.Component || (sym.kind === SymbolKind.Import && sym.component))
      .map((sym) => symbolItem(module, sym));
    items.push({ label: 'slot', kind: 'component', sortRank: 1, detail: 'where the children go', documentation: 'The element\'s children are composed where `<slot />` stands (8BX spec §33).' });
    return items;
  }
  const scope = scopeAt(module, tag.name.start);
  const sym = visibleSymbols(scope).find((s) => s.name === tag.name.text);
  if (!sym) return [];
  // The props already written anywhere in this tag, either side of the cursor.
  const given = new Set();
  let depth = 0;
  for (let i = tokens.indexOf(tag.name) + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (depth === 0 && (t.kind === TokenKind.BxTagEnd || t.kind === TokenKind.BxSelfClose)) break;
    if (t.text === '{') depth += 1;
    else if (t.text === '}') depth -= 1;
    else if (depth === 0 && t.kind === TokenKind.Identifier && tokens[i + 1]?.text === '=') given.add(t.text);
  }
  return propsOf(module, sym).filter((p) => !given.has(p.name)).map((p) => ({
    label: p.name,
    kind: 'variable',
    sortRank: p.optional ? 1 : 0,
    detail: `${p.name}${p.optional ? '?' : ''}: ${p.type ?? '?'}`,
    documentation: `A prop of \`${sym.name}\`${p.optional ? ', optional' : ''}.`,
    insertText: p.type === 'string' ? `${p.name}="$1"` : `${p.name}={$1}`,
    snippet: true,
  }));
}

function completionsAt(tokens, offset, text, filePath, checkout, program, bx = false, machine = { machine: null, why: null }) {
  const index = tokenIndexAt(tokens, offset);
  const token = tokens[index];
  if (token?.kind === TokenKind.Template) {
    const field = token.parts.find((p) => p.kind === 'field'
      && offset >= p.sourceStart && offset <= p.sourceEnd);
    if (!field) return [];
    const inner = tokenize(text.slice(field.sourceStart, field.sourceEnd)).tokens;
    for (const t of inner) t.start += field.sourceStart;
    return completionsAt(inner, offset, text, filePath, checkout, program);
  }
  if (token?.kind === TokenKind.Comment || token?.kind === TokenKind.String) return [];

  const inTag = bx ? bxCompletions(tokens, offset, text, program) : null;
  if (inTag) return inTag;

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
    const namespace = importedNamespace(tokens, object, filePath, checkout, machine.machine);
    if (!namespace) return [];
    const context = { ...namespace.context, machineWhy: machine.why };
    const all = context.portable?.machines ?? [];
    return [...namespace.members.values()].map((member) => ({
      label: member.name,
      kind: member.kind,
      sortRank: 0,
      detail: all.length > 0 && member.machines.length < all.length
        ? `${object}.${member.signature} — ${member.machines.join(', ')} only`
        : `${object}.${member.signature}`,
      documentation: memberMarkdown(object, member, context),
    }));
  }

  if (!isTypePosition(tokens, offset)) {
    // Anywhere else an expression could go: the program's own names.
    const module = program();
    return visibleSymbols(scopeAt(module, offset)).map((sym) => symbolItem(module, sym));
  }

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
