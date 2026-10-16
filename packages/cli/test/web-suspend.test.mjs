// The loader's second road (web-loader.mjs's file header): a page that is
// not cross-origin isolated — an editor's webview, which no header or shim
// can isolate — runs a waitFrame() program on its own thread, suspended
// between frames with JavaScript Promise Integration, instead of blocked in
// a worker it could not share memory with. Node has JSPI (WebAssembly.
// Suspending and WebAssembly.promising), so the generated loader is
// evaluated here against a stand-in document and driven frame by frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { renderLoader } from '../src/web-loader.mjs';
import { INPUT_OFFSET, InputEdge, agreementFor } from '../src/web-layout.mjs';

// The compiler's own output in miniature (packages/compiler/src/wasm): one
// `env.waitFrame` import, shared memory, one exported function. Each frame it
// counts at byte 100 and copies the page's input byte to byte 101, forever.
function programThatLoops() {
  const leb = (n) => {
    const out = [];
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n !== 0) byte |= 0x80;
      out.push(byte);
    } while (n !== 0);
    return out;
  };
  // i32.const takes a *signed* LEB: 100 is 0xE4 0x00, not 0x64 (which is -28).
  const sleb = (n) => {
    const out = [];
    for (;;) {
      const byte = n & 0x7f;
      n >>= 7;
      if ((n === 0 && !(byte & 0x40)) || (n === -1 && (byte & 0x40))) {
        out.push(byte);
        return out;
      }
      out.push(byte | 0x80);
    }
  };
  const str = (s) => [s.length, ...Buffer.from(s)];
  const section = (id, body) => [id, ...leb(body.length), ...body];
  const body = [
    0x00, // no locals
    0x03, 0x40, // loop
    0x10, 0x00, //   call $waitFrame
    0x41, ...sleb(100), 0x41, ...sleb(100), 0x2d, 0x00, 0x00, 0x41, 0x01, 0x6a, 0x3a, 0x00, 0x00, // mem[100] += 1
    0x41, ...sleb(101), 0x41, ...sleb(INPUT_OFFSET), 0x2d, 0x00, 0x00, 0x3a, 0x00, 0x00, // mem[101] = mem[INPUT]
    0x0c, 0x00, //   br 0
    0x0b, // end loop
    0x0b, // end
  ];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x01, 0x60, 0x00, 0x00]),
    ...section(2, [0x01, ...str('env'), ...str('waitFrame'), 0x00, 0x00]),
    ...section(3, [0x01, 0x00]),
    ...section(5, [0x01, 0x03, 0x01, 0x01]), // shared, min 1 max 1
    ...section(7, [0x02, ...str('memory'), 0x02, 0x00, ...str('main'), 0x00, 0x01]),
    ...section(10, [0x01, ...leb(body.length), ...body]),
  ]);
}

/**
 * The least document mount() needs, with the hooks the tests drive: the
 * rAF callbacks the loader asks for, the key listeners it installs, and the
 * program's memory — the loader keeps `mem` private, so the page lends it a
 * Uint8Array that notes the one 64K view the loader makes over the
 * program's buffer.
 */
function page({ isolated, wasm, WebAssembly: wa, Worker, mount = {}, focused = [], layout }) {
  const listeners = new Map();
  const element = () => {
    const el = {
      style: {},
      children: [],
      parentNode: null,
      textContent: '',
      appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
      removeChild(child) { el.children = el.children.filter((c) => c !== child); child.parentNode = null; },
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 384, height: 216 }; },
      focus() { focused.push('element'); },
      getContext() {
        return {
          canvas: el,
          createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
          putImageData() {},
        };
      },
    };
    return el;
  };
  let memory = null;
  function MemoryView(buffer, ...rest) {
    const view = new Uint8Array(buffer, ...rest);
    if (buffer && buffer.byteLength === 65536) memory = view;
    return view;
  }
  const frames = [];
  const errors = [];
  let done = 0;
  const self = {
    document: {
      baseURI: 'http://127.0.0.1:1/',
      fullscreenElement: null,
      createElement: element,
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
    },
    console,
    URL,
    Blob,
    setTimeout,
    clearTimeout,
    Uint8Array: MemoryView,
    crossOriginIsolated: isolated,
    innerWidth: 384,
    innerHeight: 216,
    addEventListener() {},
    removeEventListener() {},
    focus() { focused.push('window'); },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
    fetch(url) {
      if (url.endsWith('.json')) return Promise.resolve({ ok: false });
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)) });
    },
  };
  if (wa) self.WebAssembly = wa;
  if (Worker) self.Worker = Worker;
  runInNewContext(renderLoader({ frameRate: 60, ...(layout ? { layout } : {}) }), self);
  const screen = self.EightBitScript.mount(element(), {
    src: 'program.wasm',
    onError: (error) => errors.push(error),
    onDone: () => { done += 1; },
    ...mount,
  });
  // The next rAF callback the loader asked for, called as the browser would.
  const tick = (now) => { const fn = frames.pop(); frames.length = 0; fn(now); };
  // A resumed frame settles within a few turns of the microtask queue;
  // fetch → compile → instantiate → entry compiles off-thread and takes
  // real time, so `until` waits for what the test is about to assert.
  const settle = async (until = () => true) => {
    const deadline = Date.now() + 5000;
    do {
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
      if (until()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    } while (Date.now() < deadline);
  };
  return { self, screen, listeners, tick, settle, errors, done: () => done, frames, memory: () => memory };
}

