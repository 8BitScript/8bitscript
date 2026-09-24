// Built-in hover and completion — see packages/compiler/src/intellisense.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getHoverInfo, getCompletions } from '../index.mjs';

const at = (text, needle) => text.indexOf(needle) + Math.floor(needle.length / 2);

// Same pattern test/subpaths.test.mjs uses: a throwaway node_modules layout,
// so member hover/completion's import resolution is exercised against a
// real filesystem rather than a mock, without depending on this monorepo's
// own installed packages staying in any particular shape.
const withFiles = (files, fn) => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-intellisense-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), typeof text === 'string' ? text : JSON.stringify(text));
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ---- hover ----------------------------------------------------------------

test('hover on a canonical integer type explains size, range, and alias', () => {
  const text = 'let x: utinyint = 3;';
  const info = getHoverInfo(text, at(text, 'utinyint'));
  assert.ok(info);
  assert.match(info.markdown, /Unsigned 1-byte integer/);
  assert.match(info.markdown, /Size: 1 byte \/ 8 bits/);
  assert.match(info.markdown, /0 through 255/);
  assert.match(info.markdown, /Low-level alias: u8/);
});

test('hover on a signed 3-byte type formats large numbers with separators', () => {
  const text = 'let x: mediumint = 3;';
  const info = getHoverInfo(text, at(text, 'mediumint'));
  assert.match(info.markdown, /Signed 3-byte integer/);
  assert.match(info.markdown, /Size: 3 bytes \/ 24 bits/);
  assert.match(info.markdown, /-8,388,608 through 8,388,607/);
  assert.match(info.markdown, /Low-level alias: i24/);
});

test('hover on int/uint shows the 4-byte type they now name', () => {
  let text = 'let x: int = 3;';
  let info = getHoverInfo(text, at(text, 'int'));
  assert.match(info.markdown, /Signed 4-byte integer/);
  assert.match(info.markdown, /-2,147,483,648 through 2,147,483,647/);
  assert.match(info.markdown, /Low-level alias: i32/);

  text = 'let x: uint = 3;';
  info = getHoverInfo(text, at(text, 'uint'));
  assert.match(info.markdown, /Unsigned 4-byte integer/);
  assert.match(info.markdown, /0 through 4,294,967,295/);
  assert.match(info.markdown, /Low-level alias: u32/);
});

test('hover on a legacy alias points back to the canonical name', () => {
  const text = 'let x: u8 = 3;';
  const info = getHoverInfo(text, at(text, 'u8'));
  assert.match(info.markdown, /Low-level alias for utinyint/);
  assert.match(info.markdown, /Unsigned 1-byte integer/);
  assert.match(info.markdown, /0 through 255/);
});

test('every canonical and legacy-alias spelling has hover', () => {
  const names = [
    'tinyint', 'utinyint', 'smallint', 'usmallint',
    'mediumint', 'umediumint', 'int', 'uint',
    'i8', 'u8', 'i16', 'u16', 'i24', 'u24', 'i32', 'u32',
  ];
  for (const name of names) {
    const text = `let x: ${name} = 0;`;
    const info = getHoverInfo(text, at(text, name));
    assert.ok(info, `expected hover for ${name}`);
    assert.match(info.markdown, new RegExp(name));
  }
});

test('hover explains volatile in 8BitScript terms, not C terms', () => {
  const text = '@address(0x900F)\nlet vicColor: volatile<u8>;';
  const info = getHoverInfo(text, at(text, 'volatile'));
  assert.match(info.markdown, /may change outside normal program execution/);
  assert.match(info.markdown, /memory-mapped hardware registers/);
  assert.doesNotMatch(info.markdown, /\bC\b/);
});

test('hover explains ptr and array', () => {
  let text = 'let cursor: ptr<u8>;';
  assert.match(getHoverInfo(text, at(text, 'ptr')).markdown, /pointer to a memory location/i);

  text = 'let buffer: array<u8, 16>;';
  assert.match(getHoverInfo(text, at(text, 'array')).markdown, /fixed-size array of N values/i);
});

