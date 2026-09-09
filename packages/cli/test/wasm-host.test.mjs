// wasm-host.mjs is what `8bs run web --screenshot` uses: instantiate a
// program's one exported function, bound waitFrame() so a `while (true)`
// can be unwound after N frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FrameLimitReached, boundedWaitFrame, instantiateProgram, runProgram } from '../src/wasm-host.mjs';

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// (module (memory (export "memory") 1) (func (export "main")))
const EMPTY_MAIN = hex(`
  00 61 73 6d 01 00 00 00
  01 04 01 60 00 00
  03 02 01 00
  05 03 01 00 01
  07 11 02 06 6d 65 6d 6f 72 79 02 00 04 6d 61 69 6e 00 00
  0a 04 01 02 00 0b
`);

// Same, but imports env.waitFrame and calls it twice before returning.
const WAITS_TWICE = hex(`
  00 61 73 6d 01 00 00 00
  01 04 01 60 00 00
  02 11 01 03 65 6e 76 09 77 61 69 74 46 72 61 6d 65 00 00
  03 02 01 00
  05 03 01 00 01
  07 11 02 06 6d 65 6d 6f 72 79 02 00 04 6d 61 69 6e 00 01
  0a 08 01 06 00 10 00 10 00 0b
`);

test('instantiateProgram finds the one exported function and reports whether it imports waitFrame', async () => {
  const empty = await instantiateProgram(EMPTY_MAIN);
  assert.equal(empty.entryName, 'main');
  assert.equal(empty.usesWaitFrame, false);
  assert.equal(typeof empty.entry, 'function');
  assert.ok(empty.memory instanceof WebAssembly.Memory);
  empty.entry();

  const waiting = await instantiateProgram(WAITS_TWICE, { waitFrame: () => {} });
  assert.equal(waiting.usesWaitFrame, true);
  waiting.entry();
});

test('instantiateProgram refuses a module that does not export exactly one function', async () => {
  // Type + memory + export memory only: zero functions.
  const none = hex(`
    00 61 73 6d 01 00 00 00
    05 03 01 00 01
    07 0a 01 06 6d 65 6d 6f 72 79 02 00
  `);
  await assert.rejects(() => instantiateProgram(none), /exports exactly one function, this \.wasm exports 0/);
});

test('boundedWaitFrame throws FrameLimitReached after `limit` returns, and runProgram swallows that', async () => {
  const wait = boundedWaitFrame(2);
  wait();
  wait();
  assert.throws(() => wait(), (error) => error instanceof FrameLimitReached && error.frames === 2);

  const finished = await runProgram(EMPTY_MAIN, { frames: 1 });
  assert.equal(finished.entryName, 'main');

  const bounded = await runProgram(WAITS_TWICE, { frames: 1 });
  assert.equal(bounded.usesWaitFrame, true);

  const completed = await runProgram(WAITS_TWICE, { frames: 5 });
  assert.equal(completed.entryName, 'main');
});

test('runProgram lets a real error out of the entry, rather than treating it as the frame bound', async () => {
  let calls = 0;
  const exploding = hex(`
    00 61 73 6d 01 00 00 00
    01 04 01 60 00 00
    02 11 01 03 65 6e 76 09 77 61 69 74 46 72 61 6d 65 00 00
    03 02 01 00
    05 03 01 00 01
    07 11 02 06 6d 65 6d 6f 72 79 02 00 04 6d 61 69 6e 00 01
    0a 08 01 06 00 10 00 10 00 0b
  `);
  await assert.rejects(
    () => instantiateProgram(exploding, {
      waitFrame: () => {
        calls += 1;
        throw new Error('sid blew up');
      },
    }).then((p) => p.entry()),
    /sid blew up/,
  );
  assert.equal(calls, 1);
});
