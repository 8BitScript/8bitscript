// The migrate printer (old-syntax AST to new Rust-style source): fixtures for
// every row of the syntax spec's mapping table, the comment rules, the `mut`
// inference, and a run over every in-repo `.8bs`/`.8bx` source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/migrate/legacy/parser.mjs';
import { tokenize } from '../src/migrate/legacy/lexer.mjs';
import {
  OldSyntaxError, UnsupportedError, analyzeMutability, convertSource, printProgram, spellName, usePathOf,
} from '../src/migrate/print.mjs';

const conv = (src, options) => convertSource(src, options).text;

/** Assert `src` prints as `expected` (a trailing newline is implied). */
const prints = (src, expected, options) => assert.equal(conv(src, options), `${expected}\n`);

test('imports: relative, parent, package, alias and one-name forms', () => {
  prints('import { a, b as c } from "./geo.8bs";', 'use self::geo::{a, b as c};');
  prints('import { a } from "./geo.8bs";', 'use self::geo::a;');
  prints('import { a } from "../src/index.8bs";', 'use super::src::index::a;');
  prints('import { a } from "../../x/y.8bs";', 'use super::super::x::y::a;');
  prints('import { sprites as hardware } from "@8bitscript/c64/sprites";', 'use @8bitscript::c64::sprites::{sprites as hardware};');
  prints('import { a } from "foo";', 'use foo::a;');
  prints('import { a } from "./mark.8bg";', 'use self::mark::a;');
  prints('import { a } from "./geo";', 'use self::geo::a;');
  prints('import "./side.8bs";', 'use self::side::{};');
});

test('imports: a specifier that is not a path of identifiers keeps its string', () => {
  prints('import { a } from "./number-values.8bs";', 'use "./number-values.8bs"::a;');
  prints("import { a, b } from './x.json';", 'use "./x.json"::{a, b};');
  prints('import { a } from "./loop.8bs";', 'use "./loop.8bs"::a;');
  prints('import { a } from "..";', 'use ".."::a;');
  prints('import { a } from "./a/../b.8bs";', 'use "./a/../b.8bs"::a;');
});

test('imports: an extension on a package specifier keeps the string unless it is a config alias', () => {
  prints('import { a } from "@lib/game/rules.8bs";', 'use "@lib/game/rules.8bs"::a;');
  prints('import { a } from "@lib/game/rules.8bs";', 'use @lib::game::rules::a;', { aliasHeads: ['@lib'] });
  prints('import { a } from "pkg/x.8bs";', 'use "pkg/x.8bs"::a;');
  assert.equal(usePathOf('@a-b/c', []), '@a-b::c');
  assert.equal(usePathOf('./a-b', []), null);
  assert.equal(usePathOf('pkg', []), 'pkg');
});

test('functions: fn, void return, defaults, export, entry point', () => {
  prints('function f(a: u8, b: u8 = 3): u8 { return a; }', 'fn f(a: u8, b: u8 = 3) -> u8 {\n    return a;\n}');
  prints('function f(): void {}', 'fn f() {\n}');
  prints('export function main(): void { return; }', 'pub fn main() {\n    return;\n}');
  prints('function g(x): u8 { return x; }', 'fn g(x) -> u8 {\n    return x;\n}');
  prints('function h(p: ptr<u8>): void {}', 'fn h(p: ptr<u8>) {\n}');
});

test('variables: const, global, export, types', () => {
  prints('const MAX: u8 = 9;', 'const MAX: u8 = 9;');
  prints('export const MAX = 9;', 'pub const MAX = 9;');
  prints('export let score: u16 = 0;', 'pub let mut score: u16 = 0;');
  prints('const t: array<u8, 3> = [1, 2, 3];', 'const t: [u8; 3] = [1, 2, 3];');
  prints('let s: string<16> = "x"; let v: volatile<u8>;', 'let s: string<16> = "x";\nlet v: volatile<u8>;');
  prints('let m: array<array<u8, 2>, 3>;', 'let m: [[u8; 2]; 3];');
});

