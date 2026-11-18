// Regenerates fixtures/frames.json: `collectLiveParents` and `layoutFrames`
// from `mos/zp/frames.ts`. Run from the repo root:
//   node crates/mos/tests/gen/frames.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectLiveParents, layoutFrames } from '../../../../packages/compiler/src/mos/zp/frames.ts';

const here = dirname(fileURLToPath(import.meta.url));
const call = (name, args = []) => ({ kind: 'call', name, args });
const ref = (name) => ({ kind: 'ref', name });
const konst = (value) => ({ kind: 'const', value });
const fn = (name, body) => ({ name, body });
const loc = { start: 0, length: 0 };
const needs = (entries) => entries;

const cases = [
  // The cases of zp/frames.test.ts.
  { functions: [fn('main', [call('draw'), call('input')]), fn('draw', [call('put')]), fn('input', []), fn('put', [])], entry: 'main', needs: needs([['main', 4], ['draw', 6], ['input', 10], ['put', 2]]), origin: 0x10, ceiling: 0x100 },
  { functions: [fn('main', [call('a'), call('b')]), fn('a', [call('shared')]), fn('b', [call('shared')]), fn('shared', [])], entry: 'main', needs: needs([['main', 2], ['a', 4], ['b', 12], ['shared', 2]]), origin: 0, ceiling: 0x100 },
  { functions: [fn('main', [call('f', [ref('x'), call('g')])]), fn('f', []), fn('g', [])], entry: 'main', needs: needs([['main', 2], ['f', 6], ['g', 4]]), origin: 0, ceiling: 0x100 },
  { functions: [fn('main', [call('f', [call('g')])]), fn('f', []), fn('g', [])], entry: 'main', needs: needs([['main', 2], ['f', 6], ['g', 4]]), origin: 0, ceiling: 0x100 },
  { functions: [fn('main', [call('f', [konst(1), call('f', [konst(2), konst(3)])])]), fn('f', [])], entry: 'main', needs: needs([['main', 2], ['f', 4]]), origin: 0, ceiling: 0x100 },
  { functions: [fn('main', [call('f')]), fn('f', [])], entry: 'main', needs: needs([['main', 4], ['f', 8]]), origin: 0xc0, ceiling: 0x100, holes: [{ start: 0xc2, end: 0xda }] },
  { functions: [fn('main', [call('f')]), fn('f', [])], entry: 'main', needs: needs([['main', 100], ['f', 100]]), origin: 0x8e, ceiling: 0x100 },
  // A cycle through later arguments (b appears in a's second argument, a is b's callee).
  { functions: [fn('main', [call('a', [konst(1), call('b')])]), fn('a', []), fn('b', [call('a')])], entry: 'main', needs: needs([['main', 1], ['a', 1], ['b', 1]]), origin: 0, ceiling: 0x100 },
  // A mutual cycle that also strands a function that calls into it.
  { functions: [fn('main', [call('x')]), fn('x', [call('y')]), fn('y', [call('x')]), fn('z', [call('y')])], entry: 'main', needs: needs([['main', 1], ['x', 1], ['y', 1], ['z', 1]]), origin: 0, ceiling: 0x100 },
  // Calls found inside every statement kind; unknown callees and a missing need.
  { functions: [
      fn('main', [
        { kind: 'if', test: call('c1'), then: [call('c2')], else: [call('c3')], ...loc },
        { kind: 'while', test: konst(1), body: [{ kind: 'block', origin: 'q', body: [call('c4', [konst(0), call('c5', [konst(0), call('c6')])])] }], ...loc },
        { kind: 'for', init: { kind: 'local', name: 'i', type: 'u8', init: call('c7') }, test: konst(1), update: { kind: 'assign', target: 'i', value: call('missing') }, body: [] },
      ]),
      fn('c1', []), fn('c2', []), fn('c3', []), fn('c4', []), fn('c5', []), fn('c6', []), fn('c7', []),
    ], entry: 'main', needs: needs([['main', 3], ['c1', 1], ['c2', 2], ['c3', 5], ['c4', 4], ['c5', 3], ['c6', 2]]), origin: 0x22, ceiling: 0x80, holes: [] },
  // Several holes in a row, and a frame that lands exactly on the ceiling.
  { functions: [fn('main', [call('a')]), fn('a', [call('b')]), fn('b', [])], entry: 'main', needs: needs([['main', 6], ['a', 6], ['b', 6]]), origin: 0x22, ceiling: 0x100, holes: [{ start: 0x24, end: 0x30 }, { start: 0x30, end: 0x38 }, { start: 0x40, end: 0x50 }] },
  { functions: [fn('main', [call('a')]), fn('a', [])], entry: 'main', needs: needs([['main', 8], ['a', 8]]), origin: 0xf0, ceiling: 0x100 },
  // Budget error text with a one-digit hex ceiling and origin.
  { functions: [fn('main', [])], entry: 'main', needs: needs([['main', 9]]), origin: 2, ceiling: 8 },
  // The entry is not one of the functions; the entry also has callers.
  { functions: [fn('a', [])], entry: 'nope', needs: needs([['a', 3]]), origin: 0, ceiling: 0x100 },
  { functions: [fn('main', [call('a')]), fn('a', [call('main')])], entry: 'main', needs: needs([['main', 1], ['a', 1]]), origin: 0, ceiling: 0x100 },
  // Zero-byte frames, and a function with no entry in needs.
  { functions: [fn('main', [call('a')]), fn('a', [call('b')]), fn('b', [])], entry: 'main', needs: needs([['main', 0], ['a', 0]]), origin: 5, ceiling: 0x100 },
  // Siblings called in a different order than declared; LIFO pop decides the order of the starts.
  { functions: [fn('main', [call('z'), call('y'), call('x')]), fn('x', []), fn('y', []), fn('z', [])], entry: 'main', needs: needs([['main', 1], ['x', 2], ['y', 3], ['z', 4]]), origin: 0, ceiling: 0x100 },
];

const out = cases.map((c) => {
  const holes = c.holes;
  const parents = collectLiveParents(c.functions);
  const layout = layoutFrames(c.functions, c.entry, new Map(c.needs.map(([n, bytes]) => [n, { bytes }])), c.origin, c.ceiling, holes);
  return {
    ...c,
    parents: [...parents].map(([k, v]) => [k, [...v]]),
    result: layout.ok ? { ok: true, starts: [...layout.starts], floor: layout.floor } : layout,
  };
});

mkdirSync(join(here, '..', 'fixtures'), { recursive: true });
writeFileSync(join(here, '..', 'fixtures', 'frames.json'), `${JSON.stringify(out, null, 1)}\n`);