test('hover explains asm6502', () => {
  const text = 'asm6502 {\n    lda #$06\n}\n';
  const info = getHoverInfo(text, at(text, 'asm6502'));
  assert.match(info.markdown, /raw 6502 assembly/);
  assert.match(info.markdown, /parameters or locals: it is that slot's zero-page address/);
});

test('hover explains @address', () => {
  const text = '@address(0x900F)\nlet vicColor: volatile<u8>;';
  const info = getHoverInfo(text, text.indexOf('@address') + 3);
  assert.match(info.markdown, /Binds a declaration to a specific memory address/);
});

test('hover explains memory.write and memory.read', () => {
  let text = 'export function f(): void { memory.write(36879, 27); }';
  let info = getHoverInfo(text, at(text, 'write'));
  assert.match(info.markdown, /Writes one byte directly/);
  assert.match(info.markdown, /POKE/);

  text = 'export function f(): void { let x: utinyint = memory.read(36879); }';
  info = getHoverInfo(text, at(text, 'read'));
  assert.match(info.markdown, /Reads one byte directly/);
  assert.match(info.markdown, /PEEK/);
});

test('hover explains port.write and port.read', () => {
  let text = 'export function f(): void { port.write(0xFE, 0); }';
  let info = getHoverInfo(text, at(text, 'write'));
  assert.match(info.markdown, /port.write/);
  assert.match(info.markdown, /OUT/);

  text = 'export function f(): void { let x: utinyint = port.read(0xFE); }';
  info = getHoverInfo(text, at(text, 'read'));
  assert.match(info.markdown, /port.read/);
  assert.match(info.markdown, /IN/);
});

test('hover does not fire on read/write unless qualified by memory.', () => {
  const text = 'export function f(): void { let write: utinyint = 0; }';
  // The program's own `write` is a variable, and hovers as one — not as the intrinsic.
  const info = getHoverInfo(text, at(text, 'write'));
  assert.match(info.markdown, /\*\*write\*\* — variable/);
  assert.doesNotMatch(info.markdown, /POKE/);
});

test('hover explains #frames(...)', () => {
  const text = 'let x: utinyint = #frames(0.5, seconds);';
  const info = getHoverInfo(text, at(text, 'frames'));
  assert.ok(info);
  assert.match(info.markdown, /Compile-time duration/);
  assert.match(info.markdown, /#frames\(0\.5, seconds\)/);
  assert.match(info.markdown, /frameRate/);
  assert.match(info.markdown, /8bitscript\.config\.ts/);
  assert.match(info.markdown, /Nothing is reserved/);
});

test('hover explains #package("version")', () => {
  const text = 'const VERSION: string = #package("version");';
  const info = getHoverInfo(text, at(text, 'package'));
  assert.ok(info);
  assert.match(info.markdown, /\*\*#package\("version"\)\*\*/);
  assert.match(info.markdown, /package\.json/);
  assert.match(info.markdown, /"name"/);
  assert.match(info.markdown, /8BS1041/);
  assert.match(info.markdown, /8BS1042/);
});

test('hover on frames does not require a valid call — helps a reader mid-edit too', () => {
  const text = 'let x: utinyint = #frames();';
  const info = getHoverInfo(text, at(text, 'frames'));
  assert.ok(info);
  assert.match(info.markdown, /Compile-time duration/);
});

test('hover on a name the program does not declare returns nothing', () => {
  const text = 'let myCounter: u8 = other;';
  assert.equal(getHoverInfo(text, at(text, 'other')), null);
});

test('hover on whitespace returns nothing', () => {
  // The blank line between the two statements touches no token at all.
  const text = 'let x: u8 = 0;\n\nlet y: u8 = 0;';
  const blankLineOffset = text.indexOf('\n\n') + 1;
  assert.equal(getHoverInfo(text, blankLineOffset), null);
});

// ---- completion -------------------------------------------------------

test('completion after a type colon offers canonical names in MySQL order, ahead of aliases', () => {
  const text = 'let x: ';
  const items = getCompletions(text, text.length);
  const labels = items.map((i) => i.label);

  const canonicalOrder = [
    'tinyint', 'utinyint', 'smallint', 'usmallint',
    'mediumint', 'umediumint', 'int', 'uint',
  ];
  for (const name of canonicalOrder) assert.ok(labels.includes(name), `missing ${name}`);
  assert.deepEqual(
    labels.filter((l) => canonicalOrder.includes(l)),
    canonicalOrder,
    'canonical types must be offered in tinyint/utinyint/.../int/uint order',
  );

  for (const name of ['array', 'ptr', 'volatile']) {
    assert.ok(labels.includes(name), `missing ${name}`);
  }

  const utinyintRank = items.find((i) => i.label === 'utinyint').sortRank;
  const u8Rank = items.find((i) => i.label === 'u8').sortRank;
  assert.ok(utinyintRank < u8Rank, 'canonical names must rank ahead of legacy aliases');
});

test('completion inside a type constructor argument also offers types', () => {
  const text = 'let p: ptr<';
  const items = getCompletions(text, text.length);
  assert.ok(items.some((i) => i.label === 'utinyint'));
});

test('completion outside a type position offers the program\'s own names, not the types', () => {
  const text = 'const LIMIT: utinyint = 4;\nlet x = ';
  assert.deepEqual(getCompletions(text, text.length).map((i) => i.label), ['LIMIT', 'x']);

  const compare = 'const LIMIT: utinyint = 4;\nif (x < ';
  assert.deepEqual(getCompletions(compare, compare.length).map((i) => i.label), ['LIMIT']);
});

// ---- completion beyond type names ------------------------------------------

test('completion after a # offers the compile-time functions, inserting without a second #', () => {
  const typed = 'let x: utinyint = #';
  const items = getCompletions(typed, typed.length);
  assert.deepEqual(items.map((i) => i.label), ['#frames', '#system', '#fact', '#package']);
  const [item] = items;
  assert.equal(item.label, '#frames');
  assert.equal(item.kind, 'function');
  assert.equal(item.insertText, 'frames', 'the # is already in the buffer');
  assert.match(item.documentation, /\*\*#frames\(n, unit\)\*\*/);

  // Mid-word, the whole #name token is what gets replaced, so no insertText.
  const partial = 'let x: utinyint = #fra';
  assert.equal(getCompletions(partial, partial.length)[0].insertText, undefined);
});

test('completion in the unit slot offers the units, and nothing elsewhere in the call', () => {
  const unit = 'let x: utinyint = #frames(0.5, ';
  assert.deepEqual(getCompletions(unit, unit.length).map((i) => i.label), ['seconds']);
  assert.equal(getCompletions(unit, unit.length)[0].kind, 'constant');
  const literal = 'let x: utinyint = #frames(';
  assert.deepEqual(getCompletions(literal, literal.length).map((i) => i.label), ['x'], 'a program\'s own const could stand there; no unit yet');
});

test('completion inside a ${...} field answers as it would outside one', () => {
  const field = 'text.print(0, `T ${#';
  assert.deepEqual(getCompletions(field, field.length).map((i) => i.label), ['#frames', '#system', '#fact', '#package']);
  const unit = 'text.print(0, `T ${#frames(0.5, ';
  assert.deepEqual(getCompletions(unit, unit.length).map((i) => i.label), ['seconds']);
  const text = 'text.print(0, `T ';
  assert.deepEqual(getCompletions(text, text.length), [], 'template text is not a completion position');
});

test('every completion item says what kind of thing it is', () => {
  const types = 'let x: ';
  assert.ok(getCompletions(types, types.length).every((i) => i.kind === 'type'));
});

// ---- member hover/completion for a named import's own namespace -----------
//
// `screen.blank(...)` hover and `screen.bl|` completion: reading what a
// named import actually exports, one hop through the module it resolves to.
// See intellisense/index.mjs's importedNamespace and scanModule.

const REGISTERS = [
  'export namespace Registers {',
  '    // The border color register.',
  '    const BORDER: u16 = 53280;',
  '',
  '    // Not attached to BACKGROUND below: a blank line separates them.',
  '',
  '    const BACKGROUND: u16 = 53281; // one screen, one border',
  '',
  '    /**',
  '     * Blanks the screen.',
  '     * `border`/`background` default to black.',
  '     */',
  '    function blank(border: u8 = 0, background: u8 = 0): void {',
  '        const local: u16 = 1;',
  '    }',
  '}',
].join('\n');

test('hover on a relative import member shows its signature and doc, unconditionally', () => {
  withFiles({ 'registers.8bs': REGISTERS }, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { Registers } from "./registers.8bs";\nRegisters.blank();\n';
    const info = getHoverInfo(text, at(text, 'blank'), { path: file });
    assert.ok(info);
    assert.match(info.markdown, /\*\*Registers\.blank\(border: u8 = 0, background: u8 = 0\): void\*\*/);
    assert.match(info.markdown, /Blanks the screen\. `border`\/`background` default to black\./);
    assert.ok(!info.markdown.includes('Shown as implemented for'), 'a relative import resolves to one file, not a target-conditional one');
  });
});

test('hover on a member const shows its type and value, from a trailing same-line comment', () => {
  withFiles({ 'registers.8bs': REGISTERS }, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { Registers } from "./registers.8bs";\nlet x: u16 = Registers.BACKGROUND;\n';
    const info = getHoverInfo(text, at(text, 'BACKGROUND'), { path: file });
    assert.match(info.markdown, /\*\*Registers\.BACKGROUND: u16\*\* = 53281/);
    assert.match(info.markdown, /one screen, one border/);
  });
});

test('a leading comment separated from its declaration by a blank line does not attach', () => {
  withFiles({ 'registers.8bs': REGISTERS }, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { Registers } from "./registers.8bs";\nlet x: u16 = Registers.BACKGROUND;\n';
    const info = getHoverInfo(text, at(text, 'BACKGROUND'), { path: file });
    assert.ok(!info.markdown.includes('Not attached'), 'the comment above BORDER, not BACKGROUND, must not leak in');
  });
});

test('a local declared inside a member function is not itself offered as a member', () => {
  withFiles({ 'registers.8bs': REGISTERS }, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { Registers } from "./registers.8bs";\nRegisters.';
    const labels = getCompletions(text, text.length, { path: file }).map((i) => i.label);
    assert.deepEqual(labels.sort(), ['BACKGROUND', 'BORDER', 'blank']);
  });
});