test('mutability: only reassigned or mutated bindings print `mut`', () => {
  prints('let a: u8 = 0; let b: u8 = 0; function f(): void { a = 1; }', 'let mut a: u8 = 0;\nlet b: u8 = 0;\nfn f() {\n    a = 1;\n}');
  prints(
    'function f(): void { let x: u8 = 1; let y: u8 = 2; let z: u8 = 3; x += 1; y++; z = z; }',
    'fn f() {\n    let mut x: u8 = 1;\n    let mut y: u8 = 2;\n    let mut z: u8 = 3;\n    x += 1;\n    y += 1;\n    z = z;\n}',
  );
  prints('function f(): void { let k: u8 = 1; let t: u8 = k; }', 'fn f() {\n    let k: u8 = 1;\n    let t: u8 = k;\n}');
});

test('mutability: scoping decides which binding is stored to', () => {
  prints(
    'function f(): void { let x: u8 = 1; { let x: u8 = 2; x = 3; } let y: u8 = x; }',
    'fn f() {\n    let x: u8 = 1;\n    {\n        let mut x: u8 = 2;\n        x = 3;\n    }\n    let y: u8 = x;\n}',
  );
  prints('let x: u8 = 0; function f(x: u8): void { x = 1; }', 'let x: u8 = 0;\nfn f(x: u8) {\n    x = 1;\n}');
  prints(
    'namespace n { let c: u8 = 0; function bump(): void { c++; } } function f(): void { n.c = 2; }',
    'mod n {\n    let mut c: u8 = 0;\n    fn bump() {\n        c += 1;\n    }\n}\nfn f() {\n    n::c = 2;\n}',
  );
});

test('mutability: indexed stores, exports, asm and array values are ambiguous or mutable', () => {
  const reasons = (src) => {
    const { tokens } = tokenize(src, 'a.8bs');
    const { ast } = parse(tokens, src, 'a.8bs');
    return [...analyzeMutability(ast).entries()].map(([decl, why]) => `${decl.name.name}:${why}`).sort((a, b) => a.localeCompare(b));
  };
  assert.deepEqual(reasons('let t: array<u8, 4>; function f(): void { t[1] = 2; }'), ['t:assigned']);
  assert.deepEqual(reasons('export let e: u8 = 0;'), ['e:exported']);
  assert.deepEqual(reasons('let a: u8 = 0; function f(): void { asm6502 { lda a } }'), ['a:asm']);
  assert.deepEqual(reasons('let buf: array<u8, 4>; function g(p: ptr<u8>): void {} function f(): void { g(buf); }'), ['buf:value']);
  assert.deepEqual(reasons('let buf: array<u8, 4>; function f(): u8 { return buf[0] + buf.length; }'), []);
  assert.deepEqual(reasons('let n: u8 = 0; function f(): void { for (let i: u8 = 0; i < 3; i++) { n = i; } }').join(), 'i:assigned,n:assigned');
});

test('mutability: stats count `let mut`, plain `let` and the ambiguous ones', () => {
  const { stats } = convertSource('export let a: u8 = 0; let b: u8 = 0; let c: u8 = 0; function f(): void { c = 1; }');
  assert.deepEqual({ mut: stats.letMut, plain: stats.letPlain, ambiguous: stats.letAmbiguous }, { mut: 2, plain: 1, ambiguous: 1 });
});

test('namespaces become mod; members take no pub', () => {
  prints(
    'export namespace Color { const RED: u8 = 2; function f(): u8 { return RED; } }',
    'pub mod Color {\n    const RED: u8 = 2;\n    fn f() -> u8 {\n        return RED;\n    }\n}',
  );
  prints('namespace Color { const RED: u8 = 2; } const x: u8 = Color.RED;', 'mod Color {\n    const RED: u8 = 2;\n}\nconst x: u8 = Color::RED;');
});

