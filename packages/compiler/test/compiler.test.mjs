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
  const src = 'import { screen } from "@8bitscript/core";\nimport { vic } from "@8bitscript/vic20";\n';
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
    'main.8bs': 'import { secret, delay } from "./lib.8bs";',
    'lib.8bs': LIB,
  });
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2005', '8BS2005']);
});

test('an import colliding with a local binding is 8BS2006', () => {
  const { diagnostics } = linked({
    'main.8bs': 'import { limit } from "./lib.8bs";\nlet limit: u16 = 1;',
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
  const { ir, diagnostics } = linked({
    'main.8bs': 'import { b } from "./b.8bs";\nexport let a: u8 = 1;\nexport function main(): void { a = b; }',
    'b.8bs': 'import { a } from "./main.8bs";\nexport let b: u8 = 2;\nexport function swap(): void { b = a; }',
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

// ---- conditional package entries (the real border example as fixture) -----
//
// The border example's entry imports @8bitscript/machine, whose manifest
// entry is keyed by machine and delegates to @8bitscript/vic20 or
// @8bitscript/c64 through real pnpm symlinks. This pair is the proof the
// conditional resolution actually switches implementations.

const BORDER_ENTRY = join(HERE, '..', '..', '..', 'examples', 'border', 'src', 'main.8bs');

test('a conditional entry resolves to the vic20 implementation', () => {
  const { ir, diagnostics } = link(readFileSync(BORDER_ENTRY, 'utf8'), BORDER_ENTRY, { machine: 'vic20' });
  assert.deepEqual(diagnostics, []);
  assert.equal(ir.globals.find((g) => g.name === 'vicColor').address, 0x900f);
  assert.ok(ir.functions.some((f) => f.name === 'applyColors'));
  assert.ok(!ir.globals.some((g) => g.name === 'borderColor'));
});

test('the same entry resolves to the c64 implementation', () => {
  const { ir, diagnostics } = link(readFileSync(BORDER_ENTRY, 'utf8'), BORDER_ENTRY, { machine: 'c64' });
  assert.deepEqual(diagnostics, []);
  assert.equal(ir.globals.find((g) => g.name === 'borderColor').address, 0xd020);
  assert.ok(!ir.globals.some((g) => g.name === 'vicColor'));
});

test('the same entry resolves to the web implementation', () => {
  // main.8bs is a genuinely single file now: it exports main()+frame(),
  // and each target's own screen namespace (real screen memory on the
  // VIC-20/C64, a virtual character grid on the web — see @8bitscript/
  // web's header comment) gives clearScreen()/drawLabels() something to
  // poke everywhere, so the same source links clean against all three.
  const { ir, diagnostics } = link(readFileSync(BORDER_ENTRY, 'utf8'), BORDER_ENTRY, { machine: 'web' });
  assert.deepEqual(diagnostics, []);
  assert.ok(ir.globals.some((g) => g.name === 'border'));
  assert.ok(!ir.globals.some((g) => g.name === 'vicColor' || g.name === 'borderColor'));
});

test('a machine the entry has no branch for is 8BS3002', () => {
  // vic20, c64, and web all have branches now — 'nes' stands in for the
  // "not one of them" case this error exists for.
  const { ir, diagnostics } = link(readFileSync(BORDER_ENTRY, 'utf8'), BORDER_ENTRY, { machine: 'nes' });
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3002']);
});

test('without a machine, every branch of a conditional entry is validated', () => {
  // analyze/`8bs check` resolve imports with no machine in hand: a sound
  // conditional entry is clean, not an error.
  assert.deepEqual(
    codes('import { applyColors } from "@8bitscript/machine";', BORDER_ENTRY, { resolveImports: true }),
    [],
  );
});

test('errors in an imported module fail the link, against the right file', () => {
  const { ir, diagnostics } = linked({
    'main.8bs': 'import { limit } from "./lib.8bs";',
    'lib.8bs': 'export let limit: u8 = 300;\n',
  });
  assert.equal(ir, null);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, '8BS1021');
  assert.match(diagnostics[0].file, /lib\.8bs$/);
});
