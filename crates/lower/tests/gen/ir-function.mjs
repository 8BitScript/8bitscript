// Regenerates fixtures/ir-function.json from packages/compiler/src/ir (the JS oracle).
// Run from the repo root: node crates/lower/tests/gen/ir-function.mjs
//
// Every row is a front tap record (scripts/oracle/front-tap) of `lower` over a module with
// function bodies: each statement and expression kind, each intrinsic, each way function and
// statement lowering refuses one, and a function the elaborator tagged (`component`, `owner`,
// `method`, `state`, `instance`), which only an AST carries.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, tokenize } from '../../../../packages/compiler/src/front/index.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ir-function-gen-'));
process.env.EIGHTBS_FRONT_TAP = dir;
delete process.env.EIGHTBS_FRONT_TAP_ROOTS;
const { lower } = await import('../../../../scripts/oracle/front-tap/shims/ir.mjs');

const log = join(dir, '0.jsonl');
function take() {
  const rows = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  if (existsSync(log)) rmSync(log);
  return rows;
}


const sources = {
  'plain functions': `let mut g: u8 = 1;
const K: u8 = 3;
pub fn main() {
    g = K;
}
fn add(a: u8, b: u8) -> u8 {
    return a + b;
}
fn nothing() {
    return;
}
`,
  'every statement': `let mut g: u8;
let mut arr: [u8; 4];
fn run(n: u8) -> u8 {
    let mut i: u8 = 0;
    let j: u16;
    i = 1;
    i += 2;
    i++;
    i--;
    arr[1] = 5;
    arr[2] += 1;
    arr[3]++;
    if n > 1 {
        g = 1;
    } else if n == 0 {
        g = 2;
    } else {
        g = 3;
    }
    if n { g = 4; }
    while i < 10 {
        i++;
        if i == 5 { continue; }
        if i == 8 { break; }
    }
    loop { break; }
    for (let mut k: u8 = 0; k < 4; k++) {
        g += k;
    }
    for i2: u8 in 0..4 {
        g = i2;
    }
    for (;;) { break; }
    { let inner: u8 = 2; g = inner; }
    asm6502 { nop }
    return i + 1;
}
`,
  'every expression': `let mut g: u8;
let mut w: u16;
const K: u8 = 7;
const S: string = "hi";
fn run(a: u8, b: i8) -> u16 {
    let x: u8 = 1 + 2 * 3;
    let y: i8 = -5;
    let z: bool = !true;
    let c: u8 = if a > 1 { 2 } else { 3 };
    let d: u8 = (a << 1) | (a >> 2) & 3 ^ 1;
    let e: bool = a == 1 && b != 2 || a >= 3;
    let t: u8 = ~a;
    let u: u8 = -a;
    let v: u16 = 300;
    let k: u8 = K;
    let big: u16 = 70000;
    w = v + x;
    g = K;
    return w;
}
`,
  calls: `let mut g: u8;
fn one(a: u8) -> u8 { return a; }
fn two(a: u8, b: u8 = 4) -> u8 { return a + b; }
fn none() { g = 1; }
fn run() {
    none();
    g = one(1);
    g = two(1);
    g = two(1, 2);
    g = one(two(1)) + 1;
    one(2);
    screen::setBorderColor(1);
    g = Colors::BLUE;
    g = text::width(1);
    g = u8(g);
    waitFrame();
}
`,
  intrinsics: `let mut g: u8;
fn run() {
    memory::write(0x400, 1);
    g = memory::read(0x400);
    memory::read(0x401);
    port::write(3, 4);
    g = port::read(3);
}
`,
  'intrinsic refusals': `fn run() {
    memory::write(1);
    memory::read(1, 2);
    memory::poke(1);
    port::write(1);
    port::read();
    port::poke(1);
    memory::write(70000, 1);
    memory::write(1, 300);
    memory::write(-1, 1);
    port::write(300, 1);
    port::read(-1);
    let a: u8 = memory::write(1, 2);
    let b: u8 = waitFrame();
    waitFrame(1);
    one.two.three(1);
}
`,
  'array parameters': `const STARTS: [u8; 3] = [1, 2, 3];
let mut buf: [u16; 5];
fn pick(t: [u8; 3], i: u8) -> u8 {
    return t[i] + t.length;
}
fn first(t: [u8; 3]) -> u8 {
    return t[0];
}
fn run() -> u8 {
    buf[0] = 1;
    return pick(STARTS, 1) + first(STARTS);
}
`,
  'array parameter refusals': `fn a(t: [u8; 3] = 1) {}
fn b(t: [u8]) {}
fn c(x: u8 = 1, t: [u8; 3]) {}
fn d(t: [u8; 3]) { t = 1; }
fn e(t: [u8; 3]) { let y: u8 = t; }
fn f(t: [u8; 3]) { let y: u8 = t.size; }
fn g(t: [u8; 3]) { t[0] = 1; }
`,
  'parameter refusals': `fn a(x: thing) {}
fn b(x) {}
fn c(x: u8 = 1, y: u8) {}
fn d(x: u8 = Colors::BLACK, y: u8 = 2) {}
fn e(s: string = "ok") {}
fn f(s: string = 3) {}
fn g(x: u8 = 300) {}
fn h() -> thing {}
fn i(x: void) {}
`,
  'return refusals': `fn a() { return 1; }
fn b() -> u8 { return; }
fn c() -> u8 { if 1 { return; } return 2; }
fn d() { if 1 { return 3; } }
`,
  'local refusals': `let top: u8;
fn run(p: u8) {
    const K: u8 = 1;
    let a;
    let b: [u8; 2];
    let c: thing = 1;
    let d: [u8] = 1;
    #[address($10)]
    let e: u8;
    let p: u8 = 1;
    let f: u8 = 1;
    let f: u8 = 2;
    let g: u8 = "text";
    { let f: u8 = 3; }
    let h: u8 = 4;
    let q: u8 = missing;
    let r: ptr<u8> = 1;
}
`,
  'statement refusals': `let mut g: u8;
fn run() {
    #[unroll]
    g = 1;
    #[inline]
    while 1 {}
    1 + 2;
    g;
    x.y = 1;
    g[0]++;
    1++;
    for (g = 0; g < 3; g++) {}
    for (1; 2; 3) {}
    for (let mut i: u8 = 0; i < 3; i++) { x.y = 1; }
    #[unroll]
    for (let mut i: u8 = 0; i < 3; i++) {}
    #[unroll(2)]
    for (let mut i: u8 = 0; i < 3; i++) {}
    #[other]
    for (let mut i: u8 = 0; i < 3; i++) {}
    #[inline]
    let z: u8 = 1;
    match g { 1 => {} _ => {} }
}
`,
  'assignment refusals': `const C: u8 = 1;
const S: string = "s";
let mut arr: [u8; 2];
let mut buf: string<4>;
const FIXED: [u8; 2] = [1, 2];
let mut g: u8;
fn run(p: u8, s: string) {
    arr = 1;
    S = "t";
    g = "text";
    p = "text";
    buf = "toolong";
    buf = "ok";
    buf = s;
    buf += "x";
    arr[5] = 1;
    arr[0] = "x";
    FIXED[0] = 1;
    FIXED[1]++;
    g[0] = 1;
    p[0] = 1;
    s[0] = 1;
    imported[0] = 1;
    arr[g] += 2;
    g = 1 + "x";
    C = 2;
}
`,
  'port forms': `let mut g: u8;
fn run() {
    port::read(3);
    g = port::write(1, 2);
    port::write(1, 2);
}
`,
  'string member refusal': `fn run(s: string) -> u8 {
    return s.size;
}
`,
  'string work': `const GREETING: string = "HI";
let mut buf: string<8>;
fn show(s: string) -> u8 { return s.length + s[0]; }
fn run() {
    show("abc");
    show(GREETING);
    buf = "hello";
    show(buf);
    text::print(0, 0, \`x \${buf}\`);
}
`,
  scoping: `let mut g: u8 = 1;
fn run(g: u8) {
    let a: u8 = g;
    if a { let a: u8 = 2; g = a; }
    for (let mut i: u8 = 0; i < 2; i++) { let a: u8 = i; }
    while g { let a: u8 = 3; g--; }
    g = a;
}
fn after() { g = 2; }
`,
  'namespace members': `mod screen {
    pub const BLACK: u8 = 0;
    pub fn setBorderColor(c: u8 = BLACK) {
        memory::write($D020, c);
    }
    fn hidden() {}
}
fn run() {
    screen::setBorderColor(1);
}
`,
  'arity refusals': `fn two(a: u8, b: u8 = 1) {}
fn one(a: u8) {}
fn run() {
    two();
    two(1, 2, 3);
    one();
    one(1, 2);
    one(1);
}
`,
  'global initializers with calls': `fn f() -> u8 { return 1; }
let a: u8 = f();
let b: u8 = memory::read(1);
let c: u8 = waitFrame();
let d: u8 = 5;
`,
  'holes in bodies': `fn run() {
    while  { }
    if  { }
    for (let mut i: u8 = 0; ; ) { break; }
    let = 1;
}
`,
  'exports and unit functions': `pub fn main() { helper(); }
fn helper() {}
pub fn shown() {}
`,
};

