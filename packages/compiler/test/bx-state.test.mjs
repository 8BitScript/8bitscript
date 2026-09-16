// Component state (spec §36–§37, §62, §103): storage per static instance,
// laid out at compile time, visible in the size report.
import assert from 'node:assert/strict';
import test from 'node:test';

import { Codes, analyze } from '../index.mjs';
import { optimizeReachable } from '../src/linker/optimize.mjs';
import { linkFiles as linkShared } from './support/link-files.mjs';

const linkFiles = (files, entry, options = {}) => linkShared(files, entry, { bx: { strict: false }, ...options });

/** Every call by name anywhere in a lowered function body. */
function callsIn(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) callsIn(n, out); return out; }
  if (node && typeof node === 'object') {
    if (node.kind === 'call' && typeof node.name === 'string') out.push(node.name);
    for (const v of Object.values(node)) callsIn(v, out);
  }
  return out;
}

/** Every global name a body reads or writes. */
function namesIn(node, out = new Set()) {
  if (Array.isArray(node)) { for (const n of node) namesIn(n, out); return out; }
  if (node && typeof node === 'object') {
    if (node.kind === 'ref' && typeof node.name === 'string') out.add(node.name);
    if (node.kind === 'assign' && typeof node.target === 'string') out.add(node.target);
    for (const v of Object.values(node)) namesIn(v, out);
  }
  return out;
}

const COUNTER = `component Counter(step: utinyint) {
    state count: utinyint = 0;
    count = count + step;
    memory.write(0x8000, count);
}
`;

test('two elements are two instances: two functions, two globals, nothing shared', () => {
  const main = `${COUNTER}export function main(): void {
    <Counter step={1} />;
    <Counter step={2} />;
}
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body), ['Counter__i1', 'Counter__i2']);
  const one = ir.functions.find((f) => f.name === 'Counter__i1');
  const two = ir.functions.find((f) => f.name === 'Counter__i2');
  assert.ok(namesIn(one.body).has('__bx_Counter__count__i1'));
  assert.ok(namesIn(two.body).has('__bx_Counter__count__i2'));
  assert.ok(!namesIn(one.body).has('__bx_Counter__count__i2'), 'no instance touches the other\'s storage');
  // The template is gone from the program; each instance's storage is a
  // global initialized as the declaration said.
  assert.ok(!ir.functions.some((f) => f.name === 'Counter'));
  assert.deepEqual(ir.globals.map((g) => [g.name, g.init, g.type]), [
    ['__bx_Counter__count__i1', 0, 'utinyint'], ['__bx_Counter__count__i2', 0, 'utinyint'],
  ]);
  assert.equal(ir.memory.variables, 2, 'two bytes of RAM, one per instance');
  assert.deepEqual(ir.instances, [{ component: 'Counter', instance: 'i1', bytes: 1 }, { component: 'Counter', instance: 'i2', bytes: 1 }]);
  // And with compile-time props, each instance is inlined at its site: the
  // program is two straight-line updates of two bytes.
  const optimized = optimizeReachable(ir);
  assert.deepEqual(optimized.functions.map((f) => f.name), [ir.entry]);
  assert.deepEqual(optimized.globals.map((g) => g.name), ['__bx_Counter__count__i1', '__bx_Counter__count__i2']);
});

test('the two halves of a slotted component share one instance\'s state', () => {
  const main = `component Frame() {
    state depth: utinyint = 0;
    depth = depth + 1;
    <slot />;
    depth = depth - 1;
}
component Dot() { memory.write(0x8000, 1); }
export function main(): void { <Frame><Dot /></Frame>; <Frame><Dot /></Frame>; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body), ['Frame__open__i1', 'Dot', 'Frame__close__i1', 'Frame__open__i2', 'Dot', 'Frame__close__i2']);
  const open1 = ir.functions.find((f) => f.name === 'Frame__open__i1');
  const close1 = ir.functions.find((f) => f.name === 'Frame__close__i1');
  assert.ok(namesIn(open1.body).has('__bx_Frame__depth__i1') && namesIn(close1.body).has('__bx_Frame__depth__i1'), 'one global for both halves');
  assert.equal(ir.globals.length, 2, 'one byte of state per element, not per half');
});

