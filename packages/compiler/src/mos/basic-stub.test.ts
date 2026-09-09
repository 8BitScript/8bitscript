import { test } from 'node:test';
import assert from 'node:assert/strict';

import { basicStub } from './basic-stub.ts';

test('basicStub($0401): the PET stub, byte for byte — "0 SYS1037"', () => {
  const { bytes, codeStart } = basicStub(0x0401);
  assert.equal(codeStart, 1037);
  assert.deepEqual(
    [...bytes],
    [
      0x0b, 0x04, // link to $040B, the end-of-program marker right after this line
      0x00, 0x00, // line number 0
      0x9e, // SYS token
      0x31, 0x30, 0x33, 0x37, // "1037"
      0x00, // end of line
      0x00, 0x00, // end of program
    ],
  );
  assert.equal(bytes.length, 12);
});

test('basicStub: codeStart is always right after the stub\'s own bytes', () => {
  for (const loadAddress of [0x0401, 0x0801, 0x1001, 0x2710]) {
    const { bytes, codeStart } = basicStub(loadAddress);
    assert.equal(loadAddress + bytes.length, codeStart);
  }
});

test('basicStub: the SYS argument has as many digits as codeStart actually does', () => {
  const { bytes, codeStart } = basicStub(0x2710); // 10000 -> codeStart in the five-digit range
  const digits = String(codeStart).length;
  assert.equal(digits, 5);
  // token(1) + digits(5) + null(1) = 7 of the SYS line's bytes are literal;
  // the rest is the fixed 6 bytes of link + line number + end-of-program.
  assert.equal(bytes.length, 6 + 1 + digits + 1);
});
