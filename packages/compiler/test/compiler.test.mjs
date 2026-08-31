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
  assert.deepEqual(ir.globals[0], {
    name: 'x', type: 'u8', volatile: false, address: null, init: 10, exported: false,
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
  // Every unsupported construct must produce 8BS3001, not vanish.
  for (const src of [
    'import { a } from "x";',
    'export function f(): void { g(); }',
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
