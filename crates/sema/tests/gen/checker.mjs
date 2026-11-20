// Regenerates fixtures/checker.json from packages/compiler/src/checker (the JS oracle).
// Run from the repo root: node crates/sema/tests/gen/checker.mjs
//
// `check` rows are tap records (scripts/oracle/front-tap): the real function runs through the
// front tap's wrapper and the rows are read back from its output. `checkImmutableLets` rows are
// plain `{fn, args, result}`. scopes.mjs is exercised through both.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkImmutableLets } from '../../../../packages/compiler/src/checker/immutable.mjs';
import { parse, tokenize } from '../../../../packages/compiler/src/front/index.mjs';

const dir = mkdtempSync(join(tmpdir(), 'checker-gen-'));
process.env.EIGHTBS_FRONT_TAP = dir;
delete process.env.EIGHTBS_FRONT_TAP_ROOTS;
const { check: tapped } = await import('../../../../scripts/oracle/front-tap/shims/checker.mjs');
// A throw is recorded by the tap (and skipped by the replay); the generator carries on.
const check = (...args) => { try { return tapped(...args); } catch { return undefined; } };

const log = join(dir, '0.jsonl');
function take(name) {
  const rows = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  if (existsSync(log)) rmSync(log);
  // A call that threw has no result to compare: the replay skips it, so it is not a row.
  return rows.filter((row) => !('throw' in row)).map(({ seq, ...row }) => ({ name, ...row }));
}

const rows = [];
const add = (fn, args, result) => rows.push({ fn, args, result });
function addImmutable(ast, file) {
  if (!ast) return; // the Rust port takes a tree; a missing one is covered by the check rows
  try { add('checkImmutableLets', [plain(ast), file], checkImmutableLets(ast, file)); } catch { /* throws are not rows */ }
}
const plain = (node) => JSON.parse(JSON.stringify(node ?? null));

function astOf(text, file) {
  const { tokens } = tokenize(text, file, { sourceKind: '.8bs' });
  return parse(tokens, text, file, { sourceKind: '.8bs' }).ast;
}

const long = (n) => 'A'.repeat(n);