test('member access: namespace paths use ::, a value field uses a dot', () => {
  prints('function f(): u8 { memory.write(1, 2); port.x(3); return memory.read(1); }', 'fn f() -> u8 {\n    memory::write(1, 2);\n    port::x(3);\n    return memory::read(1);\n}');
  prints('const T: array<u8, 2> = [1, 2]; function f(): u8 { return T.length; }', 'const T: [u8; 2] = [1, 2];\nfn f() -> u8 {\n    return T.length;\n}');
  prints('import { Lib } from "./lib.8bs"; const a: u8 = Lib.limit; const n: u8 = Lib.table.length;', 'use self::lib::Lib;\nconst a: u8 = Lib::limit;\nconst n: u8 = Lib::table.length;');
});

test('loops: range for, C for, loop, while', () => {
  prints('function f(): void { for (let i: u8 = 0; i < 10; i++) { g(i); } }', 'fn f() {\n    for i: u8 in 0..10 {\n        g(i);\n    }\n}');
  prints('function f(): void { for (let i = a; i <= n + 1; i++) g(i); }', 'fn f() {\n    for i in a..=n + 1 {\n        g(i);\n    }\n}');
  prints('function f(): void { for (let i: u8 = 0; i < 10; i++) { i += 2; } }', 'fn f() {\n    for (let mut i: u8 = 0; i < 10; i += 1) {\n        i += 2;\n    }\n}');
  prints('function f(): void { for (let i: u8 = 9; i > 0; i--) { g(i); } }', 'fn f() {\n    for (let mut i: u8 = 9; i > 0; i -= 1) {\n        g(i);\n    }\n}');
  prints('function f(): void { for (let i: u8 = 0; i != 3; i++) { g(i); } }', 'fn f() {\n    for (let mut i: u8 = 0; i != 3; i += 1) {\n        g(i);\n    }\n}');
  prints('function f(): void { let j: u8 = 0; for (j = 0; j < 3; ++j) { g(j); } }', 'fn f() {\n    let mut j: u8 = 0;\n    for (j = 0; j < 3; j += 1) {\n        g(j);\n    }\n}');
  prints('function f(): void { for (;;) { break; } }', 'fn f() {\n    for (; ; ) {\n        break;\n    }\n}');
  prints('function f(): void { while (true) { continue; } }', 'fn f() {\n    loop {\n        continue;\n    }\n}');
  prints('function f(): void { while (x < 3) g(); }', 'fn f() {\n    while x < 3 {\n        g();\n    }\n}');
  prints('function f(): void { @unroll for (let i: u8 = 0; i < 4; i++) { g(i); } }', 'fn f() {\n    #[unroll] for i: u8 in 0..4 {\n        g(i);\n    }\n}');
});

test('range for: a bound that holds braces or a choice is parenthesised', () => {
  prints('function f(): void { for (let i: u8 = 0; i < (c ? 1 : 2); i++) { g(i); } }', 'fn f() {\n    for i: u8 in 0..(if c { 1 } else { 2 }) {\n        g(i);\n    }\n}');
});

test('if: braces required, else if chains, single statements wrapped', () => {
  prints('function f(): void { if (a) g(); else if (b) h(); else k(); }', 'fn f() {\n    if a {\n        g();\n    } else if b {\n        h();\n    } else {\n        k();\n    }\n}');
  prints('function f(): void { if (a) { g(); } }', 'fn f() {\n    if a {\n        g();\n    }\n}');
});

test('statements: increments, return, break, asm, blocks, empty statements', () => {
  prints('function f(): void { x++; y--; ++z; }', 'fn f() {\n    x += 1;\n    y -= 1;\n    z += 1;\n}');
  prints('function f(): u8 { { g(); } ; return 1; }', 'fn f() -> u8 {\n    {\n        g();\n    }\n    return 1;\n}');
  prints('asm6502 { lda #1\n  sta $d020 }', 'asm6502 { lda #1\n  sta $d020 }');
  prints('function f(): void { asm6502 {\n  nop\n} }', 'fn f() {\n    asm6502 {\n  nop\n}\n}');
});