const rows = [];
for (const [key, text] of Object.entries(sources)) {
  const file = `${key.replaceAll(' ', '-')}.8bs`;
  const { tokens } = tokenize(text, file, { sourceKind: '.8bs' });
  const { ast } = parse(tokens, text, file, { sourceKind: '.8bs' });
  lower(ast, file, text);
  for (const row of take()) {
    const { seq, ...rest } = row;
    rows.push({ name: key, ...rest });
  }
}
// An elaborated function: the props the 8BX elaborator sets, which no source text spells.
{
  const text = `let count: u8;
fn tick() { count++; }
fn other() { tick(); }
`;
  const { tokens } = tokenize(text, 'e.8bs', { sourceKind: '.8bs' });
  const { ast } = parse(tokens, text, 'e.8bs', { sourceKind: '.8bs' });
  const [first, second] = ast.body.filter((n) => n.type === 'FunctionDeclaration');
  first.component = true;
  first.owner = 'Counter';
  first.method = true;
  first.state = [{ field: 'count', global: 'Counter_count' }];
  second.body.body[0].expression.instance = 'e.8bs#1';
  lower(ast, 'e.8bs', text);
  for (const row of take()) {
    const { seq, ...rest } = row;
    rows.push({ name: 'elaborated function', ...rest });
  }
}

writeFileSync(fileURLToPath(new URL('../fixtures/ir-function.json', import.meta.url)), `${JSON.stringify(rows)}\n`);
rmSync(dir, { recursive: true, force: true });
console.log(`wrote ${rows.length} rows`);
