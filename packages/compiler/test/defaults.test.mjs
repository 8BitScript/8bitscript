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
import { emitC } from '../../backend-6502/src/index.mjs';
import { emitAssemblyScript } from '../../backend-web/src/index.mjs';

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
  const { ir, diagnostics } = lowered('const SEVEN: utinyint = 7;\nfunction f(a: utinyint, b: utinyint = SEVEN, c: bool = true, s: string = "HI"): void { }\nexport function main(): void { }');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.functions[0].params.map((p) => [p.name, p.default]), [
    ['a', undefined], ['b', { kind: 'const', value: 7 }], ['c', { kind: 'const', value: 1 }],
    ['s', { kind: 'string', index: 0, start: 100, length: 4 }],
  ]);
});

test('a default is a literal or a const; it fits the type; every parameter after one with a default has one', () => {
  assert.match(messages('let g: utinyint = 0;\nfunction f(a: utinyint = g): void { }\nexport function main(): void { }')[0], /a parameter default is a literal or a const/);
  assert.deepEqual(messages('function f(a: utinyint = 300): void { }\nexport function main(): void { }'), ['8BS1021 300 does not fit in utinyint (0..255)']);
  assert.match(messages('function f(a: utinyint = 1, b: utinyint): void { }\nexport function main(): void { }')[0], /'b' needs a default: every parameter after one with a default has one/);
  assert.match(messages('function f(s: string = 5): void { }\nexport function main(): void { }')[0], /a string parameter's default is a string literal or a string const/);
});

test("a call to the module's own function is checked as it is typed: 8BS1035 names the count it takes", () => {
  const d = analyze('function f(a: utinyint, b: utinyint = 2): void { }\nfunction g(): void { }\nexport function main(): void { f(); f(1, 2, 3); f(1); f(1, 2); g(1); }', 't.8bs');
  assert.deepEqual(d.map((x) => `${x.code} ${x.message}`), [
    "8BS1035 'f' takes 1 to 2 arguments, not 0",
    "8BS1035 'f' takes 1 to 2 arguments, not 3",
    "8BS1035 'g' takes 0 arguments, not 1",
  ]);
  clean('function f(a: utinyint, b: utinyint = 2): void { }\nexport function main(): void { f(1); f(1, 2); }');
});

test('the linker fills in every argument left off, from its own module, an import, or a namespace', async () => {
  const { ir, diagnostics } = await linkWith({
    'lib.8bs': 'export namespace BorderColor { const BLACK: utinyint = 0; const KEEP: utinyint = 255; }\nexport const TWO: utinyint = 2;\nexport namespace screen {\n function blank(border: utinyint = BorderColor.BLACK, background: utinyint = TWO): void { }\n}\nexport function f(a: utinyint, b: utinyint = 7, s: string = "HI"): utinyint { return a + b + s.length; }\n',
    'main.8bs': 'import { screen, BorderColor, f } from "./lib.8bs";\nlet n: utinyint = 0;\nexport function main(): void { screen.blank(); screen.blank(BorderColor.KEEP); screen.blank(1, 2); n = f(1); n = f(1, 2, "YO"); }\n',
  });
  assert.deepEqual(diagnostics, []);
  const c = emitC(ir, { machine: 'c64' });
  assert.match(c, /screen_blank\(0, 2\);\n\s+screen_blank\(255, 2\);\n\s+screen_blank\(1, 2\);/);
  // The entry module's strings come first in the program table: "YO" is
  // slot 0, the library's "HI" default is slot 1 — rebased by its own module.
  assert.match(c, /n = f\(1, 7, __8bs_str_1\);/, 'the string default is the slot in the program table');
  assert.match(c, /n = f\(1, 2, __8bs_str_0\);/);
  const as = emitAssemblyScript(ir);
  assert.ok(as.ok, as.error);
  assert.match(as.source, /screen_blank\(<u8>0, <u8>2\);/);
});

test('a call to the module\'s own function is filled in too, so the C compiler sees a complete call', async () => {
  const { ir, diagnostics } = await linkWith({
    'main.8bs': 'let n: utinyint = 0;\nfunction f(a: utinyint, b: utinyint = 7): utinyint { return a + b; }\nexport function main(): void { n = f(1); n = f(1, 2); }\n',
  });
  assert.deepEqual(diagnostics, []);
  const c = emitC(ir, { machine: 'c64' });
  assert.match(c, /n = f\(1, 7\);/, 'the default is filled in for a same-file call');
  assert.match(c, /n = f\(1, 2\);/);
  const as = emitAssemblyScript(ir);
  assert.ok(as.ok, as.error);
  assert.match(as.source, /f\(<u8>1, <u8>7\)/);
});

test('the linker checks the count of a call across modules, and a default that does not fit', async () => {
  const bad = await linkWith({
    'lib.8bs': 'export function f(a: utinyint, b: utinyint = 7): void { }\nexport namespace ns { function g(x: utinyint): void { } }\n',
    'main.8bs': 'import { f, ns } from "./lib.8bs";\nexport function main(): void { f(); f(1, 2, 3); ns.g(); ns.g(1, 2); }\n',
  });
  assert.deepEqual(bad.diagnostics.map((d) => `${d.code} ${d.message}`), [
    "8BS1035 'f' takes 1 to 2 arguments, not 0",
    "8BS1035 'f' takes 1 to 2 arguments, not 3",
    "8BS1035 'ns.g' takes 1 argument, not 0",
    "8BS1035 'ns.g' takes 1 argument, not 2",
  ]);
  const range = await linkWith({
    'lib.8bs': 'export const BIG: usmallint = 300;\n',
    'main.8bs': 'import { BIG } from "./lib.8bs";\nfunction f(a: utinyint = BIG): void { }\nexport function main(): void { f(); }\n',
  });
  assert.deepEqual(range.diagnostics.map((d) => d.code), ['8BS1021']);
});

test('a template print still links: the two-argument protocol has no defaults to fill', async () => {
  const { diagnostics } = await linkWith({
    'text.8bs': 'export namespace text {\n function print(cell: usmallint, s: string): void { }\n function printNumber(cell: usmallint, value: usmallint, width: utinyint): void { }\n}\n',
    'main.8bs': 'import { text } from "./text.8bs";\nlet n: utinyint = 3;\nexport function main(): void { text.print(0, `N ${n}`); }\n',
  });
  assert.deepEqual(diagnostics, []);
});
