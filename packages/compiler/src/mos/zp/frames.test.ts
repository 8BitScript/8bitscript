import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectLiveParents, layoutFrames } from './frames.ts';
import type { IrFunction } from '../lower/index.ts';

const call = (name: string, args: object[] = []) => ({ kind: 'call', name, args });
const fn = (name: string, body: object[]): IrFunction => ({ name, body: body as IrFunction['body'] });
const needs = (entries: [string, number][]) => new Map(entries.map(([name, bytes]) => [name, { bytes }]));

test('siblings overlay on the same bytes; a call chain stacks — the budget is the deepest chain, not the sum', () => {
  const functions = [
    fn('main', [call('draw'), call('input')]),
    fn('draw', [call('put')]),
    fn('input', []),
    fn('put', []),
  ];
  const layout = layoutFrames(functions, 'main', needs([['main', 4], ['draw', 6], ['input', 10], ['put', 2]]), 0x10, 0x100);
  assert.equal(layout.ok, true, layout.ok ? '' : layout.error);
  if (!layout.ok) return;
  assert.equal(layout.starts.get('main'), 0x10);
  assert.equal(layout.starts.get('draw'), 0x14, "a callee starts where its caller's frame ends");
  assert.equal(layout.starts.get('input'), 0x14, 'siblings share the same bytes');
  assert.equal(layout.starts.get('put'), 0x1a, "put stacks past draw's frame, not input's shorter one");
  // floor: max(end) = max(0x14+6, 0x14+10, 0x1a+2) = 0x1e
  assert.equal(layout.floor, 0x1e);
});

test('a function with two callers starts past the DEEPER one — both can be live under it', () => {
  const functions = [
    fn('main', [call('a'), call('b')]),
    fn('a', [call('shared')]),
    fn('b', [call('shared')]),
    fn('shared', []),
  ];
  const layout = layoutFrames(functions, 'main', needs([['main', 2], ['a', 4], ['b', 12], ['shared', 2]]), 0, 0x100);
  assert.equal(layout.ok, true, layout.ok ? '' : layout.error);
  if (!layout.ok) return;
  assert.equal(layout.starts.get('shared'), 2 + 12, "past b's end, the deeper of its two callers");
});

test("a call inside another call's LATER argument counts as invoked while that callee's parameters are live", () => {
  // main's body: f(x, g()) — g runs after f's first parameter slot is
  // already written, so g's frame must sit past f's, not beside it.
  const functions = [
    fn('main', [call('f', [{ kind: 'ref', name: 'x' }, call('g')])]),
    fn('f', []),
    fn('g', []),
  ];
  const parents = collectLiveParents(functions);
  assert.ok(parents.get('g')!.has('f'), 'g gains f as a live parent');
  const layout = layoutFrames(functions, 'main', needs([['main', 2], ['f', 6], ['g', 4]]), 0, 0x100);
  assert.equal(layout.ok, true, layout.ok ? '' : layout.error);
  if (!layout.ok) return;
  assert.ok(layout.starts.get('g')! >= layout.starts.get('f')! + 6, "g's frame sits past f's whole frame");
});

test("a call in the FIRST argument earns no such edge — nothing of the callee's own is live yet", () => {
  const functions = [
    fn('main', [call('f', [call('g')])]),
    fn('f', []),
    fn('g', []),
  ];
  const parents = collectLiveParents(functions);
  assert.equal(parents.get('g')!.has('f'), false);
});

test('a function reappearing inside its own later arguments is reported as a cycle, not silently misplaced', () => {
  const functions = [
    fn('main', [call('f', [{ kind: 'const', value: 1 }, call('f', [{ kind: 'const', value: 2 }, { kind: 'const', value: 3 }])])]),
    fn('f', []),
  ];
  const layout = layoutFrames(functions, 'main', needs([['main', 2], ['f', 4]]), 0, 0x100);
  assert.equal(layout.ok, false);
  if (layout.ok) return;
  assert.match(layout.error, /cycle/);
});

test('a frame never straddles a hole — it moves wholly past it', () => {
  const functions = [fn('main', [call('f')]), fn('f', [])];
  const layout = layoutFrames(functions, 'main', needs([['main', 4], ['f', 8]]), 0xc0, 0x100, [{ start: 0xc2, end: 0xda }]);
  assert.equal(layout.ok, true, layout.ok ? '' : layout.error);
  if (!layout.ok) return;
  assert.equal(layout.starts.get('main'), 0xda, "main's own 4 bytes would straddle $C2, so the whole frame moves past $D9");
  assert.equal(layout.starts.get('f'), 0xde);
});

test('running out of the budget names the function whose frame no longer fits', () => {
  const functions = [fn('main', [call('f')]), fn('f', [])];
  const layout = layoutFrames(functions, 'main', needs([['main', 100], ['f', 100]]), 0x8e, 0x100);
  assert.equal(layout.ok, false);
  if (layout.ok) return;
  assert.match(layout.error, /out of zero page: 'f's frame needs 100 byte\(s\)/);
});
