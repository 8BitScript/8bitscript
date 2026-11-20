// Regenerates fixtures/binder.json from packages/compiler/src/binder (the JS oracle).
// Run from the repo root: node crates/sema/tests/gen/binder.mjs
//
// Each row is a tap record (`{fn, args, result, after?}`, scripts/oracle/front-tap): the real
// functions run through the front tap's wrappers and the rows are read back from its output, so
// the encoding of scopes and symbols is the one `xtask tap --front` replays.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, tokenize } from '../../../../packages/compiler/src/front/index.mjs';
import { componentOf, resolveSymbol } from '../../../../packages/compiler/src/binder/index.mjs';
import { tapped } from '../../../../scripts/oracle/front-tap/tap.mjs';

const dir = mkdtempSync(join(tmpdir(), 'binder-gen-'));
process.env.EIGHTBS_FRONT_TAP = dir;
delete process.env.EIGHTBS_FRONT_TAP_ROOTS;
// The shim is what the tap loads in place of the binder: it records `bind` and the import linker.
const { bind, bindImportedComponents } = await import('../../../../scripts/oracle/front-tap/shims/binder.mjs');
const resolveSymbolTapped = tapped('resolveSymbol', resolveSymbol);
const componentOfTapped = tapped('componentOf', componentOf);

const log = join(dir, '0.jsonl');
function take(name) {
  const rows = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  if (existsSync(log)) rmSync(log);
  return rows.map(({ seq, ...row }) => ({ name, ...row }));
}

const rows = [];
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

function astOf(text, file) {
  const kind = extname(file);
  const { tokens } = tokenize(text, file, { sourceKind: kind });
  return parse(tokens, text, file, { sourceKind: kind }).ast;
}

/** Bind `text` and record the `bind` call. */
function bound(name, text, file = 'a.8bs') {
  const ast = astOf(text, file);
  const result = bind(ast, file);
  rows.push(...take(name));
  return { ast, result };
}

// --- bind: every statement kind, duplicates, nested blocks, `use ... as`, components ----------

const sources = {
  'use-as': `use "./lib.8bs"::{a, b as c, d as d};
use "./other.8bs"::z;
`,
  'every-statement': `use "./lib.8bs"::{helper as h};
let x = 1;
let mut y: u8 = 2;
const K: u8 = 3;
pub let mut shown: u8;
pub const PUB: u8 = 4;
fn plain() {}
pub fn exported(a: u8, b: u8 = 3) -> u8 {
    let local = a;
    { let inner = b; { let deeper = inner; } }
    if a == 0 { let t = 1; } else if a == 1 { let e1 = 2; } else { let e2 = 3; }
    while a > 0 { let w = a; a -= 1; }
    for i in 0..10 { let f = i; }
    for (let mut k: u8 = 9; k > 0; k -= 1) { let g = k; }
    for (;;) { break; }
    loop { continue; }
    asm6502 { nop }
    return local;
}
pub mod Color {
    const RED: u8 = 2;
    pub fn paint(c: u8) { shown = c; }
    let mut shade: u8 = 0;
    mod Inner { const DEEP: u8 = 1; }
}
mod empty {}
`,
  'duplicates': `let a = 1;
let a = 2;
const a: u8 = 3;
fn a() {}
fn f(x: u8, x: u16, y: u8) { let x = 1; let y = 2; { let x = 3; let x = 4; } }
mod M { let q = 1; let q = 2; fn q() {} }
mod M { let r = 1; }
use "./lib.8bs"::{a, c as a};
`,
  'nested': `let top = 1;
fn outer(p: u8) {
    let o1 = 1;
    { let b1 = 2; { let b2 = 3; { let b3 = 4; } let b2b = 5; } let b1b = 6; }
    if p == 1 { let i1 = 1; { let i2 = 2; } }
    for i in 0..3 { for j in 0..3 { let ij = i; } }
    while p > 0 { if p == 2 { let wi = 1; } p -= 1; }
}
mod N { mod O { fn deep(a: u8) { { let d = a; } } } }
`,
  'empty': '',
  'exprs-and-others': `let a = 1 + 2;
fn main() { a = 3; a += 1; return; }
asm6502 { rts }
;
`,
};
for (const [name, text] of Object.entries(sources)) bound(`bind ${name}`, text);

// Components: props typed, defaulted and optional-looking, state at top level and nested, slot.
const bx = {
  'component-state': `use "./lib.8bx"::{Other as O};
pub component Menu(title: u8, count: u8 = 3,) {
    state selected: u8 = 0;
    state done: bool;
    let x = 1;
    fn helper() {}
    selected += 1;
    if x == 1 { state nested: u8 = 1; }
    <O />
}
component Plain() {}
component Both(a: u8, b: u8 = 1) { state s = 2; let s2 = s; }
component Frame(title: u8) {
    <slot />
}
component Dup(a: u8, a: u16) { state z: u8; state z: u16; }
component Dup() {}
`,
  'bx-nested-in-namespace': `mod Ui { pub component Inner(n: u8) { state k: u8 = 0; } component Hidden() {} }
`,
};
for (const [name, text] of Object.entries(bx)) bound(`bind ${name}`, text, 'a.8bx');

// Every file of the parser corpus: error recovery leaves null names, missing bodies, odd members.
const corpus = fileURLToPath(new URL('../../../parser/tests/corpus/', import.meta.url));
for (const file of readdirSync(corpus).sort()) {
  if (!file.endsWith('.8bs') && !file.endsWith('.8bx')) continue;
  bound(`bind corpus ${file}`, readFileSync(join(corpus, file), 'utf8'), file);
}

