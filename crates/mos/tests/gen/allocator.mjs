// Regenerates fixtures/allocator.json: LocalAllocator op sequences and the
// results (value, thrown message, `used` after each op) from the JS.
// Run from the repo root: node crates/mos/tests/gen/allocator.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LocalAllocator } from '../../../../packages/compiler/src/mos/lower/allocator.ts';

const holes = [{ start: 0xc2, end: 0xda }];
const sequences = [
  { origin: 0x80, ceiling: 0x90, holes: undefined, ops: [['alloc', 'a'], ['alloc16', 'b'], ['mark'], ['alloc16', 'c'], ['alloc', 'd'], ['release', 0], ['alloc', 'e'], ['release', 0], ['alloc16', 'f']] },
  { origin: 0x80, ceiling: 0x83, holes: undefined, ops: [['alloc16', 'x'], ['alloc16', 'y'], ['alloc', 'z'], ['alloc', 'w'], ['mark'], ['alloc', 'late']] },
  { origin: 0xc0, ceiling: 0x100, holes, ops: [['alloc', 't0'], ['alloc16', 't1'], ['alloc16', 't2'], ['alloc', 't3']] },
  { origin: 0xc0, ceiling: 0xc4, holes, ops: [['alloc16', 'p'], ['alloc16', 'q'], ['alloc', 'r']] },
  { origin: 0x10, ceiling: 0x10, holes: undefined, ops: [['alloc', 'none'], ['alloc16', 'none16']] },
  { origin: 0, ceiling: 0, holes: undefined, ops: [['alloc', 'zero']] },
  // The high-water mark survives a release; `used` never drops.
  { origin: 2, ceiling: 20, holes: undefined, ops: [['mark'], ['alloc16', 'a'], ['alloc16', 'b'], ['alloc', 'c'], ['release', 0], ['alloc', 'd'], ['mark'], ['alloc16', 'e'], ['release', 1], ['alloc16', 'f']] },
];
const rows = sequences.map(({ origin, ceiling, holes: h, ops }) => {
  const a = h === undefined ? new LocalAllocator(origin, ceiling) : new LocalAllocator(origin, ceiling, h);
  const marks = [];
  const steps = ops.map(([op, arg]) => {
    const step = { op, arg: arg ?? null };
    try {
      if (op === 'mark') {
        marks.push(a.mark());
        step.result = marks.at(-1);
      } else if (op === 'release') {
        a.release(marks[arg]);
        step.result = null;
      } else {
        step.result = a[op](arg);
      }
    } catch (e) {
      step.error = e.message;
    }
    step.used = a.used;
    return step;
  });
  return { fn: 'LocalAllocator', args: [origin, ceiling, h ?? null], result: steps };
});
mkdirSync(fileURLToPath(new URL('../fixtures', import.meta.url)), { recursive: true });
writeFileSync(fileURLToPath(new URL('../fixtures/allocator.json', import.meta.url)), `${JSON.stringify(rows)}\n`);