test('completion after object. offers every member, function and constant alike', () => {
  withFiles({ 'registers.8bs': REGISTERS }, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { Registers } from "./registers.8bs";\nRegisters.bl';
    const items = getCompletions(text, text.length, { path: file });
    const blank = items.find((i) => i.label === 'blank');
    assert.equal(blank.kind, 'function');
    assert.match(blank.detail, /^Registers\.blank\(/);
    const border = items.find((i) => i.label === 'BORDER');
    assert.equal(border.kind, 'constant');
  });
});

test('a renamed import (`as`) is still reached by its local name', () => {
  withFiles({ 'registers.8bs': REGISTERS }, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { Registers as regs } from "./registers.8bs";\nregs.';
    const labels = getCompletions(text, text.length, { path: file }).map((i) => i.label);
    assert.ok(labels.includes('blank'));
  });
});

// A machine-conditional package, the shape every hardware API
// (@8bitscript/screen, @8bitscript/text, ...) actually has: one entry per
// machine, each machine's own file. Hover and completion read *every*
// machine's file and show the API they agree on — a program is written
// for nine machines at once, and the editor must not quietly pick one.
// See intellisense/index.mjs's importedNamespace and mergeNamespace.
const PORTABLE_DOC = '// Blanks the screen: every cell, both colors.';
const CONDITIONAL_PACKAGE = {
  'node_modules/@t/hw/package.json': {
    name: '@t/hw',
    '8bitscript': { entry: { pet: './src/pet.8bs', c64: './src/c64.8bs', web: './src/web.8bs' } },
  },
  'node_modules/@t/hw/src/pet.8bs': [
    'export namespace screen {',
    `    ${PORTABLE_DOC}`,
    '    function blank(): void {}',
    '    // Deliberately empty on the PET: there is no cursor to hand back.',
    '    function releaseCursor(): void {}',
    '}',
  ].join('\n'),
  'node_modules/@t/hw/src/c64.8bs': [
    'export namespace screen {',
    `    ${PORTABLE_DOC}`,
    '    function blank(): void {}',
    '    // Banks the KERNAL back in and tells its editor where the cursor is.',
    '    function releaseCursor(): void {}',
    '    // The raster line the border starts on.',
    '    const TOP: utinyint = 50;',
    '    function scroll(x: utinyint): void {}',
    '}',
  ].join('\n'),
  'node_modules/@t/hw/src/web.8bs': [
    'export namespace screen {',
    `    ${PORTABLE_DOC}`,
    '    function blank(): void {}',
    '    // Nothing to release: the page has no BASIC prompt to return to.',
    '    function releaseCursor(): void {}',
    '    const TOP: utinyint = 0;',
    '    function scroll(x: usmallint): void {}',
    '    // True while the page has marked this host as a touchscreen.',
    '    function touch(): bool { return false; }',
    '}',
  ].join('\n'),
};

