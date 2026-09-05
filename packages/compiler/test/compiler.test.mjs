// The compiler's regression suite, run with `pnpm test` (node --test).
//
// Most cases here are bugs that actually shipped, kept so they cannot ship
// twice. When a fix lands, its reproduction lands here in the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { analyze, tokenize, parse, NodeType } from '../index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELLO_VIC = join(HERE, '..', '..', '..', 'examples', 'hello-vic', 'src');

const codes = (src, file, options) => analyze(src, file ?? 't.8bs', options).map((d) => d.code);
const clean = (src) => assert.deepEqual(codes(src), []);

// ---- lexer ----------------------------------------------------------------

test('milestone program is clean', () => {
  clean('let x: u8 = 10;\n\nfunction main(): void {\n    x = x + 1;\n}\n');
});

test('numeric literal spellings', () => {
  clean('let a: u8 = 255;');
  clean('let b: u8 = 0xFF;');
  clean('let c: u8 = $FF;');
  clean('let d: u8 = 0b11111111;');
  clean('let e: u8 = %11111111;');
});

test('shipped bug: modulo is not a binary literal', () => {
  clean('function f(): void { let y: u8 = x%2; }');
  clean('function f(): void { let y: u8 = a%b; }');
  clean('function f(): void { x %= 2; }');
  // In value position, % still reads as binary.
  const { tokens } = tokenize('let x: u8 = %101;', 't');
  const literal = tokens.find((t) => t.kind === 'number');
  assert.equal(literal.value, 5);
});

test('shipped bug: no token may carry NaN', () => {
  for (const src of ['let y: u8 = x%2;', 'let z: u8 = 0x;', 'a%b;']) {
    for (const t of tokenize(src, 't').tokens) {
      assert.ok(!Number.isNaN(t.value), `NaN token in ${src}: '${t.text}'`);
    }
  }
});

test('shipped bug: operators lex by maximal munch, not greed', () => {
  clean('function f(): void { x=-1; }');
  clean('function f(): void { let y: bool = a<-1; }');
  clean('function f(): void { x <<= 1; }');
});

test('empty radix prefix is an invalid literal, not silence', () => {
  assert.deepEqual(codes('let x: u8 = 0x;'), ['8BS1008']);
});

test('shipped bug: asm6502 bodies are opaque', () => {
  clean('asm6502 {\n    lda #$06\n    sta $900f\n}\n');
  assert.deepEqual(codes('asm6502 {\n lda #$06\n'), ['8BS1007']);
});

test('unterminated constructs each have one code', () => {
  assert.deepEqual(codes('let s = "abc;'), ['8BS1002']);
  assert.deepEqual(codes('/* never closed'), ['8BS1006']);
  assert.deepEqual(codes('function f(): void {'), ['8BS1005', '8BS1101']);
});

// ---- parser ---------------------------------------------------------------

test('milestone AST has the specified shape', () => {
  const src = 'let x: u8 = 10;';
  const { ast, diagnostics } = parse(tokenize(src, 't').tokens, src, 't');
  assert.equal(diagnostics.length, 0);
  const d = ast.body[0];
  assert.equal(d.type, NodeType.VariableDeclaration);
  assert.equal(d.name.name, 'x');
  assert.equal(d.typeAnnotation.name, 'u8');
  assert.equal(d.initializer.type, NodeType.IntegerLiteral);
  assert.equal(d.initializer.value, 10);
});

test('full specified surface parses clean', () => {
  clean(`
@address(0x900F)
let vicColor: volatile<u8>;
let buffer: array<u8, 16>;
let cursor: ptr<u8>;
export function update(): void {
    if (input.left()) { cursor--; } else { cursor++; }
    for (let i: u8 = 0; i < 16; i++) { screen.putChar(i, 10, buffer[i]); }
    while (true) { break; }
    asm6502 { lda #$06 }
    return;
}
`);
});

test('import aliasing', () => {
  const src = 'import { putChar as put } from "x";';
  const { ast } = parse(tokenize(src, 't').tokens, src, 't');
  const spec = ast.body[0].specifiers[0];
  assert.equal(spec.imported, 'putChar');
  assert.equal(spec.name, 'put');
});

