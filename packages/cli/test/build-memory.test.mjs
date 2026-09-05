// The memory line `8bs build` prints under "built": measured from the
// linked program when the backend could (the 6502 backend reads the ELF),
// else what the source declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryLine } from '../src/build.mjs';

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
