// The loader is generated JavaScript, so the rules inside it are strings as
// far as Node is concerned. These tests evaluate the generated file and hold
// it to the module it was generated from: a rule that exists in two places
// has to be checked in both, or the copy in the template drifts silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { renderCoiServiceWorker, renderLoader, renderWorker } from '../src/web-loader.mjs';
import {
  ANY_BORDER_SCALE, BORDER_HAIRLINE_PX, BORDER_MIN_PX, BORDER_PX, FULL_BORDER_SCALE, HOST_OFFSET,
  INNER_H, INNER_W, INPUT_OFFSET, MIN_COLUMNS, MAX_COLUMNS, MIN_ROWS, MAX_ROWS,
  agreementFor, borderFor, gridFor, swipeEdge,
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
  assert.equal(api.layout.cols, 48);
  assert.equal(api.layout.rows, 27);
  assert.equal(api.layout.inputOffset, INPUT_OFFSET);
  assert.equal(api.layout.hostOffset, HOST_OFFSET);
  assert.equal(api.layout.aspect, '16/9');
  assert.equal(api.layout.fullBorder, BORDER_PX);
});

test('agreementFor places color RAM, input, and host status after the character grid', () => {
  const hi = agreementFor({ cols: 48, rows: 27 });
  assert.equal(hi.colorBase, 2 + 48 * 27);
  assert.equal(hi.inputOffset, hi.colorBase + 48 * 27);
  assert.equal(hi.hostOffset, hi.inputOffset + 1);
  assert.equal(hi.innerWidth, 384);
  assert.equal(hi.innerHeight, 216);
  const pet = agreementFor({ cols: 40, rows: 25, aspect: '4/3' });
  assert.equal(pet.inputOffset, 2002);
  assert.equal(pet.hostOffset, 2003);
  assert.equal(pet.aspect, '4/3');
  const vic = agreementFor({ cols: 22, rows: 23 });
  assert.equal(vic.colorBase, 508);
  assert.equal(vic.hostOffset, 1015);
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
test('a phone gets the thinnest border in either orientation, and a desktop keeps the full one', () => {
  assert.equal(borderFor({ width: 393, height: 852, coarse: true }), BORDER_MIN_PX);
  assert.equal(borderFor({ width: 852, height: 393, coarse: true }), BORDER_MIN_PX);
  assert.equal(borderFor({ width: 1920, height: 1080 }), BORDER_PX);
});

// The border is a channel, not just a frame: screen.setBorder() is how a
// program says something about the whole screen at once, and 2048 turns it red
// on game over. A border of zero would delete that on exactly the devices most
// people play on, so no box — however small — ever gets one.
test('no box ever gets a zero border', () => {
  for (const box of [
    { width: 393, height: 852, coarse: true },
    { width: 852, height: 393, coarse: true },
    { width: 320, height: 180 },
    { width: 1, height: 1 },
    { width: INNER_W, height: INNER_H },
  ]) {
    assert.ok(borderFor(box) > 0, `borderFor(${JSON.stringify(box)}) must be > 0`);
  }
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
// Assigning canvas.width/height clears the canvas and resets every bit of 2D
// context state, so it happens only when the picture actually changed shape:
// a new border, or — on the Modern host — a new grid under it.
test('the canvas is only re-dimensioned when the border or the grid changes', () => {
  const source = renderLoader({ frameRate: 60 });
  assert.match(source, /if \(next !== border \|\| regridded\) \{\s*\n\s*border = next;\s*\n\s*canvas\.width = INNER_W \+ border \* 2;/);
});

// The grid rule, like borderFor, exists twice — here and in web-layout.mjs —
// and a rule that lives only inside a template string is a rule nothing can
// test.
test("the loader's gridFor agrees with web-layout.mjs on every shape", () => {
  const { gridFor: inLoader } = loadLoader({ frameRate: 60 });
  for (const box of [
    { width: 1920, height: 1080 },
    { width: 1080, height: 1920 },
    { width: 1024, height: 768 },
    { width: 2560, height: 1080 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 0, height: 0 },
    undefined,
  ]) {
    // Field by field: the loader is evaluated in its own realm, so its object
    // does not share a prototype with ours.
    const mine = gridFor(box);
    const theirs = inLoader(box);
    assert.equal(theirs.cols, mine.cols, `gridFor(${JSON.stringify(box)}).cols`);
    assert.equal(theirs.rows, mine.rows, `gridFor(${JSON.stringify(box)}).rows`);
  }
});

// 16:9 is the shape this host has always had, and it must keep answering with
// the grid every existing build and screenshot was made against.
test('a 16:9 window still gets exactly 48x27', () => {
  assert.equal(gridFor({ width: 1920, height: 1080 }).cols, 48);
  assert.equal(gridFor({ width: 1920, height: 1080 }).rows, 27);
  assert.equal(gridFor({ width: 384, height: 216 }).cols, 48);
  assert.equal(gridFor({ width: 384, height: 216 }).rows, 27);
});

// A grid too small to lay anything out on is not a better answer than one that
// letterboxes, so the shape follows the window only between the bounds.
test('an extreme window is clamped, not followed', () => {
  const sliver = gridFor({ width: 200, height: 2000 });
  assert.ok(sliver.cols >= MIN_COLUMNS && sliver.cols <= MAX_COLUMNS);
  assert.ok(sliver.rows >= MIN_ROWS && sliver.rows <= MAX_ROWS);
  const strip = gridFor({ width: 4000, height: 300 });
  assert.ok(strip.cols >= MIN_COLUMNS && strip.cols <= MAX_COLUMNS);
  assert.ok(strip.rows >= MIN_ROWS && strip.rows <= MAX_ROWS);
});

// The Modern host's map is sized for the biggest grid it will ever hand out,
// so an offset never moves when the window turns. These numbers are also
// written down in packages/web/src/geometry.8bs, which has to agree.
test('a resizable agreement is mapped for the maximum grid, a fixed one is packed', () => {
  const modern = agreementFor({ resizable: true });
  assert.equal(modern.charBase, 4);
  assert.equal(modern.colorBase, 4100);
  assert.equal(modern.inputOffset, 8196);
  assert.equal(modern.hostOffset, 8197);
  for (const [cols, rows] of [[27, 48], [42, 31], [64, 20]]) {
    const turned = agreementFor({ cols, rows, resizable: true });
    assert.equal(turned.charBase, modern.charBase);
    assert.equal(turned.colorBase, modern.colorBase);
    assert.equal(turned.inputOffset, modern.inputOffset);
    assert.equal(turned.hostOffset, modern.hostOffset);
  }
  // A machine skin is unchanged: a C64 is 40x25 and packed right behind it.
  const c64 = agreementFor({ cols: 40, rows: 25 });
  assert.equal(c64.charBase, 2);
  assert.equal(c64.colorBase, 1002);
  assert.equal(c64.inputOffset, 2002);
  assert.equal(c64.hostOffset, 2003);
});

test('the loader writes HOST_OFFSET from maxTouchPoints and pointer:coarse, and loads a sidecar', () => {
  const source = renderLoader({ frameRate: 60 });
  assert.match(source, /HOST_OFFSET/);
  assert.match(source, /function hostIsTouch/);
  assert.match(source, /maxTouchPoints/);
  assert.match(source, /pointer: coarse/);
  assert.match(source, /\.json/);
  assert.match(source, /applyLayout/);
  assert.doesNotMatch(source, /mem\[HOST_OFFSET\] = 1/);
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