test('error recovery reports every mistake, then keeps checking', () => {
  const src = 'let a: u8 = ;\nfunction ():  {\nlet b: u8 = 5;\nlet c: u16 = 70000;\n';
  const found = codes(src);
  assert.ok(found.filter((c) => c === '8BS1101').length >= 3, `got ${found}`);
  assert.ok(found.includes('8BS1021'), 'range check must survive earlier syntax errors');
});

test('unspecified syntax is an honest error', () => {
  assert.ok(codes('switch (x) { case 1: break; }').includes('8BS1101'));
});

// ---- checker --------------------------------------------------------------

test('frozen behaviour: 8BS1021 message and span', () => {
  const d = analyze('let score: u8 = 300;', 't.8bs');
  assert.equal(d.length, 1);
  assert.equal(d[0].code, '8BS1021');
  assert.equal(d[0].message, '300 does not fit in u8 (0..255)');
  assert.equal(d[0].start, 16);
  assert.equal(d[0].length, 3);
});

test('negated literals use the full span', () => {
  const d = analyze('let t: i8 = -200;', 't.8bs');
  assert.equal(d[0].message, '-200 does not fit in i8 (-128..127)');
  assert.equal(d[0].start, 12);
  assert.equal(d[0].length, 4);
});

test('the rule reaches nested declarations now', () => {
  assert.deepEqual(codes('function f(): void { let x: u8 = 300; }'), ['8BS1021']);
  assert.deepEqual(codes('function f(): void { for (let i: u8 = 300; ; ) {} }'), ['8BS1021']);
});

test('expressions are not folded yet', () => {
  clean('let x: u8 = 200 + 100;');
});

test('type constructors are not integers', () => {
  clean('let p: ptr<u8>;');
  clean('let a: array<u8, 300>;');
});

// ---- resolver (uses the real example project as its fixture) --------------

test('workspace imports resolve through pnpm links', () => {
  const file = join(HELLO_VIC, 'main.8bs');
  // hello-vic depends on @8bitscript/text and @8bitscript/vic20 with
  // workspace:*; a target package's own subpath resolves the same way.
  const src = 'import { text } from "@8bitscript/text";\nimport { vic } from "@8bitscript/vic20";\nimport { screen } from "@8bitscript/vic20/screen";\n';
  assert.deepEqual(codes(src, file, { resolveImports: true }), []);
});

test('each resolution failure has its own code', () => {
  const file = join(HELLO_VIC, 'main.8bs');
  const src = [
    'import { a } from "@8bitscript/nonexistent";',
    'import { b } from "markdown-it";',
    'import { c } from "./missing.8bs";',
  ].join('\n');
  assert.deepEqual(codes(src, file, { resolveImports: true }),
    ['8BS2001', '8BS2002', '8BS2004']);
});

test('resolution is off without a real path', () => {
  assert.deepEqual(codes('import { a } from "@8bitscript/nonexistent";', 't.8bs',
    { resolveImports: true }), []);
});

// ---- lowering -------------------------------------------------------------

import { lower } from '../index.mjs';

const lowered = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't');
};

test('milestone program lowers cleanly', () => {
  const { ir, diagnostics } = lowered('let x: u8 = 10;\nexport function main(): void { x = x + 1; }');
  assert.equal(diagnostics.length, 0);
  // `u8` is a low-level alias; the IR stores the canonical name it resolves to.
  assert.deepEqual(ir.globals[0], {
    name: 'x', type: 'utinyint', volatile: false, address: null, init: 10, exported: false,
    start: 4, length: 1, // the name's span, for the linker's entry-export rule
  });
  assert.equal(ir.functions[0].name, 'main');
  assert.equal(ir.functions[0].body[0].kind, 'assign');
});

test('@address + volatile lowers to a hardware global', () => {
  const { ir, diagnostics } = lowered('@address(0x900F)\nlet vicColor: volatile<u8>;');
  assert.equal(diagnostics.length, 0);
  assert.equal(ir.globals[0].address, 0x900f);
  assert.equal(ir.globals[0].volatile, true);
});

