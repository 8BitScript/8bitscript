// The loader is generated JavaScript, so the rules inside it are strings as
// far as Node is concerned. These tests evaluate the generated file and hold
// it to the module it was generated from: a rule that exists in two places
// has to be checked in both, or the copy in the template drifts silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { renderCoiServiceWorker, renderLoader, renderWorker } from '../src/web-loader.mjs';
import {
  ANY_BORDER_SCALE, BORDER_HAIRLINE_PX, BORDER_PX, FULL_BORDER_SCALE, INNER_H, INNER_W,
  borderFor, swipeEdge,
} from '../src/web-layout.mjs';

/** Evaluate the generated loader with no DOM at all and hand back its public object. */
function loadLoader(options) {
  const self = {};
  runInNewContext(renderLoader(options), { self, console });
  return self.EightBitScript;
}

test('the generated loader evaluates with no DOM and exposes mount() and the element name', () => {
  const api = loadLoader({ frameRate: 60 });
  assert.equal(typeof api.mount, 'function');
  assert.equal(api.elementName, 'eightbit-screen');
  assert.equal(api.defaultFrameRate, 60);
  assert.equal(api.layout.innerWidth, INNER_W);
  assert.equal(api.layout.innerHeight, INNER_H);
  assert.equal(api.layout.fullBorder, BORDER_PX);
});

// The two copies of borderFor — the one the build uses and the one that ships
// in the loader — are the same rule written twice. Check them against each
// other over the sizes that actually decide the answer.
test('the loader\'s borderFor agrees with web-layout.mjs on every boundary', () => {
  const { borderFor: inLoader } = loadLoader({ frameRate: 60 });
  const boxes = [
    { width: 393, height: 852, coarse: true },   // iPhone, upright
    { width: 852, height: 393, coarse: true },   // iPhone, sideways
    { width: 1080, height: 810, coarse: true },  // tablet
    { width: 1440, height: 900 },                // laptop
    { width: 1920, height: 1080 },               // desktop
    { width: 640, height: 400 },                 // an article column
    { width: INNER_W * ANY_BORDER_SCALE, height: INNER_H * ANY_BORDER_SCALE },
    { width: INNER_W * FULL_BORDER_SCALE, height: INNER_H * FULL_BORDER_SCALE },
    { width: 0, height: 0 },
    {},
  ];
  for (const box of boxes) {
    assert.equal(inLoader(box), borderFor(box), `borderFor(${JSON.stringify(box)})`);
  }
});

test('the loader\'s swipeEdge agrees with web-layout.mjs', () => {
  const { swipeEdge: inLoader } = loadLoader({ frameRate: 60 });
  for (const [dx, dy] of [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40], [27, 27], [50, 49], [-9, -60]]) {
    assert.equal(inLoader(dx, dy), swipeEdge(dx, dy), `swipeEdge(${dx}, ${dy})`);
  }
});

// The stated ask this rule exists for: a phone gets the picture, not a frame,
// in either orientation.
test('a phone gets no border in either orientation, and a desktop keeps the full one', () => {
  assert.equal(borderFor({ width: 393, height: 852, coarse: true }), 0);
  assert.equal(borderFor({ width: 852, height: 393, coarse: true }), 0);
  assert.equal(borderFor({ width: 1920, height: 1080 }), BORDER_PX);
});

test('a touch screen big enough for a border still only gets the hairline', () => {
  const big = { width: INNER_W * 4, height: INNER_H * 4 };
  assert.equal(borderFor(big), BORDER_PX);
  assert.equal(borderFor({ ...big, coarse: true }), BORDER_HAIRLINE_PX);
});

// A container that has not been laid out yet is not a small screen. Guessing
// "phone" there would flash a borderless frame before the real size arrives.
test('an unmeasured box gets the full border, not the smallest one', () => {
  assert.equal(borderFor({}), BORDER_PX);
  assert.equal(borderFor({ width: 0, height: 0 }), BORDER_PX);
  assert.equal(borderFor(undefined), BORDER_PX);
});

test('the loader carries the worker inline so it can be served from another origin', () => {
  const source = renderLoader({ frameRate: 60 });
  // new Worker('worker.js') is blocked cross-origin; a blob: URL is not.
  assert.match(source, /URL\.createObjectURL\(new Blob\(\[WORKER_SOURCE\]/);
  assert.match(source, /var WORKER_SOURCE = "/);
  // ...and the same worker is still writable as a file, for pages whose CSP
  // forbids blob: workers.
  assert.match(renderWorker(), /Atomics\.wait/);
});

// Under a blob: URL, self.location.href is blob:<origin>/<uuid> and resolving
// a relative path against it produces nothing useful — so the page resolves
// the wasm URL and sends it.
test('the wasm URL is resolved on the page and passed to the worker, not guessed', () => {
  assert.match(renderLoader({ frameRate: 60 }), /new URL\(src, document\.baseURI\)\.href/);
  assert.match(renderLoader({ frameRate: 60 }), /wasmUrl: wasmUrl/);
  assert.match(renderWorker(), /data: \{ ctrl, wasmUrl \}/);
  assert.doesNotMatch(renderWorker(), /new URL\('program\.wasm'/);
});

// An embedded screen is a guest on somebody else's page: it must not take the
// whole document's arrow keys, and it must not post to their /status.
test('the loader stays inside its own element when embedded', () => {
  const source = renderLoader({ frameRate: 60 });
  assert.match(source, /keyboard = options\.keyboard \|\| \(fullPage \? 'window' : 'focus'\)/);
  assert.match(source, /keyTarget = keyboard === 'window' \? global : root/);
  assert.doesNotMatch(source, /\/status/);
  // Sizing embedded comes from the container, not the browser window.
  assert.match(source, /new ResizeObserver\(resize\)/);
});

// Assigning canvas.width/height clears the canvas and resets the 2D context,
// so it must happen only when the border actually changed, never per frame.
test('the canvas is only re-dimensioned when the border changes', () => {
  const source = renderLoader({ frameRate: 60 });
  assert.match(source, /if \(next !== border\) \{\s*\n\s*border = next;\s*\n\s*canvas\.width = INNER_W \+ border \* 2;/);
});

test('the loader says what is wrong when the page is not cross-origin isolated', () => {
  const source = renderLoader({ frameRate: 60 });
  assert.match(source, /typeof SharedArrayBuffer !== 'undefined' && global\.crossOriginIsolated !== false/);
  assert.match(source, /Cross-Origin-Opener-Policy: same-origin/);
  assert.match(source, /load coi\.js first/);
});

// The shim is one file playing two parts; `window` is what tells them apart.
test('coi.js is both the page script and the service worker it registers', () => {
  const source = renderCoiServiceWorker();
  assert.match(source, /typeof window === 'undefined'/);
  assert.match(source, /addEventListener\('fetch'/);
  assert.match(source, /headers\.set\('Cross-Origin-Embedder-Policy', 'require-corp'\)/);
  assert.match(source, /headers\.set\('Cross-Origin-Opener-Policy', 'same-origin'\)/);
  // A service worker needs a secure context; on plain http:// it must not try.
  assert.match(source, /window\.isSecureContext/);
  // And it must say out loud what it does to the rest of the page.
  assert.match(source, /require-corp to EVERY response on this origin/);
});