// A tree that is not a Program binds nothing, and the file name defaults.
{
  const block = { type: 'BlockStatement', start: 0, length: 0, body: [] };
  bind(block);
  rows.push(...take('bind not a program'));
}

// --- bindImports over two modules --------------------------------------------------------

const lib = bound('lib', `pub fn f() {}
pub const K: u8 = 1;
pub let mut V: u8;
pub mod M { pub fn g() {} }
let hidden = 1;
fn hiddenFn() {}
pub component Menu(title: u8) { state s: u8 = 0; }
component Private() {}
pub component Frame() { <slot /> }
`, 'lib.8bx');

function link(name, main, others, mainFile = 'main.8bx') {
  const lookup = (source) => others[source] ?? null;
  const target = bound(`link ${name}: bind`, main, mainFile).result;
  bindImportedComponents(target, lookup);
  rows.push(...take(`bindImportedComponents ${name}`));
  return target;
}
const libBound = lib.result;
const mainText = `use "./lib.8bx"::{Menu, Private, Missing, K, f as ff, M, V, hidden, hiddenFn, Frame};
pub component App() { <Menu /> <Private /> <Frame /> }
`;
const linked = link('component, fn, const, namespace, hidden, missing, alias', mainText, { './lib.8bx': libBound });
link('unresolved import', mainText, {});
link('lookup answers null for one source', `use "./lib.8bx"::{Menu};
use "./gone.8bx"::{Gone};
`, { './lib.8bx': libBound });
link('no imports', 'fn only() {}\n', { './lib.8bx': libBound }, 'main.8bs');
link('linked twice', mainText, { './lib.8bx': libBound });
bindImportedComponents(linked, (s) => ({ './lib.8bx': libBound })[s] ?? null);
rows.push(...take('bindImportedComponents again over a linked bound'));
// A source that is an import of its own: an import is never exported, so it is not a target.
{
  const chain = bound('chain: middle', `use "./lib.8bx"::{Menu as M2};\npub fn mid() {}\n`, 'mid.8bx').result;
  bindImportedComponents(chain, (s) => ({ './lib.8bx': libBound })[s] ?? null);
  rows.push(...take('bindImportedComponents middle'));
  link('import of an import', `use "./mid.8bx"::{M2, mid};\n`, { './mid.8bx': chain });
}
// Two modules that import each other.
{
  const a = bound('cycle a', `use "./b.8bx"::{B, bf};\npub component A() {}\npub fn af() {}\n`, 'a.8bx').result;
  const b = bound('cycle b', `use "./a.8bx"::{A, af};\npub component B() {}\npub fn bf() {}\n`, 'b.8bx').result;
  const lookup = (s) => ({ './a.8bx': a, './b.8bx': b })[s] ?? null;
  bindImportedComponents(a, lookup);
  rows.push(...take('bindImportedComponents cycle a'));
  bindImportedComponents(b, lookup);
  rows.push(...take('bindImportedComponents cycle b'));
}
// Error recovery: imports with no source.
{
  const broken = bound('broken use', 'use foo::{;\nuse "./lib.8bx"::{Menu};\n', 'broken.8bx').result;
  bindImportedComponents(broken, (s) => ({ './lib.8bx': libBound })[s] ?? null);
  rows.push(...take('bindImportedComponents source missing'));
}

// --- resolveSymbol and componentOf -------------------------------------------------------

{
  const { result } = bound('resolve', `let top = 1;
const K: u8 = 2;
fn outer(p: u8) { let o1 = 1; { let b1 = 2; { let b2 = 3; } } }
mod N { const RED: u8 = 1; fn paint(c: u8) {} mod Inner { const DEEP: u8 = 1; } }
`, 'r.8bs');
  const scopes = [result.scopes[0], ...new Set(result.scopeOf.values())];
  const names = ['top', 'K', 'outer', 'p', 'o1', 'b2', 'RED', 'DEEP', 'N', 'nope', ''];
  for (const scope of scopes) {
    for (const name of names) {
      resolveSymbolTapped(scope, name);
      rows.push(...take(`resolveSymbol ${name || '(empty)'}`));
    }
  }
}
{
  // `resolveSymbol` on a scope chain that shadows: the innermost wins.
  const { result } = bound('shadow', 'let v = 1;\nfn f(v: u8) { let v = 2; { let v = 3; } }\n', 's.8bs');
  for (const scope of [result.scopes[0], ...new Set(result.scopeOf.values())]) {
    resolveSymbolTapped(scope, 'v');
    rows.push(...take('resolveSymbol shadowed'));
  }
}
{
  const symbols = [...linked.symbols.values()];
  for (const sym of symbols) {
    componentOfTapped(sym);
    rows.push(...take(`componentOf ${sym.name} (${sym.kind})`));
  }
  const own = [...libBound.symbols.values()];
  for (const sym of own) {
    componentOfTapped(sym);
    rows.push(...take(`componentOf lib ${sym.name} (${sym.kind})`));
  }
  componentOfTapped(null);
  rows.push(...take('componentOf null'));
  componentOfTapped(undefined);
  rows.push(...take('componentOf undefined'));
  // A state symbol and a parameter are not components.
  const comp = bound('state', 'component C(p: u8) { state s: u8 = 0; }\n', 'c.8bx').result;
  for (const scope of comp.scopeOf.values()) {
    for (const sym of scope.symbols.values()) {
      componentOfTapped(sym);
      rows.push(...take(`componentOf ${sym.name} (${sym.kind})`));
    }
  }
}

writeFileSync(here('../fixtures/binder.json'), `${JSON.stringify(rows)}\n`);
rmSync(dir, { recursive: true, force: true });
console.log(`wrote ${rows.length} rows`);