test('lowering is exhaustive-with-error, never silent', () => {
  // Every unsupported construct must produce 8BS3001, not vanish. Calls with
  // arguments, calls used as expressions, and a single level of namespace-
  // qualified call/value access are no longer on this list — functions can
  // take parameters and return values now, and `a.b(...)`/`a.b` are deferred
  // to the linker as a possible namespace reference — so these are
  // constructs that stay unsupported: calling a call result, a two-level
  // qualified call, a two-level qualified value, assigning through member
  // access, and local variables.
  for (const src of [
    'export function f(): void { g()(); }',
    'export function f(): void { a.b.c(); }',
    'export function f(): void { x = g().y; }',
    'export function f(): void { a.b = 1; }',
    'function f(): void { let local: u8 = 1; }',
  ]) {
    const { diagnostics } = lowered(src);
    assert.ok(
      diagnostics.some((d) => d.code === '8BS3001'),
      `expected 8BS3001 for: ${src}`,
    );
  }
});

test('compound assignment and updates lower to plain assigns', () => {
  const { ir } = lowered('let x: u8 = 0;\nexport function f(): void { x += 2; x++; }');
  const [a, b] = ir.functions[0].body;
  assert.equal(a.value.operator, '+');
  assert.equal(b.value.right.value, 1);
});

test('a parameterless call statement lowers to a call', () => {
  const { ir, diagnostics } = lowered('export function f(): void { g(); }');
  assert.equal(diagnostics.length, 0);
  assert.equal(ir.functions[0].body[0].kind, 'call');
  assert.equal(ir.functions[0].body[0].name, 'g');
});

test('imports lower to records for the linker, not to failures', () => {
  const { ir, diagnostics } = lowered('import { limit as max } from "./lib.8bs";');
  assert.equal(diagnostics.length, 0);
  assert.deepEqual(
    ir.imports[0].specifiers.map(({ imported, local }) => ({ imported, local })),
    [{ imported: 'limit', local: 'max' }],
  );
  assert.equal(ir.imports[0].source, './lib.8bs');
});

// ---- linker (each case materialises a real module graph on disk) ----------

import { link } from '../index.mjs';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const linked = (files, entryName = 'main.8bs') => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-link-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return link(files[entryName], join(dir, entryName));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const LIB = 'export let limit: u16 = 12000;\nlet delay: u16 = 0;\nexport function tick(): void { delay = delay + 1; }\n';

test('two modules link into one program', () => {
  const { ir, diagnostics } = linked({
    'main.8bs': 'import { limit } from "./lib.8bs";\nlet count: u16 = 0;\nexport function main(): void { while (count < limit) { count = count + 1; } }',
    'lib.8bs': LIB,
  });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.globals.map((g) => g.name).sort(), ['count', 'delay', 'limit']);
  const main = ir.functions.find((f) => f.name === 'main');
  assert.equal(main.body[0].test.right.name, 'limit');
});

test('aliasing rewrites references to the exported name', () => {
  const { ir, diagnostics } = linked({
    'main.8bs': 'import { limit as max } from "./lib.8bs";\nlet count: u16 = 0;\nexport function main(): void { count = max; }',
    'lib.8bs': LIB,
  });
  assert.deepEqual(diagnostics, []);
  const main = ir.functions.find((f) => f.name === 'main');
  assert.equal(main.body[0].value.name, 'limit');
});

test('private names in different modules stay apart', () => {
  const { ir, diagnostics } = linked({
    'main.8bs': 'import { limit } from "./lib.8bs";\nlet delay: u16 = 0;\nexport function main(): void { delay = limit; }',
    'lib.8bs': LIB,
  });
  assert.deepEqual(diagnostics, []);
  // The entry loads first and keeps its names; lib's private delay moves.
  assert.deepEqual(ir.globals.map((g) => g.name).sort(), ['delay', 'delay_2', 'limit']);
  const tick = ir.functions.find((f) => f.name === 'tick');
  assert.equal(tick.body[0].target, 'delay_2');
  const main = ir.functions.find((f) => f.name === 'main');
  assert.equal(main.body[0].target, 'delay');
});

test("the entry module's main always keeps its name", () => {
  const { ir, diagnostics } = linked({
    'main.8bs': 'import { flag } from "./lib.8bs";\nexport function main(): void { flag = 1; }',
    'lib.8bs': 'export let flag: u8 = 0;\nexport function main(): void { flag = 2; }',
  });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.functions.map((f) => f.name), ['main', 'main_2']);
});

test('importing a name a module does not export is 8BS2005', () => {
  // `secret` does not exist; `delay` exists but is private. Both are 2005.
  const { ir, diagnostics } = linked({
    'main.8bs': 'import { secret, delay } from "./lib.8bs";\nexport function main(): void {}',
    'lib.8bs': LIB,
  });
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2005', '8BS2005']);
});