const sources = {
  // 8BS1021: literals that do or do not fit, by canonical name and alias.
  ranges: `let a: u8 = 255;
let b: u8 = 256;
let c: u8 = -1;
let d: i8 = -128;
let e: i8 = -129;
let f: i8 = 128;
let g: u16 = 65536;
let h: utinyint = 300;
let i: tinyint = +5;
let j: tinyint = +200;
let k: u24 = 16777216;
let l: i24 = -8388609;
let m: u32 = 4294967296;
let n: i32 = -2147483649;
let o: u8 = 1 + 2;
let p: ptr<u8> = 300;
let q: bool = 300;
let r: array<u8, 4>;
const BIG: u8 = 999;
fn f1() { let x: u8 = 256; let y: i16 = 40000; let mut z: u8 = 3; }
`,
  // 8BS1034: const and variable spellings.
  names: `const GOOD: u8 = 1;
const OPTION_COUNT: u8 = 2;
const bad: u8 = 3;
const OptionCount: u8 = 4;
const borders: u8 = 5;
const aBC: u8 = 6;
const a1B2c: u8 = 7;
const _x: u8 = 8;
const X9: u8 = 9;
const Ünï: u8 = 10;
let fine: u8 = 0;
let _under: u8 = 0;
let Loud: u8 = 0;
let X: u8 = 0;
let mut Mut: u8 = 0;
fn nested() { const inner: u8 = 1; let Inner: u8 = 2; let ok: u8 = 3; }
mod Colors { pub const blue: u8 = 1; pub const BLUE: u8 = 2; pub let Green: u8 = 3; }
`,
  // 8BS2009: the reserved builtin name, in each place it can be declared.
  reserved: `use self::a::{waitFrame, other};
use self::b::{x as waitFrame};
let waitFrame: u8 = 0;
const waitFrame: u8 = 1;
fn waitFrame() {}
fn g(waitFrame: u8) { let waitFrame: u8 = 2; }
mod waitFrame { pub fn waitFrame() {} }
fn h() { waitFrame(); let ok: u8 = 0; }
`,
  // 8BS1026 and 8BS1027: screen text.
  text: `let ok: string = "Hello, World! 0-9 a:z?";
let under: string = "no_underscore";
let accent: string = "café";
let emoji: string = "go \u{1F600} go";
let sym: string = "a+b";
let quote: string = "tab\there";
let empty: string = "";
let edge: string = "${long(255)}";
let over: string = "${long(256)}";
let wide: string = "${long(254)}é";
let wideLong: string = "${long(300)}";
use self::strings::{x};
fn f() {
    text::print(0, \`HELLO \${1}\`);
    text::print(0, \`café \${1}\`);
    text::print(0, \`${long(300)}\`);
    text::print(0, \`${long(255)}\`);
    text::print(0, \`under_score\`);
    text::print(0, "plain %");
}
`,
  unterminated: `let a: string = "abc
let b: u8 = 1;
`,
  // 8BS1046: a record literal outside an i18n.format call.
  records: `use @8bitscript::i18n::i18n;
fn f() {
    i18n::format("HI", { a: 1 });
    i18n::format({ a: 1 });
    i18n::format("HI", { a: 1 }, { b: 2 });
    i18n::other("HI", { a: 1 });
    let x = { a: 1 };
    foo({ a: 1 });
    i18n::format("HI", { a: { b: 1 } });
}
let g = { a: 1 };
`,
  // Templates: placed, misplaced, outside a function, widths.
  templates: `let tbl: array<u8, 4>;
const LIMIT: u8 = 9;
let mut score: u16 = 0;
let name: string = "hi";
let global: string = \`GLOBAL \${1}\`;
fn show(n: u8, w: u16, flag: bool, msg: string) {
    text::print(0, \`N \${n} W \${w} F \${flag} M \${msg}\`);
    text::print(0, \`SCORE \${score} T \${tbl[0]} \${tbl.length} \${LIMIT}\`);
    text::print(0, \`WIDTH \${n:3} \${unknown} \${missing()}\`);
    text::print(0, \`\`);
    let local: u8 = 1;
    let mut wide: u16 = 2;
    text::print(0, \`LOCAL \${local} \${wide} \${local + wide}\`);
    let t = \`NOT PRINTED \${n}\`;
    foo(\`ARG \${n}\`);
    text::print(\`FIRST \${n}\`, 0);
    text::print(0, \`TWO \${n}\`, 1);
    text::print(\`ONE \${n}\`);
    other.print(0, \`MEMBER \${n}\`);
    text::print(0, \`A \${n}\`) + 1;
    if n == 1 { text::print(1, \`IN IF \${n}\`); }
    while n < 3 { text::print(2, \`IN WHILE \${n}\`); }
    return \`RET \${n}\`;
}
mod ui {
    pub fn draw(n: u8) {
        text::print(0, \`DRAW \${n}\`);
        let bad = \`MISPLACED \${n}\`;
    }
    pub let inside: string = \`MOD GLOBAL \${1}\`;
    mod deeper { pub fn skipped(n: u8) { let x = \`DEEP \${n}\`; } }
}
fn noBody();
`,
  // 8BS1031: consts and const arrays.
  consts: `const HALF: u8 = 30;
const TABLE: array<u8, 3> = [1, 2, 3];
let mut tbl: array<u8, 3>;
let mut counter: u8 = 0;
fn main() {
    HALF = 2;
    HALF += 1;
    HALF++;
    --HALF;
    TABLE[0] = 5;
    TABLE[1] += 1;
    TABLE[2]++;
    tbl[0] = 1;
    counter = HALF;
    let mut HALF2: u8 = HALF;
    HALF2 = 3;
}
fn shadow(HALF: u8, TABLE: u8) {
    HALF = 1;
    TABLE[0] = 1;
}
fn local() {
    let mut HALF: u8 = 1;
    HALF = 2;
    let x: u8 = 3;
}
fn nested() {
    if true { HALF = 3; }
    for i in 0..3 { TABLE[i] = 0; }
}
mod m {
    pub const INNER: u8 = 1;
    pub fn f() { HALF = 1; INNER = 2; TABLE[0] = 1; }
}
`,
  // 8BS1031 (E20): plain let stores, by block scope.
  e20: `let x: u8 = 0;
let mut y: u8 = 0;
let arr: array<u8, 4>;
let mut marr: array<u8, 4>;
mod m { pub let a: u8 = 0; pub let mut b: u8 = 0; pub let t: array<u8, 4>; pub fn f() { a = 1; b = 1; } }
mod n { mod o { pub let p: u8 = 0; } pub fn g() { o::p = 1; } }
fn stores(param: u8, p2: u8 = 3) {
    x = 1;
    x += 1;
    x++;
    --x;
    y = 1;
    arr[1] = 2;
    arr[1] += 1;
    marr[1] = 2;
    m::a = 1;
    m::b = 1;
    m::t[0] = 1;
    m::missing = 1;
    missing::a = 1;
    n::o::p = 1;
    param = 1;
    p2 = 1;
    let z: u8 = 0;
    z = 1;
    let mut w: u8 = 0;
    w = 1;
    if true { let x: u8 = 1; x = 2; let mut y: u8 = 1; y = 2; } else { x = 9; }
    while x < 3 { let q: u8 = 0; q = 1; }
    { let blockLocal: u8 = 0; blockLocal = 1; }
    blockLocal = 2;
    for (let i: u8 = 0; i < 4; i += 1) { i = 2; }
    for (let mut j: u8 = 0; j < 4; j += 1) { j = 2; }
    for i in 0..4 { i = 3; }
    for k in 0..=4 { let mut inner: u8 = k; inner = 1; k++; }
    for k in 0..4 { x = k; }
    x = x + y;
    arr[x] = y;
    (x) = 1;
    x.y = 1;
    fns()[0] = 1;
}
fn fns() {}
fn defaults(a: u8 = (x = 1), b: u8 = 2) {}
let g1: u8 = (x = 2);
use self::other::{imported};
fn imports() { imported = 1; imported++; }
fn shadow() { let x: u8 = 0; x = 1; }
fn late() { later = 1; }
let later: u8 = 0;
let mut dup: u8 = 0;
let dup: u8 = 1;
fn dups() { dup = 1; }
`,
  e20for: `fn f() {
    for i in 0..4 { i = 3; }
    for i in 0..4 { i++; }
    for i in 0..4 { }
    for (let i: u8 = 0; i < 4; i++) { }
    for (let mut i: u8 = 0; i < 4; i++) { }
    for (let i: u8 = 0; i < 4; i += 1) { }
    for (let i: u8 = 0; i < 4; i--) { }
    for (i = 0; i < 4; i++) { }
    for (;;) { }
}
let i: u8 = 0;
fn g() { for (i = 0; i < 4; i++) { } }
`,
  // A namespace whose member failed to parse: the tree holds a null in `members`.
  nullMember: 'mod m { fn ; pub let a: u8 = 0; }\nlet b: u8 = 1;\n',
  empty: '',
  clean: `use self::geo::{a};
const MAX: u8 = 9;
let mut score: u16 = 0;
pub fn main() {
    text::print(0, \`SCORE \${score}\`);
    score += 1;
    if score > MAX { score = 0; }
}
`,
  // Components and state: the scope walk reaches them; the checker reads only what it names.
  bx: `component Counter(label: string, start: u8 = 1) {
    state count: u8 = 0;
    let mut local: u8 = 0;
    count = 1;
    count++;
    local = 2;
    <Counter label="x" />;
    <>
        <Counter label="y" />
    </>;
}
let top: u8 = 0;
`,
};

