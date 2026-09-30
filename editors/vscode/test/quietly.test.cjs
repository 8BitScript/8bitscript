const { test } = require('node:test');
const assert = require('node:assert/strict');

const { quietly } = require('../src/quietly.cjs');

// Captures console.error for the length of one call.
async function logged(fn) {
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

test('quietly runs the work and resolves, logging nothing, when it succeeds', async () => {
  let ran = false;
  const lines = await logged(() => quietly('label', async () => { ran = true; }));
  assert.equal(ran, true);
  assert.deepEqual(lines, []);
});

test('quietly turns a rejection into a log line under its label, never an unhandled rejection', async () => {
  const error = new Error('boom');
  const lines = await logged(() => quietly('8BitScript test view', () => Promise.reject(error)));
  assert.deepEqual(lines, [['8BitScript test view:', error]]);
});

test('quietly catches a synchronous throw the same way', async () => {
  const error = new Error('thrown');
  const lines = await logged(() => quietly('label', () => { throw error; }));
  assert.deepEqual(lines, [['label:', error]]);
});

test('quietly hands a failure to its reporter as well, and only a failure', async () => {
  const reported = [];
  const error = new Error('shown');
  await logged(() => quietly('label', () => Promise.reject(error), (e) => reported.push(e)));
  await quietly('label', () => 'fine', (e) => reported.push(e));
  assert.deepEqual(reported, [error]);
});