test('an import colliding with a local binding is 8BS2006', () => {
  const { diagnostics } = linked({
    'main.8bs': 'import { limit } from "./lib.8bs";\nlet limit: u16 = 1;\nexport function main(): void {}',
    'lib.8bs': LIB,
  });
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2006']);
});

test('a reference that resolves to nothing is 8BS2007, with a span', () => {
  const src = 'export function main(): void { count = 1; }';
  const { ir, diagnostics } = linked({ 'main.8bs': src });
  assert.equal(ir, null);
  assert.equal(diagnostics[0].code, '8BS2007');
  assert.equal(src.slice(diagnostics[0].start, diagnostics[0].start + diagnostics[0].length), 'count');
});

test('import cycles link rather than recurse', () => {
  // The cycle is between two libraries (the entry exports only its entry
  // point, so it cannot be one side of an import cycle itself).
  const { ir, diagnostics } = linked({
    'main.8bs': 'import { a } from "./a.8bs";\nexport function main(): void { a = a + 1; }',
    'a.8bs': 'import { b } from "./b.8bs";\nexport let a: u8 = 1;\nexport function take(): void { a = b; }',
    'b.8bs': 'import { a } from "./a.8bs";\nexport let b: u8 = 2;\nexport function swap(): void { b = a; }',
  });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.globals.map((g) => g.name).sort(), ['a', 'b']);
});

test('a bare import links the module in for its declarations', () => {
  const { ir, diagnostics } = linked({
    'main.8bs': 'import "./lib.8bs";\nexport function main(): void { return; }',
    'lib.8bs': LIB,
  });
  assert.deepEqual(diagnostics, []);
  assert.ok(ir.globals.some((g) => g.name === 'limit'));
});

test('imported calls rewrite across modules', () => {
  const { ir, diagnostics } = linked({
    'main.8bs': 'import { tick } from "./lib.8bs";\nexport function main(): void { tick(); }',
    'lib.8bs': LIB,
  });
  assert.deepEqual(diagnostics, []);
  const main = ir.functions.find((f) => f.name === 'main');
  assert.equal(main.body[0].kind, 'call');
  assert.equal(main.body[0].name, 'tick');
});

test('a call to a name that resolves to nothing is 8BS2007', () => {
  const { ir, diagnostics } = linked({
    'main.8bs': 'export function main(): void { launch(); }',
  });
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2007']);
});

// ---- conditional package entries (the real borders example as fixture) ----
//
// The borders example's shared entry imports @8bitscript/screen and
// @8bitscript/text, whose manifest entries are keyed by machine and
// delegate to each target package's `./screen` and `./text` subpaths —
// @8bitscript/vic20/screen, @8bitscript/c64/screen, and so on — through
// real pnpm symlinks. This group is the proof the conditional resolution
// actually switches implementations.

const BORDER_ENTRY = join(HERE, '..', '..', '..', 'examples', 'borders', 'src', 'main.8bs');

test('a conditional entry resolves to the vic20 implementation', () => {
  const { ir, diagnostics } = link(readFileSync(BORDER_ENTRY, 'utf8'), BORDER_ENTRY, { machine: 'vic20' });
  assert.deepEqual(diagnostics, []);
  assert.equal(ir.globals.find((g) => g.name === 'vicColor').address, 0x900f);
  assert.ok(ir.functions.some((f) => f.name === 'screen_setColors'));
  assert.ok(!ir.globals.some((g) => g.name === 'borderColor'));
});

test('the same entry resolves to the c64 implementation', () => {
  const { ir, diagnostics } = link(readFileSync(BORDER_ENTRY, 'utf8'), BORDER_ENTRY, { machine: 'c64' });
  assert.deepEqual(diagnostics, []);
  assert.equal(ir.globals.find((g) => g.name === 'borderColor').address, 0xd020);
  assert.ok(!ir.globals.some((g) => g.name === 'vicColor'));
});

test('the same entry resolves to the web implementation', () => {
  // main.8bs is a genuinely single file: it exports main(), and each
  // target's own text namespace (real screen memory on the VIC-20/C64, a
  // virtual character grid on the web — see @8bitscript/web's header
  // comment) gives clearScreen()/drawLabels() something to poke everywhere,
  // so the same source links clean against all three.
  const { ir, diagnostics } = link(readFileSync(BORDER_ENTRY, 'utf8'), BORDER_ENTRY, { machine: 'web' });
  assert.deepEqual(diagnostics, []);
  assert.ok(ir.functions.some((f) => f.name === 'screen_setColors'));
  assert.ok(!ir.globals.some((g) => g.name === 'vicColor' || g.name === 'borderColor'));
});

