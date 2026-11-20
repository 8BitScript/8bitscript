// Parameter defaults: `border: utinyint = BorderColor.BLACK`. A default is
// a compile-time value — a literal, a const, or a name only the linker can
// see — filled in at every call that leaves the argument off, so the
// machine always sees a complete call. The argument count is checked
// against the parameters: too many, or fewer than those without a
// default, is 8BS1035 — in lowering for a module's own functions (so the
// editor sees it), in the linker for everything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze, link, tokenize, parse, lower } from '../index.mjs';

const messages = (src) => analyze(src, 't.8bs').map((d) => `${d.code} ${d.message}`);
const clean = (src) => assert.deepEqual(messages(src), []);
const lowered = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't', src);
};

async function linkWith(files, entry = 'main.8bs') {
  const dir = await mkdtemp(join(tmpdir(), '8bs-default-'));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    return link(files[entry], join(dir, entry));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a default parses and lowers as a compile-time value on the parameter', () => {
  const { ir, diagnostics } = lowered('const SEVEN: utinyint = 7;\nfn f(a: utinyint, b: utinyint = SEVEN, c: bool = true, s: string = "HI") {\n}\npub fn main() {\n}');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.functions[0].params.map((p) => [p.name, p.default]), [
    ['a', undefined], ['b', { kind: 'const', value: 7, type: 'utinyint' }], ['c', { kind: 'const', value: 1, type: 'bool' }],
    ['s', { kind: 'string', index: 0, type: 'string', start: 94, length: 4 }],
  ]);
});

test('a default is a literal or a const; it fits the type; every parameter after one with a default has one', () => {
  assert.match(messages('let g: utinyint = 0;\nfn f(a: utinyint = g) {\n}\npub fn main() {\n}')[0], /a parameter default is a literal or a const/);
  assert.deepEqual(messages('fn f(a: utinyint = 300) {\n}\npub fn main() {\n}'), ['8BS1021 300 does not fit in utinyint (0..255)']);
  assert.match(messages('fn f(a: utinyint = 1, b: utinyint) {\n}\npub fn main() {\n}')[0], /'b' needs a default: every parameter after one with a default has one/);
  assert.match(messages('fn f(s: string = 5) {\n}\npub fn main() {\n}')[0], /a string parameter's default is a string literal or a string const/);
});

test("a call to the module's own function is checked as it is typed: 8BS1035 names the count it takes", () => {
  const d = analyze('fn f(a: utinyint, b: utinyint = 2) {\n}\nfn g() {\n}\npub fn main() {\n    f();\n    f(1, 2, 3);\n    f(1);\n    f(1, 2);\n    g(1);\n}', 't.8bs');
  assert.deepEqual(d.map((x) => `${x.code} ${x.message}`), [
    "8BS1035 'f' takes 1 to 2 arguments, not 0",
    "8BS1035 'f' takes 1 to 2 arguments, not 3",
    "8BS1035 'g' takes 0 arguments, not 1",
  ]);
  clean('fn f(a: utinyint, b: utinyint = 2) {\n}\npub fn main() {\n    f(1);\n    f(1, 2);\n}');
});

test('the linker fills in every argument left off, from its own module, an import, or a namespace', async () => {
  const { ir, diagnostics } = await linkWith({
    'lib.8bs': 'pub mod BorderColor {\n    const BLACK: utinyint = 0;\n    const KEEP: utinyint = 255;\n}\npub const TWO: utinyint = 2;\npub mod screen {\n    fn blank(border: utinyint = BorderColor::BLACK, background: utinyint = TWO) {\n    }\n}\npub fn f(a: utinyint, b: utinyint = 7, s: string = "HI") -> utinyint {\n    return a + b + s.length;\n}\n',
    'main.8bs': 'use self::lib::{screen, BorderColor, f};\nlet mut n: utinyint = 0;\npub fn main() {\n    screen::blank();\n    screen::blank(BorderColor::KEEP);\n    screen::blank(1, 2);\n    n = f(1);\n    n = f(1, 2, "YO");\n}\n',
  });
  assert.deepEqual(diagnostics, []);
  const main = ir.functions.find((f) => f.name === 'main');
  assert.deepEqual(main.body[0].args.map((a) => a.value), [0, 2]);
  assert.deepEqual(main.body[1].args.map((a) => a.value), [255, 2]);
  assert.deepEqual(main.body[2].args.map((a) => a.value), [1, 2]);
  // The entry module's strings come first in the program table: "YO" is
  // slot 0, the library's "HI" default is slot 1 — rebased by its own module.
  assert.deepEqual(main.body[3].value.args.map((a) => [a.kind, a.value ?? a.index]), [
    ['const', 1], ['const', 7], ['string', 1],
  ]);
  assert.deepEqual(main.body[4].value.args.map((a) => [a.kind, a.value ?? a.index]), [
    ['const', 1], ['const', 2], ['string', 0],
  ]);
});

test('a call to the module\'s own function is filled in too, so the call is complete', async () => {
  const { ir, diagnostics } = await linkWith({
    'main.8bs': 'let mut n: utinyint = 0;\nfn f(a: utinyint, b: utinyint = 7) -> utinyint {\n    return a + b;\n}\npub fn main() {\n    n = f(1);\n    n = f(1, 2);\n}\n',
  });
  assert.deepEqual(diagnostics, []);
  const main = ir.functions.find((f) => f.name === 'main');
  assert.deepEqual(main.body[0].value.args.map((a) => a.value), [1, 7]);
  assert.deepEqual(main.body[1].value.args.map((a) => a.value), [1, 2]);
});

test('the linker checks the count of a call across modules, and a default that does not fit', async () => {
  const bad = await linkWith({
    'lib.8bs': 'pub fn f(a: utinyint, b: utinyint = 7) {\n}\npub mod ns {\n    fn g(x: utinyint) {\n    }\n}\n',
    'main.8bs': 'use self::lib::{f, ns};\npub fn main() {\n    f();\n    f(1, 2, 3);\n    ns::g();\n    ns::g(1, 2);\n}\n',
  });
  assert.deepEqual(bad.diagnostics.map((d) => `${d.code} ${d.message}`), [
    "8BS1035 'f' takes 1 to 2 arguments, not 0",
    "8BS1035 'f' takes 1 to 2 arguments, not 3",
    "8BS1035 'ns::g' takes 1 argument, not 0",
    "8BS1035 'ns::g' takes 1 argument, not 2",
  ]);
  const range = await linkWith({
    'lib.8bs': 'pub const BIG: usmallint = 300;\n',
    'main.8bs': 'use self::lib::BIG;\nfn f(a: utinyint = BIG) {\n}\npub fn main() {\n    f();\n}\n',
  });
  assert.deepEqual(range.diagnostics.map((d) => d.code), ['8BS1021']);
});

test('a template print still links: the two-argument protocol has no defaults to fill', async () => {
  const { diagnostics } = await linkWith({
    'text.8bs': 'pub mod text {\n    fn print(cell: usmallint, s: string) {\n    }\n    fn printNumber(cell: usmallint, value: usmallint, width: utinyint) {\n    }\n}\n',
    'main.8bs': 'use self::text::text;\nlet n: utinyint = 3;\npub fn main() {\n    text::print(0, `N ${n}`);\n}\n',
  });
  assert.deepEqual(diagnostics, []);
});