test('a page that is not isolated but can suspend wasm runs a waitFrame() program on its own thread', async () => {
  assert.equal(typeof WebAssembly.Suspending, 'function', 'this test needs a Node with JSPI');
  const p = page({ isolated: false, wasm: programThatLoops() });
  assert.equal(typeof p.self.Worker, 'undefined', 'no worker exists on this page, and none is needed');
  await p.settle(() => p.frames.length > 0 || p.errors.length > 0);
  assert.deepEqual(p.errors, [], 'no isolation message');
  assert.ok(p.screen.isRunning());
  assert.equal(p.frames.length, 1, 'the frame clock was started');
  const memory = p.memory();
  assert.ok(memory, 'the page paints the program\'s own memory');
  assert.equal(memory[100], 0, 'parked in its first waitFrame(), before frame 1');

  p.tick(0);
  p.tick(17); // one 60 Hz step elapsed: frame 1 released
  await p.settle();
  assert.equal(memory[100], 1, 'resumed for exactly one frame');

  // Input written by the page lands in the program's memory with no hop.
  p.listeners.get('keydown')({ key: 'ArrowLeft', isTrusted: true, target: {}, preventDefault() {} });
  p.tick(17 + 34); // two steps: two frames banked, both taken, no suspension between
  await p.settle();
  assert.equal(memory[100], 3);
  assert.equal(memory[101], InputEdge.LEFT, 'the program read the key the page wrote');

  // Stopping unwinds the parked stack; it is not a failure.
  p.screen.destroy();
  await p.settle();
  assert.deepEqual(p.errors, []);
  assert.equal(p.done(), 0);
  assert.equal(p.screen.isRunning(), false);
});

test('a page that is not isolated and cannot suspend wasm is told what both roads need', async () => {
  const noJspi = { compile: WebAssembly.compile, instantiate: WebAssembly.instantiate, Module: WebAssembly.Module };
  const p = page({ isolated: false, wasm: programThatLoops(), WebAssembly: noJspi });
  await p.settle(() => p.errors.length > 0);
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0].message, /not cross-origin isolated/);
  assert.match(p.errors[0].message, /cannot suspend WebAssembly \(JSPI\)/);
  assert.match(p.errors[0].message, /Cross-Origin-Embedder-Policy: require-corp, or load coi\.js first/);
  assert.equal(p.screen.isRunning(), false);
  assert.equal(p.frames.length, 0, 'no frame clock for a program that never started');
});

test('an isolated page still runs the program in a worker, suspension or not', async () => {
  const workers = [];
  class Worker {
    constructor(url) { this.url = url; workers.push(this); }
    postMessage(message) { this.message = message; }
    terminate() { this.terminated = true; }
  }
  const p = page({ isolated: true, wasm: programThatLoops(), Worker });
  await p.settle(() => workers.length > 0 || p.errors.length > 0);
  assert.deepEqual(p.errors, []);
  assert.equal(workers.length, 1, 'the first road: the machine is a worker');
  assert.match(workers[0].url, /^blob:/);
  assert.equal(workers[0].message.ctrl.buffer.byteLength, 8, 'handed the shared frame counter');
  assert.equal(p.memory(), null, 'this thread never instantiates the program');
  p.screen.destroy();
  assert.equal(workers[0].terminated, true);
});

// Framed cross-origin — the editor's Preview tab — a full-page screen only
// gets the keyboard if a click moves focus into it, and its own pointerdown
// handler calls preventDefault(), which cancels exactly that. So a tap asks
// for focus itself: the window when the screen is the whole page, its own
// element when it is embedded. Before this, a click on the PET in the
// Preview tab left the arrows with the page around it (2026-10-13; reproduced
// in headless Chromium: framed, a click and LEFT changed no pixels).
test('a tap gives the screen the keyboard: the window when full-page, its own element when embedded', async () => {
  const press = { pointerType: 'mouse', button: 0, clientX: 10, clientY: 10, preventDefault() {} };
  const fullFocus = [];
  const full = page({ isolated: false, wasm: programThatLoops(), mount: { fullPage: true }, focused: fullFocus });
  await full.settle(() => full.frames.length > 0 || full.errors.length > 0);
  fullFocus.length = 0;
  full.listeners.get('pointerdown')(press);
  assert.deepEqual(fullFocus, ['window'], 'full-page: the window is asked for focus');
  full.listeners.get('pointerdown')({ ...press, button: 2 });
  assert.deepEqual(fullFocus, ['window'], 'a right click takes nothing');
  full.screen.destroy();

  const embeddedFocus = [];
  const embedded = page({ isolated: false, wasm: programThatLoops(), focused: embeddedFocus });
  await embedded.settle(() => embedded.frames.length > 0 || embedded.errors.length > 0);
  embeddedFocus.length = 0;
  embedded.listeners.get('pointerdown')(press);
  assert.deepEqual(embeddedFocus, ['element'], 'embedded: its own element, never the host page\'s window');
  embedded.screen.destroy();
  await embedded.settle();
});