test('increment inside a larger expression is unsupported, with its line', () => {
  assert.throws(() => convertSource('function f(): void {\n  let a: u8 = 0;\n  let b: u8 = a++ + 1;\n}'), (e) => {
    assert.ok(e instanceof UnsupportedError);
    assert.equal(e.kind, 'update-in-expression');
    assert.equal(e.line, 3);
    return true;
  });
});

test('old syntax that does not parse is reported, not printed', () => {
  assert.throws(() => convertSource('function ('), OldSyntaxError);
  assert.throws(() => convertSource('let x = ;'), (e) => e instanceof OldSyntaxError && e.diagnostics.length > 0);
});

test('expressions: conditional becomes an if expression', () => {
  prints('let x: u8 = c ? 1 : 2;', 'let x: u8 = if c { 1 } else { 2 };');
  prints('let x: u8 = a ? 1 : b ? 2 : 3;', 'let x: u8 = if a { 1 } else if b { 2 } else { 3 };');
  prints('let x: u8 = (c ? 1 : 2) + 1;', 'let x: u8 = (if c { 1 } else { 2 }) + 1;');
  prints('function f(): void { c ? g() : h(); }', 'fn f() {\n    (if c { g() } else { h() });\n}');
  prints('function f(): void { x = c ? 1 : 2; }', 'fn f() {\n    x = if c { 1 } else { 2 };\n}');
});

test('expressions: parentheses follow the old precedence plus the comparison rules', () => {
  prints('let x: u8 = (a + b) * c;', 'let x: u8 = (a + b) * c;');
  prints('let x: u8 = a + (b * c);', 'let x: u8 = a + b * c;');
  prints('let x: u8 = a - (b - c);', 'let x: u8 = a - (b - c);');
  prints('let x: u8 = a - b - c;', 'let x: u8 = a - b - c;');
  prints('let x: bool = a & b == c;', 'let x: bool = a & (b == c);');
  prints('let x: bool = (a & b) == c;', 'let x: bool = (a & b) == c;');
  prints('let x: bool = (a == b) | (c != d);', 'let x: bool = (a == b) | (c != d);');
  prints('let x: bool = (a < b) < c;', 'let x: bool = (a < b) < c;');
  prints('let x: bool = a < b && c > d || e;', 'let x: bool = a < b && c > d || e;');
  prints('let x: u8 = a << 2 | b;', 'let x: u8 = a << 2 | b;');
  prints('let x: u8 = (a = b) + 1;', 'let x: u8 = (a = b) + 1;');
});

test('expressions: unary operators never form ++ or --', () => {
  prints('let x: i8 = -(-a);', 'let x: i8 = -(-a);');
  prints('let x: i8 = -(+a);', 'let x: i8 = -+a;');
  prints('let x: i8 = a - -b;', 'let x: i8 = a - -b;');
  prints('let x: bool = !(a && b);', 'let x: bool = !(a && b);');
  prints('let x: u8 = ~a & 3;', 'let x: u8 = ~a & 3;');
  prints('let x: i8 = -(a + b);', 'let x: i8 = -(a + b);');
  prints('let x: u8 = (-a).b;', 'let x: u8 = (-a).b;');
});

test('expressions: calls, casts, indexes, compile-time calls, records, arrays', () => {
  prints('let x: u8 = u8(f(1, 2)[3]);', 'let x: u8 = u8(f(1, 2)[3]);');
  prints('let x: u8 = #frames(2, seconds);', 'let x: u8 = #frames(2, seconds);');
  prints('let d = #frames(0.5, seconds);', 'let d = #frames(0.5, seconds);');
  prints('function f(): void { i18n.format("k", { control: Input.X, n: 2 }); g({}); }', 'fn f() {\n    i18n::format("k", { control: Input::X, n: 2 });\n    g({});\n}');
  prints('const t = [1, 2, 3,];', 'const t = [1, 2, 3];');
  prints('const t = [];', 'const t = [];');
});