const asts = {};
for (const [key, text] of Object.entries(sources)) {
  const file = `${key}.8bs`;
  const ast = astOf(text, file);
  asts[key] = { file, text, ast };
  check(ast, file, text);
  rows.push(...take(`check ${key}`));
  check(ast, file, text, { skipScreenText: true });
  rows.push(...take(`check ${key} skipScreenText`));
  check(ast, file, text, { skipScreenText: false });
  rows.push(...take(`check ${key} skipScreenText false`));
  check(ast, file);
  rows.push(...take(`check ${key} no source`));
  check(ast);
  rows.push(...take(`check ${key} no file`));
  check(ast, file, null, {});
  rows.push(...take(`check ${key} null source`));
  addImmutable(ast, file);
}
check(null);
rows.push(...take('check null'));
check(undefined, 'x.8bs');
rows.push(...take('check undefined'));
check(null, 'x.8bs', 'text', { skipScreenText: true });
rows.push(...take('check null with options'));

// Trees the parser does not build: an old-syntax declaration (no `immutable`), a C-style `for`
// whose update steps its plain `let`, a range-form `for`.
const id = (name, start) => ({ type: 'Identifier', name, start, length: name.length });
const decl = (immutable, start = 0) => ({
  type: 'VariableDeclaration', kind: 'let', start, length: 10, name: id('x', start + 4),
  typeAnnotation: null, initializer: null, exported: false, ...(immutable === undefined ? {} : { immutable }),
});
const update = (operator) => ({ type: 'UpdateExpression', operator, prefix: false, start: 20, length: 3, argument: id('x', 20) });
const block = { type: 'BlockStatement', start: 30, length: 2, body: [] };
const program = (body) => ({ type: 'Program', start: 0, length: 40, body });
const stmt = (expression) => ({ type: 'ExpressionStatement', start: 20, length: 4, expression });
const forOf = (init, upd) => ({ type: 'ForStatement', start: 0, length: 40, init, test: null, update: upd, body: block });
const synthetic = {
  oldSyntax: program([decl(undefined), stmt(update('++'))]),
  explicitFalse: program([decl(false), stmt(update('++'))]),
  stmtInc: program([decl(true), stmt(update('++'))]),
  stmtDec: program([decl(true), stmt(update('--'))]),
  cFor: program([forOf(decl(true), update('++'))]),
  cForDec: program([forOf(decl(true), update('--'))]),
  rangeFor: program([forOf({ ...decl(true), start: 4 }, update('++'))]),
  rangeForDec: program([forOf({ ...decl(true), start: 4 }, update('--'))]),
  rangeForOtherVar: program([forOf({ ...decl(true), start: 4 }, { ...update('++'), argument: id('y', 20) })]),
  rangeForNoName: program([forOf({ ...decl(true), start: 4, name: null }, update('++'))]),
  rangeForPlain: program([forOf({ ...decl(undefined), start: 4 }, update('++'))]),
  rangeForNoUpdate: program([forOf({ ...decl(true), start: 4 }, null)]),
  noName: program([{ type: 'NamespaceDeclaration', start: 0, length: 20, name: null, exported: false, members: [decl(true, 8)] }]),
  nullBody: program([{ type: 'FunctionDeclaration', start: 0, length: 20, name: id('f', 3), params: [], returnType: null, body: null, exported: false }]),
};
for (const [key, ast] of Object.entries(synthetic)) {
  asts[key] = { file: `${key}.8bs`, text: '', ast };
  check(ast, `${key}.8bs`);
  rows.push(...take(`check ${key}`));
  addImmutable(ast, `${key}.8bs`);
}

writeFileSync(fileURLToPath(new URL('../fixtures/checker.json', import.meta.url)), `${JSON.stringify(rows)}\n`);
rmSync(dir, { recursive: true, force: true });
console.log(`wrote ${rows.length} rows`);