test('a member every machine has, documented the same everywhere, is shown plainly — no machine named', () => {
  withFiles(CONDITIONAL_PACKAGE, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { screen } from "@t/hw";\nscreen.blank();\n';
    const info = getHoverInfo(text, at(text, 'blank'), { path: file });
    assert.match(info.markdown, /^\*\*screen\.blank\(\): void\*\*/);
    assert.match(info.markdown, /Blanks the screen: every cell, both colors\./);
    assert.ok(!info.markdown.includes('Shown as implemented'), 'the old one-machine footer is gone');
    assert.ok(!info.markdown.includes('Available on'), 'a portable member lists no machines');
    assert.ok(!info.markdown.includes('On pet'), 'a shared doc is the contract, not one machine\'s note');
    assert.match(info.markdown, /Go to Definition opens c64's module \(the first machine that has it\)\./, 'c64 precedes pet and web in `8bs targets` order');
  });
});

test('a member only some machines have says which, in `8bs targets` order', () => {
  withFiles(CONDITIONAL_PACKAGE, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { screen } from "@t/hw";\nlet t: utinyint = screen.TOP;\n';
    const info = getHoverInfo(text, at(text, 'TOP'), { path: file });
    assert.match(info.markdown, /^\*\*screen\.TOP: utinyint\*\* = 50/, 'the value most machines share; c64 ties web and comes first');
    assert.match(info.markdown, /Available on c64 and web; not on pet\./);
    assert.ok(!info.markdown.includes('Not on'), 'no machine singled out without a file or project machine');
  });
});