test('expressions: a record in a no-brace position is parenthesised', () => {
  prints('function f(): void { if (g({ a: 1 })) { h(); } }', 'fn f() {\n    if (g({ a: 1 })) {\n        h();\n    }\n}');
  prints('function f(): void { ({ a: 1 }); }', 'fn f() {\n    ({ a: 1 });\n}');
});

test('literals: numbers, strings, templates', () => {
  prints('let a = $FF; let b = 0xFF; let c = %1010; let d = 0b1010; let e = 1_000;', 'let a = $FF;\nlet b = 0xFF;\nlet c = 0b1010;\nlet d = 0b1010;\nlet e = 1_000;');
  prints("let a = 'hi'; let b = \"x\"; let c = 'it\\'s'; let d = 'say \"x\"'; let e = 'a\\nb';", 'let a = "hi";\nlet b = "x";\nlet c = "it\'s";\nlet d = "say \\"x\\"";\nlet e = "a\\nb";');
  prints('function f(): void { text.print(0, `HP ${hp:3} ${a + 1} ${c ? x : y}`); }', 'fn f() {\n    text::print(0, `HP ${hp:3} ${a + 1} ${if c { x } else { y }}`);\n}');
  prints('let t = true; let f = false;', 'let t = true;\nlet f = false;');
});

test('decorators: address and unroll', () => {
  prints('@address($D020) let border: volatile<u8>;', '#[address($D020)] let border: volatile<u8>;');
  prints('@address($D020) let border: volatile<u8>; function f(): void { border = 1; }', '#[address($D020)] let mut border: volatile<u8>;\nfn f() {\n    border = 1;\n}');
  prints('@a @b(1, 2) function f(): void {}', '#[a] #[b(1, 2)] fn f() {\n}');
});

test('names that are new keywords become raw identifiers', () => {
  prints('let loop: u8 = 0; function f(mod: u8): void { loop = mod + match.use; }', 'let mut r#loop: u8 = 0;\nfn f(r#mod: u8) {\n    r#loop = r#mod + r#match::r#use;\n}');
  assert.equal(spellName('x'), 'x');
  assert.equal(spellName('struct'), 'r#struct');
});

test('comments: own-line, trailing, blank-line collapse, before a closing brace', () => {
  prints(
    '// header\n\n\n// second\nlet a: u8 = 0; // trailing\n\n\n\nfunction f(): void { // open\n  // own line\n  g(); /* inline */\n\n  h();\n  // last\n}\n// end',
    '// header\n\n// second\nlet a: u8 = 0; // trailing\n\nfn f() { // open\n    // own line\n    g(); /* inline */\n\n    h();\n    // last\n}\n// end',
  );
  prints('/* a\n b */\nlet a = 1;', '/* a\n b */\nlet a = 1;');
});