// The pointer block. A machine with a mouse gets a real one — position in
// the inner picture's pixels, a held left button — and a mouse drag is never
// an arrow; a touch is a click when it stays put and arrows when it travels;
// and a machine with no mouse gets the keyboard translation only
// (web-layout.mjs pointerRoute()).
async function pointerPage(layout) {
  const p = page({ isolated: false, wasm: programThatLoops(), layout });
  await p.settle(() => p.frames.length > 0 || p.errors.length > 0);
  p.tick(0);
  p.tick(17);
  await p.settle();
  return p;
}
const ev = (over) => ({ pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, preventDefault() {}, ...over });

test('a machine with a mouse reads a real pointer: position, held button, and no arrows from a drag', async () => {
  const layout = agreementFor({ cols: 40, rows: 25, pointer: true });
  const p = await pointerPage(layout);
  const memory = p.memory();
  const at = layout.pointerOffset;
  assert.ok(at > layout.rasterBase, 'the block is past everything a twin hard-codes');
  p.listeners.get('pointermove')(ev({ clientX: 100, clientY: 60 }));
  assert.equal(memory[at], 1, 'present');
  const x = memory[at + 2] | (memory[at + 3] << 8);
  const y = memory[at + 4] | (memory[at + 5] << 8);
  assert.ok(x > 0 && x < layout.innerWidth && y > 0 && y < layout.innerHeight, `inside the picture: ${x},${y}`);
  p.listeners.get('pointerdown')(ev({ clientX: 100, clientY: 60 }));
  assert.equal(memory[at + 1], 1, 'left button held');
  p.listeners.get('pointermove')(ev({ clientX: 300, clientY: 60 }));
  p.listeners.get('pointerup')(ev({ clientX: 300, clientY: 60 }));
  assert.equal(memory[at + 1], 0, 'released');
  assert.equal(memory[layout.inputOffset], 0, 'a mouse drag moved no arrow');
  p.listeners.get('pointerdown')(ev({ button: 2 }));
  assert.equal(memory[at + 1], 2, 'the right button is its own bit');
  p.listeners.get('pointerup')(ev({ button: 2 }));
  p.screen.destroy();
});

test('a touch on a machine with a mouse is a click when it stays put and an arrow when it swipes', async () => {
  const layout = agreementFor({ cols: 40, rows: 25, pointer: true });
  const p = await pointerPage(layout);
  const memory = p.memory();
  const at = layout.pointerOffset;
  p.listeners.get('pointerdown')(ev({ pointerType: 'touch', clientX: 50, clientY: 50 }));
  assert.equal(memory[at + 1], 0, 'a touch is not a held button');
  p.listeners.get('pointerup')(ev({ pointerType: 'touch', clientX: 52, clientY: 50 }));
  assert.equal(memory[at + 1], 1, 'a tap pulses the left button');
  assert.equal(memory[layout.inputOffset] & InputEdge.CONFIRM, 0, 'and is not also confirm');
  p.listeners.get('pointerdown')(ev({ pointerType: 'touch', clientX: 200, clientY: 50 }));
  p.listeners.get('pointerup')(ev({ pointerType: 'touch', clientX: 100, clientY: 50 }));
  assert.equal(memory[layout.inputOffset], InputEdge.LEFT, 'a swipe is one arrow');
  p.screen.destroy();
});

test('a machine with no mouse translates a touch to the keyboard and ignores a mouse drag', async () => {
  const layout = agreementFor({ cols: 40, rows: 25 });
  assert.equal(layout.pointerOffset, -1);
  const p = await pointerPage(layout);
  const memory = p.memory();
  p.listeners.get('pointerdown')(ev({ pointerType: 'touch', clientX: 200, clientY: 50 }));
  p.listeners.get('pointerup')(ev({ pointerType: 'touch', clientX: 100, clientY: 50 }));
  assert.equal(memory[layout.inputOffset], InputEdge.LEFT, 'swipe → arrow');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(memory[layout.inputOffset], 0);
  p.listeners.get('pointerdown')(ev({ clientX: 200, clientY: 50 }));
  p.listeners.get('pointerup')(ev({ clientX: 100, clientY: 50 }));
  assert.equal(memory[layout.inputOffset], 0, 'a mouse drag moves nothing');
  p.listeners.get('pointerdown')(ev({ clientX: 5, clientY: 5 }));
  p.listeners.get('pointerup')(ev({ clientX: 5, clientY: 5 }));
  assert.equal(memory[layout.inputOffset], InputEdge.CONFIRM, 'a click is confirm');
  p.screen.destroy();
});
