// media/studio.js for real, in a vm: the page announces itself, draws the
// host's state, tells the emulator's pointer-lock reports apart from
// everything else by their source window, and its buttons post their one
// message each (Reset never leaves the page: it reloads the frame).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runWebviewScripts } = require('./support/runWebview.cjs');

const STUDIO_JS = path.join(__dirname, '..', 'media', 'studio.js');
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the Studio page: state drives the bar, the frame\'s reports drive the mouse line, buttons post', () => {
  const { dom, sandbox, posted } = runWebviewScripts([STUDIO_JS]);
  assert.deepEqual(plain(posted), [{ type: 'ready' }]);
  const $ = (id) => dom.getElementById(id);

  sandbox.window.dispatch('message', { data: { type: 'state', phase: 'building', emulator: null, program: null } });
  assert.match($('status').textContent, /^Building Studio/);
  assert.equal($('restart').disabled, true);
  assert.equal($('browser').disabled, true);
  assert.equal($('stop').disabled, false);
  assert.equal($('rebuild').textContent, 'Rebuild');
  assert.equal($('empty').hidden, false);
  assert.match($('empty').textContent, /being built/);
  assert.equal($('mouse').hidden, true, 'no mouse line before there is a screen');

  sandbox.window.dispatch('message', { data: { type: 'state', phase: 'running', emulator: 'x16emu r49 (WebAssembly)', program: 6186 } });
  assert.equal($('status').textContent, 'Running · 6186 bytes of program · x16emu r49 (WebAssembly)');
  assert.equal($('restart').disabled, false);
  assert.equal($('empty').hidden, true);
  assert.equal($('mouse').hidden, false);
  assert.equal($('mouse').textContent, 'Your mouse is free — click the screen to give it to Studio; Esc gives it back.', 'before the page says how it was launched');

  // The frame's window is the only source the mouse line listens to.
  const frame = $('frame');
  frame.contentWindow = { frame: true };
  frame.src = 'http://127.0.0.1:2222/';
  sandbox.window.dispatch('message', { source: { other: true }, data: { source: '8bs-x16emu', type: 'pointerlock', locked: true, error: null } });
  assert.match($('mouse').textContent, /^Your mouse is free/, 'a stranger\'s message changes nothing');
  // The stock launch is free: the grab key, not a click, gives Studio the mouse.
  sandbox.window.dispatch('message', { source: frame.contentWindow, data: { source: '8bs-x16emu', type: 'mode', captured: false, grabKey: 'Ctrl+M' } });
  assert.equal($('mouse').textContent, 'Your mouse is free — Ctrl+M on the screen gives it to Studio for exact tracking; Esc gives it back.');
  sandbox.window.dispatch('message', { source: frame.contentWindow, data: { source: '8bs-x16emu', type: 'pointerlock', locked: true, error: null } });
  assert.equal($('mouse').textContent, 'Studio has the mouse — Esc gives it back.');
  sandbox.window.dispatch('message', { source: frame.contentWindow, data: { source: '8bs-x16emu', type: 'pointerlock', locked: false, error: null } });
  assert.equal($('mouse').textContent, 'The mouse is yours — Ctrl+M on the screen gives it to Studio for exact tracking.');
  // A captured launch: a click does it.
  sandbox.window.dispatch('message', { source: frame.contentWindow, data: { source: '8bs-x16emu', type: 'mode', captured: true } });
  assert.equal($('mouse').textContent, 'Your mouse is free — click the screen to give it to Studio; Esc gives it back.');
  sandbox.window.dispatch('message', { source: frame.contentWindow, data: { source: '8bs-x16emu', type: 'pointerlock', locked: false, error: null } });
  assert.equal($('mouse').textContent, 'The mouse is yours — click the screen to give it to Studio.');
  assert.equal($('mouse').classList.contains('warn'), false);
  sandbox.window.dispatch('message', { source: frame.contentWindow, data: { source: '8bs-x16emu', type: 'pointerlock', locked: false, error: 'pointer lock refused' } });
  assert.match($('mouse').textContent, /allowed to capture the mouse — use Open in browser/);
  assert.equal($('mouse').classList.contains('warn'), true);
  sandbox.window.dispatch('message', { source: frame.contentWindow, data: { source: '8bs-x16emu', type: 'other' } });
  sandbox.window.dispatch('message', { data: null });

  // Reset reloads the frame in place; the others go to the host.
  $('restart').dispatch('click');
  assert.equal(frame.src, 'http://127.0.0.1:2222/');
  assert.match($('mouse').textContent, /^Your mouse is free/);
  $('rebuild').dispatch('click');
  $('stop').dispatch('click');
  $('browser').dispatch('click');
  assert.deepEqual(plain(posted.slice(1)), [{ type: 'rebuild' }, { type: 'stop' }, { type: 'browser' }]);

  sandbox.window.dispatch('message', { data: { type: 'state', phase: 'stopped', emulator: null, program: null } });
  assert.equal($('status').textContent, 'Stopped');
  assert.equal($('rebuild').textContent, 'Start Studio');
  assert.equal($('stop').disabled, true);
  assert.equal($('empty').textContent, 'Studio is not running.');
  assert.equal($('mouse').hidden, true);
});