test('a machine the entry has no branch for is 8BS3002', () => {
  // Every real target (vic20, c64, pet, c128, atari8, nes, cx16, mega65,
  // web) has a branch — 'atari2600' stands in for the "not one of them"
  // case this error exists for: a real llvm-mos platform (so it's not
  // implausible), just not one @8bitscript/screen's entry map has a branch
  // for. Both imports fail the same way.
  const { ir, diagnostics } = link(readFileSync(BORDER_ENTRY, 'utf8'), BORDER_ENTRY, { machine: 'atari2600' });
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3002', '8BS3002']);
});

test('without a machine, every branch of a conditional entry is validated', () => {
  // analyze/`8bs check` resolve imports with no machine in hand: a sound
  // conditional entry is clean, not an error.
  assert.deepEqual(
    codes('import { screen } from "@8bitscript/screen";', BORDER_ENTRY, { resolveImports: true }),
    [],
  );
});

test('errors in an imported module fail the link, against the right file', () => {
  const { ir, diagnostics } = linked({
    'main.8bs': 'import { limit } from "./lib.8bs";\nexport function main(): void {}',
    'lib.8bs': 'export let limit: u8 = 300;\n',
  });
  assert.equal(ir, null);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, '8BS1021');
  assert.match(diagnostics[0].file, /lib\.8bs$/);
});

// ---- system-specific files: x.8bs and x.<machine>.8bs side by side --------
//
// The filename rule: `lib.8bs` is the portable module, and a `lib.nes.8bs`
// beside it is the NES's version of it, chosen by any build for the NES
// without the import (or anything else) having to name it. Same semantics
// as a conditional package entry, spelled in filenames instead of a
// manifest — including what happens with no machine in hand.

import { MACHINES, isVariantPath, resolveSpecifier, variantOf } from '../index.mjs';
import { mkdirSync } from 'node:fs';