test('a stateful component imported from another module gets its instances in the importer', () => {
  const files = {
    'Counter.8bx': `export ${COUNTER}`,
    'main.8bx': `import { Counter } from "./Counter.8bx";
export function main(): void { <Counter step={1} />; <Counter step={1} />; }
`,
  };
  const { ir, diagnostics } = linkFiles(files, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body), ['Counter__i1', 'Counter__i2']);
  assert.equal(ir.globals.length, 2);
});

test('an instance inside a component instantiated twice is two instances (§103)', () => {
  const main = `component Tally() {
    state n: utinyint = 0;
    n = n + 1;
    memory.write(0x8000, n);
}
component Pair() { <Tally />; <Tally />; }
export function main(): void { <Pair />; <Pair />; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const tallies = ir.globals.map((g) => g.name).filter((n) => n.startsWith('__bx_Tally__n'));
  assert.equal(tallies.length, 4, 'two Pairs, each with two Tallies');
  assert.equal(ir.instances.filter((i) => i.component === 'Tally').length, 4);
  assert.ok(!ir.instances.some((i) => i.component === 'Pair'), 'a container with no storage is not a line in the report');
});

test('an ordinary function holding instances is one piece of code: its instances are shared by every caller', () => {
  const main = `component Tally() {
    state n: utinyint = 0;
    n = n + 1;
    memory.write(0x8000, n);
}
function step(): void { <Tally />; }
export function main(): void { step(); step(); }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  assert.equal(ir.globals.length, 1, 'one tally, counted twice');
  assert.ok(ir.functions.some((f) => f.name === 'step'), 'step is not cloned');
});

test('a call from .8bs is an instance per call site (§4.5, §62)', () => {
  const files = {
    'Counter.8bx': `export ${COUNTER}`,
    'main.8bs': `import { Counter } from "./Counter.8bx";
export function main(): void { Counter(1); Counter(2); }
`,
  };
  const { ir, diagnostics } = linkFiles(files, 'main.8bs');
  assert.deepEqual(diagnostics, []);
  assert.equal(ir.globals.length, 2);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body), ['Counter__i1', 'Counter__i2']);
});

test('state out of place, untyped, doubled, or shadowed is 8BS2022; `state` in .8bs is just a name', () => {
  const codes = (src) => analyze(src, 't.8bx', { sourceKind: '.8bx' }).filter((d) => d.code === Codes.BX_INVALID_STATE).map((d) => d.message);
  assert.match(codes('state x: utinyint = 0;\nexport function main(): void { }\n')[0], /top level of a component/);
  assert.match(codes('component A() { if (true) { state x: utinyint = 0; } }\nexport function main(): void { }\n')[0], /top level of a component/);
  assert.match(codes('component A() { state x = 0; }\nexport function main(): void { }\n')[0], /needs a type/);
  assert.match(codes('component A() { state x: utinyint = 0; state x: utinyint = 1; }\nexport function main(): void { }\n')[0], /declared twice/);
  assert.match(codes('component A(x: utinyint) { state x: utinyint = 0; }\nexport function main(): void { }\n')[0], /same name as a prop/);
  assert.match(codes('component A() { state x: utinyint = 0; let x: utinyint = 1; }\nexport function main(): void { }\n')[0], /a local cannot take its name/);
  assert.deepEqual(analyze('let state: utinyint = 1;\nexport function main(): void { state = 2; }\n', 't.8bs'), []);
});

test('a state initializer must be a literal or a const, like any global\'s', () => {
  const main = `function seed(): utinyint { return 3; }
component A() { state x: utinyint = seed(); memory.write(0x8000, x); }
export function main(): void { <A />; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.equal(ir, null);
  assert.ok(diagnostics.some((d) => /initializer|literal|const/.test(d.message)), JSON.stringify(diagnostics));
});
