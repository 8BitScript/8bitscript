// Component methods (spec §39): ordinary functions of the component that
// work on the instance's state, instanced with it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { Codes, analyze } from '../index.mjs';
import { optimizeReachable } from '../src/linker/optimize.mjs';
import { linkFiles as linkShared } from './support/link-files.mjs';

const linkFiles = (files, entry, options = {}) => linkShared(files, entry, { bx: { strict: false }, ...options });

function callsIn(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) callsIn(n, out); return out; }
  if (node && typeof node === 'object') {
    if (node.kind === 'call' && typeof node.name === 'string') out.push(node.name);
    for (const v of Object.values(node)) callsIn(v, out);
  }
  return out;
}
function namesIn(node, out = new Set()) {
  if (Array.isArray(node)) { for (const n of node) namesIn(n, out); return out; }
  if (node && typeof node === 'object') {
    if (node.kind === 'ref' && typeof node.name === 'string') out.add(node.name);
    if (node.kind === 'assign' && typeof node.target === 'string') out.add(node.target);
    for (const v of Object.values(node)) namesIn(v, out);
  }
  return out;
}

const PLAYER = `component Player() {
    state health: utinyint = 100;
    function damage(amount: utinyint): void { health = health - amount; }
    function heal(): void { damage(0); health = health + 1; }
    damage(5);
    heal();
    memory.write(0x8000, health);
}
`;

test('a method is a function of the component, called by its hoisted name, on the instance\'s own state', () => {
  const { ir, diagnostics } = linkFiles({ 'main.8bx': `${PLAYER}export function main(): void { <Player />; <Player />; }\n` }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const one = ir.functions.find((f) => f.name === 'Player__i1');
  assert.deepEqual(callsIn(one.body), ['Player__damage__i1', 'Player__heal__i1']);
  const heal1 = ir.functions.find((f) => f.name === 'Player__heal__i1');
  assert.deepEqual(callsIn(heal1.body), ['Player__damage__i1'], 'a method calling a method stays in the instance');
  const damage2 = ir.functions.find((f) => f.name === 'Player__damage__i2');
  assert.ok(namesIn(damage2.body).has('__bx_Player__health__i2'));
  assert.ok(!namesIn(damage2.body).has('__bx_Player__health__i1'));
  assert.equal(ir.globals.length, 2, 'two instances, two bytes');
  // The template method is gone with the template component.
  assert.ok(!ir.functions.some((f) => f.name === 'Player__damage'));
  // Compile-time arguments: the whole thing inlines to the instance bytes.
  const optimized = optimizeReachable(ir);
  assert.deepEqual(optimized.functions.map((f) => f.name), [ir.entry]);
});

test('a method of a slotted component runs on the instance both halves share', () => {
  const main = `component Frame() {
    state depth: utinyint = 0;
    function enter(): void { depth = depth + 1; }
    function leave(): void { depth = depth - 1; }
    enter();
    <slot />;
    leave();
}
component Dot() { memory.write(0x8000, 1); }
export function main(): void { <Frame><Dot /></Frame>; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  assert.deepEqual(callsIn(entry.body), ['Frame__open__i1', 'Dot', 'Frame__close__i1']);
  const enter = ir.functions.find((f) => f.name === 'Frame__enter__i1');
  const leave = ir.functions.find((f) => f.name === 'Frame__leave__i1');
  assert.ok(namesIn(enter.body).has('__bx_Frame__depth__i1') && namesIn(leave.body).has('__bx_Frame__depth__i1'));
});

test('methods cross modules with their component', () => {
  const files = {
    'Player.8bx': `export ${PLAYER}`,
    'main.8bx': 'import { Player } from "./Player.8bx";\nexport function main(): void { <Player />; }\n',
  };
  const { ir, diagnostics } = linkFiles(files, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  assert.ok(ir.functions.some((f) => f.name === 'Player__damage__i1'));
});

test('a method sees state, not props; and a method\'s name is its own (8BS2025)', () => {
  const codes = (src) => analyze(src, 't.8bx', { sourceKind: '.8bx' }).filter((d) => d.code === Codes.BX_INVALID_METHOD).map((d) => d.message);
  assert.match(codes('component A(x: utinyint) { function f(): void { memory.write(0x8000, x); } f(); }\nexport function main(): void { }\n')[0], /'x' is a prop of 'A'; a method sees state, not props — pass it as an argument/);
  assert.deepEqual(codes('component A(x: utinyint) { function f(x: utinyint): void { memory.write(0x8000, x); } f(x); }\nexport function main(): void { }\n'), [], 'its own parameter shadows the prop');
  assert.deepEqual(codes('component A(x: utinyint) { function f(): void { let x: utinyint = 1; memory.write(0x8000, x); } f(); }\nexport function main(): void { }\n'), [], 'its own local shadows the prop');
  assert.match(codes('component A() { state f: utinyint = 0; function f(): void { } }\nexport function main(): void { }\n')[0], /takes the name of a prop or state/);
  assert.match(codes('component A() { function f(): void { } function f(): void { } }\nexport function main(): void { }\n')[0], /declared twice/);
});

test('half-typed components and methods analyze without a throw and without a false report', () => {
  for (const src of [
    'component A()',
    'component A() {',
    'component A() { function',
    'component A() { function (): void { } }',
    'component A() { function f( }',
    'component A() { function f(): void }',
    'component A() { state x: utinyint = 0; function f(): void { x = 1; } f(); }',
    'component A(p: utinyint) { function f(): void { } ; f(); }',
    'export component',
  ]) {
    let diags;
    assert.doesNotThrow(() => { diags = analyze(src, 't.8bx', { sourceKind: '.8bx' }); }, src);
    assert.ok(!diags.some((d) => d.code === Codes.BX_INVALID_METHOD), `${src}: ${JSON.stringify(diags)}`);
  }
  // A method with nothing to do, in a component with props it never names, is fine.
  assert.deepEqual(analyze('component A(p: utinyint) { function f(): void { } f(); memory.write(0x8000, p); }\nexport function main(): void { <A p={1} />; }\n', 't.8bx', { sourceKind: '.8bx' }), []);
});

test('a component with methods but no state still instances its methods per element', () => {
  const main = `component Beep(tone: utinyint) {
    function play(): void { memory.write(0x8000, 1); }
    play();
}
export function main(): void { <Beep tone={1} />; <Beep tone={2} />; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  // No state, so no instancing: one Beep, one Beep__play, called twice.
  assert.deepEqual(ir.functions.map((f) => f.name).sort(), ['Beep', 'Beep__play', 'main']);
  assert.deepEqual(ir.globals, []);
});