test('a member missing on the machine this file is a twin for is called out, and the jump goes where it exists', () => {
  withFiles(CONDITIONAL_PACKAGE, (dir) => {
    const file = join(dir, 'main.pet.8bs');
    const text = 'import { screen } from "@t/hw";\nif (screen.touch()) {}\n';
    const info = getHoverInfo(text, at(text, 'touch'), { path: file });
    assert.match(info.markdown, /\*\*Not on pet\*\* — this file's machine\./);
    assert.match(info.markdown, /Available on web; not on c64 and pet\./);
    assert.match(info.markdown, /Go to Definition opens web's module \(the first machine that has it\)\./);
  });
});

test('a member hover inside a ${...} field still resolves the import and knows the file\'s own machine, the same as outside one', () => {
  withFiles(CONDITIONAL_PACKAGE, (dir) => {
    const file = join(dir, 'main.pet.8bs');
    const text = 'import { screen } from "@t/hw";\nconst s: string = `${screen.touch()}`;\n';
    const info = getHoverInfo(text, at(text, 'touch'), { path: file });
    assert.ok(info, 're-lexing the field must not lose the outer file\'s import statements');
    assert.match(info.markdown, /\*\*Not on pet\*\* — this file's machine\./, 'the machine must pass through the recursive re-lex too, not fall back to "no machine known"');
    assert.match(info.markdown, /Available on web; not on c64 and pet\./);
  });
});

test('member completion inside a ${...} field also resolves the import', () => {
  withFiles(CONDITIONAL_PACKAGE, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { screen } from "@t/hw";\nconst s: string = `${screen.}`;\n';
    const items = getCompletions(text, text.indexOf('${screen.') + '${screen.'.length, { path: file });
    assert.ok(items.some((i) => i.label === 'blank'), 're-lexing the field must not lose the outer file\'s import statements');
  });
});

test('the project\'s single target is the machine the import is read for', () => {
  withFiles(CONDITIONAL_PACKAGE, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { screen } from "@t/hw";\nscreen.releaseCursor();\n';
    const info = getHoverInfo(text, at(text, 'releaseCursor'), { path: file, machine: 'web' });
    assert.match(info.markdown, /On web: Nothing to release/, 'every machine documents it differently: the project\'s machine\'s note is shown, and labelled');
    assert.match(info.markdown, /Each machine documents this in its own words — 2 more in the machines' modules\./);
    assert.match(info.markdown, /Go to Definition opens web's module \(this project's target\)\./);
  });
});

test('a signature one machine disagrees on shows the portable one and names the dissenter', () => {
  withFiles(CONDITIONAL_PACKAGE, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { screen } from "@t/hw";\nscreen.scroll(1);\n';
    const info = getHoverInfo(text, at(text, 'scroll'), { path: file });
    assert.match(info.markdown, /^\*\*screen\.scroll\(x: utinyint\): void\*\*/, 'c64\'s, the first in order of a tie');
    assert.match(info.markdown, /On web: `screen\.scroll\(x: usmallint\): void`/);
  });
});

