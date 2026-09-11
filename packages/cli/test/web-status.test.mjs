// GET/POST /status: the web runtime's live readout for the editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createStatusStore, handleStatusRequest, readJsonBody } from '../src/web-runtime.mjs';

test('createStatusStore starts empty and accepts fps/frames/done/error', () => {
  const store = createStatusStore(50);
  assert.deepEqual(store.get(), { fps: null, frames: 0, done: false, error: null, frameRate: 50 });
  store.post({ fps: 60, frames: 120 });
  assert.equal(store.get().fps, 60);
  assert.equal(store.get().frames, 120);
  store.post({ done: true });
  assert.equal(store.get().done, true);
  store.post({ error: 'boom' });
  assert.equal(store.get().error, 'boom');
  store.post(null);
  assert.equal(store.get().fps, 60, 'a missing body does not wipe the last sample');
});

test('readJsonBody parses a small object and refuses junk', async () => {
  const good = new EventEmitter();
  const parsed = readJsonBody(good);
  good.emit('data', Buffer.from('{"fps":12}'));
  good.emit('end');
  assert.deepEqual(await parsed, { fps: 12 });

  const bad = new EventEmitter();
  const refused = readJsonBody(bad);
  bad.emit('data', Buffer.from('not-json'));
  bad.emit('end');
  assert.equal(await refused, null);
});

test('handleStatusRequest only claims /status, and GET returns the store', async () => {
  const store = createStatusStore(60);
  store.post({ fps: 59, frames: 10 });
  let body = '';
  const res = {
    writeHead(code) { this.status = code; },
    end(chunk) { body = chunk ?? ''; },
  };
  assert.equal(await handleStatusRequest({ method: 'GET' }, res, '/index.html', store), false);
  assert.equal(await handleStatusRequest({ method: 'GET' }, res, '/status', store), true);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(body), store.get());
});

test('handleStatusRequest POST updates the store and returns 204', async () => {
  const store = createStatusStore(60);
  const req = new EventEmitter();
  req.method = 'POST';
  const res = { status: 0, writeHead(code) { this.status = code; }, end() {} };
  const handled = handleStatusRequest(req, res, '/status', store);
  req.emit('data', Buffer.from('{"fps":48,"frames":90}'));
  req.emit('end');
  assert.equal(await handled, true);
  assert.equal(res.status, 204);
  assert.equal(store.get().fps, 48);
  assert.equal(store.get().frames, 90);
});
