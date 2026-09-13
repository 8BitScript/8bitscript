import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOST_OFFSET, INPUT_OFFSET, InputEdge, inputBitForKey, swipeEdge, SWIPE_THRESHOLD, hostIsTouch } from '../src/web-runtime.mjs';

test('web input maps arrow keys and confirm/cancel onto the shared snapshot bits', () => {
  assert.equal(INPUT_OFFSET, 2594);
  assert.equal(HOST_OFFSET, 2595);
  assert.equal(inputBitForKey('ArrowLeft'), InputEdge.LEFT);
  assert.equal(inputBitForKey('ArrowRight'), InputEdge.RIGHT);
  assert.equal(inputBitForKey('ArrowUp'), InputEdge.UP);
  assert.equal(inputBitForKey('ArrowDown'), InputEdge.DOWN);
  assert.equal(inputBitForKey('Enter'), InputEdge.CONFIRM);
  assert.equal(inputBitForKey('Escape'), InputEdge.CANCEL);
  assert.equal(inputBitForKey('f'), 0);
  assert.equal(inputBitForKey('a'), 0);
});

test('web swipe maps a pointer gesture onto the same snapshot bits as the arrows', () => {
  assert.equal(swipeEdge(0, 0), 0);
  assert.equal(swipeEdge(SWIPE_THRESHOLD - 1, 0), 0);
  assert.equal(swipeEdge(SWIPE_THRESHOLD, 0), InputEdge.RIGHT);
  assert.equal(swipeEdge(-SWIPE_THRESHOLD, 0), InputEdge.LEFT);
  assert.equal(swipeEdge(0, SWIPE_THRESHOLD), InputEdge.DOWN);
  assert.equal(swipeEdge(0, -SWIPE_THRESHOLD), InputEdge.UP);
  assert.equal(swipeEdge(80, 10), InputEdge.RIGHT);
  assert.equal(swipeEdge(10, 80), InputEdge.DOWN);
});

test('hostIsTouch is maxTouchPoints plus pointer:coarse, with UA as fallback', () => {
  assert.equal(hostIsTouch({}), false);
  assert.equal(hostIsTouch({ maxTouchPoints: 0, coarse: true }), false);
  assert.equal(hostIsTouch({ maxTouchPoints: 5, coarse: false }), false);
  assert.equal(hostIsTouch({ maxTouchPoints: 5, coarse: true }), true);
  assert.equal(hostIsTouch({ maxTouchPoints: 5, coarse: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }), true);
  assert.equal(hostIsTouch({ maxTouchPoints: 0, coarse: false, userAgent: 'Mozilla/5.0 (iPhone)' }), false);
});
