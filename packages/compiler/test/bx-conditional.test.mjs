// Conditional composition (spec §48–§50, §94, §96): an arm of `? :` or the
// right of `&&` between tags is a composition, a compile-time test drops
// the arm that cannot run, and an element anywhere a value is expected is
// refused.
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

const AB = `component A() { memory.write(0x8000, 1); }
component B() { memory.write(0x8000, 2); }
component Box() { <slot />; }
`;

test('{cond ? <A /> : <B />} is an if with an arm each; {cond && <A />} an if with one (§50)', () => {
  const main = `${AB}let paused: bool = false;
export function main(): void {
    paused = true;
    <Box>{paused ? <A /> : <B />}{paused && <A />}</Box>;
}
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  const ifs = entry.body.filter((s) => s.kind === 'if');
  assert.equal(ifs.length, 2);
  assert.deepEqual(callsIn(ifs[0].then), ['A']);
  assert.deepEqual(callsIn(ifs[0].else), ['B']);
  assert.deepEqual(callsIn(ifs[1].then), ['A']);
  assert.equal(ifs[1].else?.length ?? 0, 0);
  assert.deepEqual(callsIn(entry.body).slice(0, 1), ['Box__open'], 'inside the slot, in order');
});

test('a compile-time test keeps one arm and the other component is gone from the program (§49)', () => {
  const main = `${AB}const SPRITES: utinyint = 0;
export function main(): void {
    <>{SPRITES > 0 ? <A /> : <B />}</>;
}
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const optimized = optimizeReachable(ir);
  const entry = optimized.functions.find((f) => f.name === ir.entry);
  assert.ok(!entry.body.some((s) => s.kind === 'if'), 'the if folded away');
  assert.ok(!optimized.functions.some((f) => f.name === 'A'), 'A is not in the program');
  const inlined = entry.body.find((s) => s.kind === 'block' && s.origin === 'B');
  assert.ok(inlined, 'B is inlined in place');
});

test('arms nest, and may be fragments', () => {
  const main = `${AB}let mode: utinyint = 0;
export function main(): void {
    mode = mode + 1;
    <>{mode == 0 ? <A /> : mode == 1 ? <><A /><B /></> : <B />}</>;
}
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const entry = ir.functions.find((f) => f.name === ir.entry);
  const outer = entry.body.find((s) => s.kind === 'if');
  assert.deepEqual(callsIn(outer.then), ['A']);
  const inner = outer.else.find((s) => s.kind === 'if');
  assert.deepEqual(callsIn(inner.then), ['A', 'B']);
  assert.deepEqual(callsIn(inner.else), ['B']);
});

test('return (<…/>) in a component composes where it stands (§23, §96)', () => {
  const main = `${AB}component Screen(on: bool) {
    return (<>{on ? <A /> : <B />}</>);
}
export function main(): void { <Screen on={true} />; }
`;
  const { ir, diagnostics } = linkFiles({ 'main.8bx': main }, 'main.8bx');
  assert.deepEqual(diagnostics, []);
  const screen = ir.functions.find((f) => f.name === 'Screen');
  assert.ok(screen.body.some((s) => s.kind === 'if'));
  assert.ok(!screen.body.some((s) => s.kind === 'return'));
});

test('a composition is not a value (§94), and a bare value between tags is not a child yet (§20)', () => {
  const codes = (src) => analyze(`${AB}${src}`, 't.8bx', { sourceKind: '.8bx' }).filter((d) => d.code === Codes.BX_NOT_A_VALUE || d.code === Codes.BX_EXPRESSION_CHILD).map((d) => `${d.code}:${d.message.split(':')[0].slice(0, 20)}`);
  assert.deepEqual(codes('export function main(): void { let x: utinyint = <A />; }\n'), ['8BS2024:a composition is not']);
  assert.deepEqual(codes('function f(v: utinyint): void { }\nexport function main(): void { f(<A />); }\n'), ['8BS2024:a composition is not']);
  assert.deepEqual(codes('export function main(): void { <Box>{1 + 1}</Box>; }\n'), ['8BS2023:an expression betwee']);
  assert.deepEqual(codes('let s: utinyint = 0;\nexport function main(): void { <Box>{s}</Box>; }\n'), ['8BS2023:an expression betwee']);
  // A composition-shaped expression outside a composing place is a value too.
  assert.deepEqual(codes('let c: bool = true;\nexport function main(): void { let x: utinyint = c ? <A /> : <B />; }\n'), ['8BS2024:a composition is not', '8BS2024:a composition is not']);
  // And these are fine: statement, child, arms, &&, return.
  assert.deepEqual(codes('let c: bool = true;\nexport function main(): void { <A />; if (c) <B />; <Box>{c ? <A /> : <B />}{c && <A />}</Box>; }\n'), []);
});