test('completion after object. lists the merged members, a subset member annotated with its machines', () => {
  withFiles(CONDITIONAL_PACKAGE, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { screen } from "@t/hw";\nscreen.';
    const items = getCompletions(text, text.length, { path: file });
    assert.deepEqual(items.map((i) => i.label).sort(), ['TOP', 'blank', 'releaseCursor', 'scroll', 'touch']);
    assert.equal(items.find((i) => i.label === 'blank').detail, 'screen.blank(): void');
    assert.equal(items.find((i) => i.label === 'touch').detail, 'screen.touch(): bool — web only');
    assert.match(items.find((i) => i.label === 'TOP').documentation, /Available on c64 and web; not on pet\./);
  });
});

const WEB_ONLY_PACKAGE = {
  'node_modules/@t/hw2/package.json': {
    name: '@t/hw2',
    '8bitscript': { entry: { web: './src/web.8bs' } },
  },
  'node_modules/@t/hw2/src/web.8bs': 'export namespace screen {\n    // Web only.\n    function blank(): void {}\n}\n',
};

test('a package with one machine is that machine\'s API, and says nothing about the others', () => {
  withFiles(WEB_ONLY_PACKAGE, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'import { screen } from "@t/hw2";\nscreen.blank();\n';
    const info = getHoverInfo(text, at(text, 'blank'), { path: file });
    assert.match(info.markdown, /Web only\./);
    assert.ok(!info.markdown.includes('Available on'), 'every machine the package has, has it');
    assert.match(info.markdown, /Go to Definition opens web's module/);
  });
});

test('member hover/completion is unavailable without a file path', () => {
  const text = 'import { Registers } from "./registers.8bs";\nRegisters.blank();\n';
  assert.equal(getHoverInfo(text, at(text, 'blank')), null);
  assert.deepEqual(getCompletions(`${text}Registers.`, `${text}Registers.`.length), []);
});

test('hover and completion stay empty for a name that is not a known import', () => {
  withFiles({ 'registers.8bs': REGISTERS }, (dir) => {
    const file = join(dir, 'main.8bs');
    const text = 'let screen: u8 = 0;\nscreen.foo();\n';
    assert.equal(getHoverInfo(text, at(text, 'foo'), { path: file }), null);
    assert.deepEqual(getCompletions('screen.', 'screen.'.length, { path: file }), []);
  });
});

test('member completion does not hijack a #fact(...) key position', () => {
  const text = 'const n: uint = #fact(video.';
  const labels = getCompletions(text, text.length, { path: null }).map((i) => i.label);
  assert.ok(labels.includes('video.columns'));
  assert.ok(!labels.some((l) => l === 'blank'));
});
