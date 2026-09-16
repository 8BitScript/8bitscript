// 8BX elaboration: a component is a function in its own module, an
// element is a call to it, and the two meet across modules through the
// ordinary import machinery (bx/elaborate.mjs, binder bindImportedComponents).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Codes, analyze, link } from '../index.mjs';
import { optimizeReachable } from '../src/linker/optimize.mjs';

/** Write `files` into a scratch directory and link `entry` from there. */
function linkFiles(files, entry, options = { machine: 'pet', frameRate: 60, facts: {} }) {
  const dir = mkdtempSync(join(tmpdir(), '8bx-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return { ...link(files[entry], join(dir, entry), options), dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every call by name anywhere in a lowered function body. */
function callsIn(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) callsIn(n, out); return out; }
  if (node && typeof node === 'object') {
    if (node.kind === 'call' && typeof node.name === 'string') out.push(node.name);
    for (const v of Object.values(node)) callsIn(v, out);
  }
  return out;
}

test('a component is a function of its own name, and an element is a call to it', () => {
  const main = `component Hello() { memory.write(0x8000, 1); }
export function main(): void { <Hello />; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const hello = ir.functions.find((f) => f.name === 'Hello');
  assert.ok(hello, 'the component is a function');
  assert.equal(hello.component, true, 'marked as the component it was');
  assert.equal(hello.exported, false, 'a component without export is not exported');
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body), ['Hello']);
});

test('props are the call\'s arguments, in parameter order, defaults filled, bare attributes true', () => {
  const main = `let hits: utinyint = 0;
component Box(x: utinyint, y: utinyint, wide: bool = false, tall: bool = false) {
    if (wide) { hits = hits + x; }
    if (tall) { hits = hits + y; }
}
export function main(): void { <Box tall y={4} x={2} />; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  const call = callsIn(entry.body);
  assert.deepEqual(call, ['Box']);
  const stmt = entry.body.find((s) => s.kind === 'call');
  assert.deepEqual(stmt.args.map((a) => a.value), [2, 4, 0, 1], 'x, y, wide (default false), tall (bare: true)');
});

test('an attribute expression runs once, however often the body reads the prop (§104)', () => {
  const main = `let n: utinyint = 0;
let sum: utinyint = 0;
function next(): utinyint { n = n + 1; return n; }
component Twice(value: utinyint) { sum = sum + value; sum = sum + value; }
export function main(): void { <Twice value={next()} />; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body).sort(), ['Twice', 'next'], 'next() is an argument, evaluated once');
});

test('a component with compile-time props is inlined; one fed a run-time value stays a call (§64, §65)', () => {
  const main = `let total: utinyint = 0;
let live: utinyint = 3;
component Add(amount: utinyint) { total = total + amount; }
export function main(): void {
    live = live + 1;
    <Add amount={5} />;
    <Add amount={live} />;
}
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const optimized = optimizeReachable(ir);
  const entry = optimized.functions.find((f) => f.name === ir.entry);
  const calls = entry.body.filter((s) => s.kind === 'call').map((s) => s.name);
  assert.deepEqual(calls, ['Add'], 'the run-time-argument element is the one call left');
  const inlined = entry.body.find((s) => s.kind === 'block' && s.origin === 'Add');
  assert.ok(inlined, 'the compile-time-argument element is its body, in place');
});

test('an exported component is imported and used from another module', () => {
  const files = {
    'Hello.8bx': `export component Hello(mark: utinyint) { memory.write(0x8000, mark); }
component Private() { memory.write(0x8001, 1); }
`,
    'main.8bx': `import { Hello } from "./Hello.8bx";
export function main(): void { <Hello mark={7} />; }
`,
  };
  const { ir, diagnostics } = linkFiles(files, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body), ['Hello']);
  assert.ok(ir.functions.some((f) => f.name === 'Hello' && f.component), 'Hello is linked in from its own module');
});

test('a component that is not exported is not a component to the importer', () => {
  const files = {
    'Hello.8bx': `component Hello() { memory.write(0x8000, 1); }
`,
    'main.8bx': `import { Hello } from "./Hello.8bx";
export function main(): void { <Hello />; }
`,
  };
  const { diagnostics } = linkFiles(files, 'main.8bx');
  const unknown = diagnostics.find((d) => d.code === Codes.BX_UNKNOWN_COMPONENT);
  assert.ok(unknown, 'reported as not a component');
  assert.match(unknown.message, /imported from '\.\/Hello\.8bx', which does not export a component by that name/);
});

test('a component from a package subpath links on every machine (the menu bar wrapper)', () => {
  // The only shipped .8bx component: three elements, three menubar calls.
  const main = `import { MenuBar, MenuItem, MenuBarEnd } from "@8bitscript/ui/menubar-bx";
export function main(): void {
    <MenuBar row={0} width={40} />;
    <MenuItem label="FILE" />;
    <MenuBarEnd />;
}
`;
  // The package's own subpath is not published yet; resolve the file by path instead.
  const wrapper = join(import.meta.dirname, '..', '..', 'ui', 'src', 'menubar.8bx');
  const byPath = main.replace('@8bitscript/ui/menubar-bx', wrapper);
  for (const machine of ['pet', 'c64', 'nes', 'web']) {
    const { ir, diagnostics } = linkFiles({ 'main.8bx': byPath }, 'main.8bx', { machine, frameRate: 60, facts: {} });
    assert.deepEqual(diagnostics, [], machine);
    const entry = ir.functions.find((f) => f.name === ir.entry);
    assert.deepEqual(callsIn(entry.body), ['MenuBar', 'MenuItem', 'MenuBarEnd'], machine);
  }
});

test('analyze() checks an imported component when it may read the import, and stays quiet when it may not', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bx-analyze-'));
  try {
    writeFileSync(join(dir, 'Hello.8bx'), 'export component Hello(mark: utinyint) { memory.write(0x8000, mark); }\n');
    const main = `import { Hello } from "./Hello.8bx";
export function main(): void { <Hello mark={1} nope={2} />; }
`;
    const file = join(dir, 'main.8bx');
    const resolved = analyze(main, file, { resolveImports: true }).map((d) => d.code);
    assert.deepEqual(resolved, [Codes.BX_UNKNOWN_PROP], 'the signature came from Hello.8bx');
    const unresolved = analyze(main, file, { resolveImports: false }).map((d) => d.code);
    assert.deepEqual(unresolved, [], 'an unread import is valid but unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
