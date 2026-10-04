// Runs media/launcher.js for real, in a vm context over a genuine DOM
// (linkedom), so the launcher's markup, ARIA, focus order and messages are
// tested as a person would meet them — not as strings. The script's filename
// is its real path, so node's coverage lands on the file.
//
// linkedom has no focus model and no KeyboardEvent, so this adds the two
// things the launcher depends on: `focus()` moves `document.activeElement`
// and fires a bubbling `focusin`, and `key()` builds a keydown with a `key`.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const LAUNCHER_JS = path.join(__dirname, '..', '..', 'media', 'launcher.js');

function mountLauncher({ saved = {} } = {}) {
  const { window, document } = parseHTML('<!doctype html><html><body><main id="app" data-logo="logo.svg"></main></body></html>');
  let active = null;
  Object.defineProperty(document, 'activeElement', { get: () => active || document.body, configurable: true });

  // One focus() for every element: linkedom's own is a no-op.
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(document.createElement('button')));
  const focusOnto = function focus() {
    if (this.getAttribute && this.getAttribute('aria-disabled') === 'true' && this.disabled) return;
    active = this;
    this.dispatchEvent(new window.Event('focusin', { bubbles: true }));
  };
  const blurOff = function blur() { if (active === this) active = null; };
  for (const p of new Set([proto, Object.getPrototypeOf(document.createElement('button')), Object.getPrototypeOf(document.createElement('input'))])) {
    p.focus = focusOnto;
    p.blur = blurOff;
  }

  // linkedom has no location and no embedding frame; the page checks both.
  const host = { name: 'the editor' };
  window.location = { origin: 'vscode-webview://launcher' };
  window.parent = host;

  const posted = [];
  let persisted = saved;
  const sandbox = {
    document,
    window,
    console,
    acquireVsCodeApi: () => ({
      postMessage: (message) => posted.push(JSON.parse(JSON.stringify(message))),
      getState: () => persisted,
      setState: (value) => { persisted = JSON.parse(JSON.stringify(value)); },
    }),
  };
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(LAUNCHER_JS, 'utf8'), { filename: LAUNCHER_JS }).runInContext(sandbox);

  const app = document.getElementById('app');
  const api = {
    window, document, app, posted,
    state: () => persisted,
    /** Send the page a state, as the extension does. */
    send(state) {
      this.sendFrom({ origin: window.location.origin, source: host }, { type: 'state', state: JSON.parse(JSON.stringify(state)) });
    },
    /** A message from anywhere: `from` is `{ origin, source }`. The editor's frame is `host`. */
    sendFrom(from, data) {
      const event = new window.Event('message');
      event.data = data;
      event.origin = from.origin;
      event.source = from.source;
      window.dispatchEvent(event);
    },
    host,
    /** Every element matching a CSS selector, as an array. */
    all: (selector) => Array.from(app.querySelectorAll(selector)),
    one: (selector) => app.querySelector(selector),
    byKey: (key) => Array.from(app.querySelectorAll('[data-key]')).find((el) => el.getAttribute('data-key') === key) || null,
    text: () => app.textContent.replace(/\s+/g, ' ').trim(),
    click(el) { el.dispatchEvent(new window.Event('click', { bubbles: true })); },
    change(el) { el.dispatchEvent(new window.Event('change', { bubbles: true })); },
    type(el, value) { el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); },
    /** A keydown; returns the event so a test can see whether it was handled. */
    key(el, key) {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      event.key = key;
      el.dispatchEvent(event);
      return event;
    },
    focus(el) { el.focus(); },
    active: () => active,
    /** Posted messages of one type. */
    messages: (type) => posted.filter((m) => m.type === type),
    last: () => posted[posted.length - 1],
  };
  return api;
}

module.exports = { mountLauncher, LAUNCHER_JS };
