// The memory line `8bs build` prints under "built": measured from the
// linked program when the backend reports sizes, else what the source
// declares. sizeReportLines is --size's own breakdown underneath it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryLine, sizeReportLines } from '../src/build.mjs';

test('measured numbers win, and say so by naming the program rather than declared data', () => {
  assert.equal(
    memoryLine({ variables: 21, data: 6 }, { variables: 10, program: 973 }),
    'memory: 10 bytes of RAM for variables, 973 bytes of program (code and data)',
  );
});

test('without a measurement the line is what the source declares, and says so', () => {
  assert.equal(
    memoryLine({ variables: 21, data: 6 }),
    'memory: 21 bytes of RAM for variables, 6 bytes of constant data (as declared)',
  );
});

test('sizeReportLines: renders entries in the order given, each with its own percentage of the total — sorting is the backend\'s own job', () => {
  const lines = sizeReportLines([{ name: 'helper', bytes: 30 }, { name: 'main', bytes: 10 }], 40);
  assert.equal(
    lines,
    'size breakdown:\n  30   75.0%  helper\n  10   25.0%  main\n',
  );
});

test('sizeReportLines: byte column right-aligned to the widest entry', () => {
  const lines = sizeReportLines([{ name: 'a', bytes: 5 }, { name: 'b', bytes: 100 }], 105);
  assert.equal(
    lines,
    'size breakdown:\n    5    4.8%  a\n  100   95.2%  b\n',
  );
});