test('comments: ones inside an expression or a header are kept after the statement', () => {
  const out = conv('let a = f(1, /* mid */ 2);\nlet b = 1;');
  assert.match(out, /\/\* mid \*\//);
  const header = conv('function f(a: u8 /* p */): void { g(); }');
  assert.match(header, /\/\* p \*\//);
});

test('comments: multi-line tables keep their line grouping and comments', () => {
  prints(
    'const T: array<u8, 6> = [\n  1, 2, // first\n  // second row\n  3, 4,\n  5, 6\n];',
    'const T: [u8; 6] = [\n    1, 2, // first\n    // second row\n    3, 4,\n    5, 6,\n];',
  );
});

test('.8bx: an element with a text child keeps that text verbatim, on one line', () => {
  const src = 'export function draw(): void {\n  <Text>Hello World!</Text>;\n  <B>a <C /> b</B>;\n}';
  assert.equal(conv(src, { sourceKind: '.8bx' }), 'pub fn draw() {\n    <Text>Hello World!</Text>;\n    <B>a <C /> b</B>;\n}\n');
});

test('.8bx: components, state, elements, attributes, children', () => {
  const src = [
    'import { text } from "@8bitscript/text";',
    'export component Menu(title: string<8> = "x", n: utinyint) {',
    '  state sel: utinyint = 0;',
    '  <Item label="a" on={sel} {extra} bare />;',
    '  <Frame>',
    '    hello   world',
    '    {sel == 0 ? <A /> : <B />}',
    '    {}',
    '    <Inner k=\'v\'></Inner>',
    '  </Frame>',
    '  <></>;',
    '  <>x</>;',
    '}',
  ].join('\n');
  assert.equal(conv(src, { sourceKind: '.8bx' }), [
    'use @8bitscript::text::text;',
    'pub component Menu(title: string<8> = "x", n: utinyint) {',
    '    state sel: utinyint = 0;',
    '    <Item label="a" on={sel} {extra} bare />;',
    '    <Frame>',
    '    hello   world',
    '    {if sel == 0 { <A /> } else { <B /> }} {} <Inner k="v"></Inner></Frame>;',
    '    <></>;',
    '    <>x</>;',
    '}',
    '',
  ].join('\n'));
});

test('an unknown node kind is reported as unsupported', () => {
  const src = 'let a = 1;';
  const { tokens } = tokenize(src, 'a.8bs');
  const { ast } = parse(tokens, src, 'a.8bs');
  ast.body.push({ type: 'Mystery', start: 0, length: 1 });
  assert.throws(() => printProgram(ast, tokens, src), (e) => e instanceof UnsupportedError && e.kind === 'statement');
  const { ast: ast2 } = parse(...[tokenize('let a = 1;', 'a.8bs').tokens, 'let a = 1;', 'a.8bs']);
  ast2.body[0].initializer = { type: 'Mystery', start: 0, length: 1 };
  assert.throws(() => printProgram(ast2, tokens, src), (e) => e instanceof UnsupportedError && e.kind === 'expression');
});

test('an empty file prints as an empty file', () => {
  assert.equal(conv(''), '');
  assert.equal(conv('// only a comment'), '// only a comment\n');
});

// ---- every in-repo source ---------------------------------------------------

// The frozen old-syntax corpus: the repo's own sources are new syntax now.
const PAIRS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'crates', 'front-wasm', 'tests', 'pairs');
const sources = () => readdirSync(PAIRS).filter((n) => /\.old\.8b[sx]$/.test(n)).map((n) => join(PAIRS, n));

test('every frozen old-syntax .8bs and .8bx source prints without an unsupported construct', () => {
  const files = sources();
  assert.ok(files.length >= 19, `expected the whole corpus, found ${files.length}`);
  const old = /^\s*(?:export |import |function |namespace )|\bfunction\s+\w+\(|\bnamespace\s+\w+\s*\{|\)\s*:\s*(?:void|u8)\b/;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const printed = convertSource(text, { file, sourceKind: file.endsWith('.8bx') ? '.8bx' : '.8bs' }).text;
    for (const [i, line] of printed.split('\n').entries()) {
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
      assert.doesNotMatch(line, old, `${file}:${i + 1} still has old syntax: ${line}`);
    }
    // braces and parentheses stay balanced outside strings, templates, asm and comments
    const code = printed
      .replace(/asm6502\s*\{[^}]*\}/g, '')
      .replace(/"(?:[^"\\\n]|\\.)*"|`[^`\n]*`|\/\/.*|\/\*[\s\S]*?\*\//g, '');
    const depth = { '{': 0, '(': 0, '[': 0 };
    for (const c of code) {
      if (c in depth) depth[c] += 1;
      else if (c === '}') depth['{'] -= 1;
      else if (c === ')') depth['('] -= 1;
      else if (c === ']') depth['['] -= 1;
      assert.ok(Object.values(depth).every((d) => d >= 0), `${file}: unbalanced`);
    }
    assert.deepEqual(Object.values(depth), [0, 0, 0], `${file}: unbalanced`);
  }
});
