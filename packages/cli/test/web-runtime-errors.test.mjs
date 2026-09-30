// The two ways web-runtime keeps a failure from becoming an unhandled
// rejection that takes a server down: answerFailedRequest (the dev
// server's and the controller server's request callbacks) and
// closeQuietly (Ctrl+C).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerFailedRequest, closeQuietly } from '../src/web-runtime.mjs';

/** Just enough of a ServerResponse to see what was written. */
function fakeResponse(headersSent = false) {
  const res = { headersSent, status: null, headers: null, ended: false };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  res.end = () => { res.ended = true; };
  return res;
}

async function quietConsole(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args);
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test('answerFailedRequest logs the error under its label and answers with the status and headers', async () => {
  const res = fakeResponse();
  const error = new Error('handler failed');
  const lines = await quietConsole(() => answerFailedRequest(res, error, '8bs run --web', 500, { 'X-Test': '1' }));
  assert.equal(res.status, 500);
  assert.deepEqual(res.headers, { 'X-Test': '1' });
  assert.equal(res.ended, true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], '8bs run --web:');
  assert.match(lines[0][1], /handler failed/, 'the stack, which carries the message');
});

test('answerFailedRequest defaults to a bare 500, and logs a non-Error as it is', async () => {
  const res = fakeResponse();
  const lines = await quietConsole(() => answerFailedRequest(res, 'plain string', '8bs controller'));
  assert.equal(res.status, 500);
  assert.deepEqual(res.headers, {});
  assert.deepEqual(lines, [['8bs controller:', 'plain string']]);
});

test('answerFailedRequest only ends a response the handler had already started', async () => {
  const res = fakeResponse(true);
  await quietConsole(() => answerFailedRequest(res, new Error('late'), 'label'));
  assert.equal(res.status, null, 'no second writeHead');
  assert.equal(res.ended, true);
});

test('closeQuietly resolves 0 whether the close resolves, rejects or throws', async () => {
  assert.equal(await closeQuietly({ close: () => Promise.resolve() }), 0);
  assert.equal(await closeQuietly({ close: () => Promise.reject(new Error('already closed')) }), 0);
  assert.equal(await closeQuietly({ close: () => { throw new Error('sync'); } }), 0);
});