const linkedFor = (files, options, entryName = 'main.8bs') => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-variant-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return link(files[entryName], join(dir, entryName), options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const withFiles = (files, fn) => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-variant-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const USES_LIMIT = 'import { limit } from "./lib.8bs";\nlet count: u16 = 0;\nexport function main(): void { count = limit; }';
const limitIn = (ir) => ir.globals.find((g) => g.name === 'limit').init;

test('variantOf and isVariantPath: the machine goes before the extension', () => {
  assert.equal(variantOf('/p/main.8bs', 'nes'), '/p/main.nes.8bs');
  assert.equal(variantOf('/p/a.b.8bs', 'c64'), '/p/a.b.c64.8bs');
  assert.ok(isVariantPath('/p/main.nes.8bs'));
  assert.ok(isVariantPath('/p/main.atari8.8bs'));
  assert.ok(!isVariantPath('/p/main.8bs'));
  assert.ok(!isVariantPath('/p/main.nes8.8bs'));
  assert.ok(MACHINES.includes('nes') && MACHINES.includes('web'));
});

test('a .<machine>.8bs twin is what that machine\'s build imports', () => {
  const files = { 'main.8bs': USES_LIMIT, 'lib.8bs': 'export let limit: u16 = 100;', 'lib.nes.8bs': 'export let limit: u16 = 7;' };
  const nes = linkedFor(files, { machine: 'nes' });
  assert.deepEqual(nes.diagnostics, []);
  assert.equal(limitIn(nes.ir), 7);
  // No c64 twin: the plain file serves, as it does for every other machine.
  const c64 = linkedFor(files, { machine: 'c64' });
  assert.deepEqual(c64.diagnostics, []);
  assert.equal(limitIn(c64.ir), 100);
  // No machine at all (8bs check, the editor): the plain file, no error.
  const none = linkedFor(files, {});
  assert.deepEqual(none.diagnostics, []);
  assert.equal(limitIn(none.ir), 100);
});

test('the entry file itself can be a machine\'s version and still import twins', () => {
  // main.nes.8bs is what `8bs build --target nes` starts from; its imports
  // follow the same rule as anyone else's.
  const files = {
    'main.nes.8bs': USES_LIMIT,
    'lib.8bs': 'export let limit: u16 = 100;',
    'lib.nes.8bs': 'export let limit: u16 = 7;',
  };
  const nes = linkedFor(files, { machine: 'nes' }, 'main.nes.8bs');
  assert.deepEqual(nes.diagnostics, []);
  assert.equal(limitIn(nes.ir), 7);
});

test('naming a machine\'s version explicitly imports exactly that file', () => {
  const files = {
    'main.8bs': 'import { limit } from "./lib.nes.8bs";\nlet count: u16 = 0;\nexport function main(): void { count = limit; }',
    'lib.8bs': 'export let limit: u16 = 100;',
    'lib.nes.8bs': 'export let limit: u16 = 7;',
  };
  const c64 = linkedFor(files, { machine: 'c64' });
  assert.deepEqual(c64.diagnostics, []);
  assert.equal(limitIn(c64.ir), 7);
});

test('a file that exists only in per-machine versions', () => {
  const files = { 'main.8bs': USES_LIMIT, 'lib.nes.8bs': 'export let limit: u16 = 7;', 'lib.c64.8bs': 'export let limit: u16 = 3;' };
  // Each machine that has one gets it.
  assert.equal(limitIn(linkedFor(files, { machine: 'nes' }).ir), 7);
  assert.equal(limitIn(linkedFor(files, { machine: 'c64' }).ir), 3);
  // A machine that has none is 8BS3002, naming the ones that do — the same
  // code a conditional package entry gives for a branch it lacks.
  const web = linkedFor(files, { machine: 'web' });
  assert.equal(web.ir, null);
  assert.deepEqual(web.diagnostics.map((d) => d.code), ['8BS3002']);
  assert.match(web.diagnostics[0].message, /no version for the web target \(targets: c64, nes\)/);
  // With no machine, the import is valid but target-dependent: clean for
  // `8bs check`, and the linker says what it needs rather than guessing.
  withFiles(files, (dir) => {
    assert.deepEqual(codes(USES_LIMIT, join(dir, 'main.8bs'), { resolveImports: true }), []);
    assert.deepEqual(resolveSpecifier('./lib.8bs', join(dir, 'main.8bs')), { path: null });
  });
  const none = linkedFor(files, {});
  assert.equal(none.ir, null);
  assert.deepEqual(none.diagnostics.map((d) => d.code), ['8BS3001']);
  assert.match(none.diagnostics[0].message, /target-specific; linking it needs a machine target/);
});

test('a file with no version at all is still 8BS2004', () => {
  const { ir, diagnostics } = linkedFor({ 'main.8bs': USES_LIMIT }, { machine: 'nes' });
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2004']);
});

test('a package\'s string entry follows the same rule', () => {
  const files = {
    'main.8bs': 'import { limit } from "@t/p";\nlet count: u16 = 0;\nexport function main(): void { count = limit; }',
    'node_modules/@t/p/package.json': JSON.stringify({ name: '@t/p', '8bitscript': { entry: './src/index.8bs' } }),
    'node_modules/@t/p/src/index.8bs': 'export let limit: u16 = 100;',
    'node_modules/@t/p/src/index.nes.8bs': 'export let limit: u16 = 7;',
  };
  withFiles(files, (dir) => {
    const entry = join(dir, 'main.8bs');
    assert.match(resolveSpecifier('@t/p', entry, { machine: 'nes' }).path, /index\.nes\.8bs$/);
    assert.match(resolveSpecifier('@t/p', entry, { machine: 'c64' }).path, /src\/index\.8bs$/);
    assert.match(resolveSpecifier('@t/p', entry).path, /src\/index\.8bs$/);
    assert.equal(limitIn(link(files['main.8bs'], entry, { machine: 'nes' }).ir), 7);
    assert.equal(limitIn(link(files['main.8bs'], entry, { machine: 'web' }).ir), 100);
  });
  // Only per-machine versions, and a machine without one: 8BS3002 here too.
  const onlyVariants = { ...files };
  delete onlyVariants['node_modules/@t/p/src/index.8bs'];
  withFiles(onlyVariants, (dir) => {
    const entry = join(dir, 'main.8bs');
    assert.equal(resolveSpecifier('@t/p', entry, { machine: 'web' }).code, '8BS3002');
    assert.equal(resolveSpecifier('@t/p', entry).path, null);
  });
});
