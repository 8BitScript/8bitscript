import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeWebBundle, ISOLATION_HEADERS } from '../src/web-runtime.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { loadCatalog, resolveHardware } from '../src/hardware.mjs';
import { pixelAt } from '../src/png.mjs';

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// Writes border=2, background=0, screen-code 'A' at cell 0, color 1.
const PAINTS_A = hex(`
  00 61 73 6d 01 00 00 00
  01 04 01 60 00 00
  03 02 01 00
  05 03 01 00 01
  07 11 02 06 6d 65 6d 6f 72 79 02 00 04 6d 61 69 6e 00 00
  0a 21 01 1f 00 41 00 41 02 3a 00 00 41 01 41 00 3a 00 00
     41 02 41 41 3a 00 00 41 ea 07 41 01 3a 00 00 0b
`);

test('writeWebBundle writes a bundle somebody can host, embed from, and isolate', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-bundle-'));
  try {
    await writeWebBundle(dir, PAINTS_A, { frameRate: 50 });

    // index.html is a consumer of the loader, not a second copy of it: the
    // page we ship takes the same path an embedder takes.
    const html = await readFile(join(dir, 'index.html'), 'utf8');
    assert.match(html, /<script src="8bitscript\.js"><\/script>/);
    assert.match(html, /EightBitScript\.mount\(document\.body, \{/);
    assert.match(html, /frameRate: 50,/);
    assert.match(html, /fullPage: true,/);
    assert.match(html, /hud: false,/);
    assert.doesNotMatch(html, /const GLYPHS = \{/);

    // The renderer and the frame clock live in the loader.
    const loader = await readFile(join(dir, '8bitscript.js'), 'utf8');
    assert.match(loader, /var DEFAULT_FRAME_RATE = 50;/);
    assert.match(loader, /var GLYPHS = \{/);
    // The renderer is the per-scanline compositor: glyph bits composed into
    // an ImageData row by row, never canvas text drawing.
    assert.match(loader, /putImageData/);
    assert.match(loader, /function rowState/);
    assert.doesNotMatch(loader, /ctx\.fillText/);

    const worker = await readFile(join(dir, 'worker.js'), 'utf8');
    assert.match(worker, /waitFrame/);
    assert.match(worker, /Atomics\.wait/);

    // embed.html is the worked example of the case index.html cannot show:
    // a screen inside a page that is mostly not the screen.
    const embed = await readFile(join(dir, 'embed.html'), 'utf8');
    assert.match(embed, /<eightbit-screen src="program\.wasm"/);
    // ...and it has to actually load the loader, not just print the tag that
    // does. A worked example that doesn't work is worse than none.
    assert.match(embed, /<script src="8bitscript\.js"><\/script>/);

    // coi.js is shipped but never loaded on its own — index.html must not
    // quietly flip the embedder's whole origin to require-corp.
    const coi = await readFile(join(dir, 'coi.js'), 'utf8');
    assert.match(coi, /Cross-Origin-Embedder-Policy/);
    assert.match(coi, /navigator\.serviceWorker\.register/);
    assert.doesNotMatch(html, /coi\.js/);

    const wasm = await readFile(join(dir, 'program.wasm'));
    assert.deepEqual([...wasm], [...PAINTS_A]);
    const sidecar = JSON.parse(await readFile(join(dir, 'program.json'), 'utf8'));
    assert.equal(sidecar.cols, 48);
    assert.equal(sidecar.rows, 27);
    assert.equal(sidecar.inputOffset, 2594);
    assert.equal(sidecar.hostOffset, 2595);
    assert.equal(sidecar.aspect, '16/9');
    assert.equal(sidecar.colorPerCell, true);
    const headers = await readFile(join(dir, '_headers'), 'utf8');
    assert.match(headers, /Cross-Origin-Opener-Policy/);
    assert.equal(ISOLATION_HEADERS['Cross-Origin-Embedder-Policy'], 'require-corp');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeWebBundle: mobile Safari gets viewport-fit, a home-screen-capable page, and a best-effort toolbar nudge', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-bundle-'));
  try {
    await writeWebBundle(dir, PAINTS_A, { frameRate: 60 });
    const html = await readFile(join(dir, 'index.html'), 'utf8');
    // viewport-fit=cover + safe-area padding: the canvas doesn't draw under
    // a notch or the home-indicator strip once the page runs edge to edge.
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /env\(safe-area-inset-top\)/);
    // apple-mobile-web-app-capable (+ friends): the real, dependable
    // full-screen path — Add to Home Screen launches with no browser
    // chrome at all — which nothing here can trigger on its own.
    assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(html, /name="apple-mobile-web-app-status-bar-style"/);
    // html must NOT be overflow: hidden, or nudgeChromeCollapsed has no
    // pixel of scroll to move into and the whole trick is inert.
    assert.doesNotMatch(html, /html\s*\{[^}]*overflow:\s*hidden/);
    assert.match(html, /min-height: calc\(100dvh \+ 1px\)/);
    // The nudge itself: best-effort, and explicitly a no-op when there is
    // nothing to scroll (guards against forcing a scroll on a desktop
    // browser where the page never overflows in the first place).
    assert.match(html, /function nudgeChromeCollapsed/);
    assert.match(html, /window\.scrollTo\(0, 1\)/);
    assert.match(html, /addEventListener\('orientationchange'/);
    // resize() prefers visualViewport, the actually-visible area, over
    // window.innerHeight, which mobile Safari can report before or after
    // its own toolbar has actually finished collapsing.
    assert.match(html, /window\.visualViewport/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('captureScreenshot for web rasterizes wasm screen memory to a PNG of the same layout the canvas draws', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-shot-'));
  try {
    const wasmFile = join(dir, 'program.wasm');
    const shot = join(dir, 'out.png');
    await writeFile(wasmFile, PAINTS_A);
    await captureScreenshot('web', wasmFile, shot, { frames: 1 });
    const png = await readFile(shot);
    // Border color 2 is the C64 palette's '#883932'.
    assert.deepEqual(pixelAt(png, 0, 0), [0x88, 0x39, 0x32]);
    // The inner background (color 0) starts at BORDER_PX = 24.
    assert.deepEqual(pixelAt(png, 24, 24), [0x00, 0x00, 0x00]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the raster list, end to end -------------------------------------------
// A tiny hand-assembled wasm whose main() is a run of i32.store8 pokes: the
// exact bytes @8bitscript/web/rasterline's at()/enable() would leave in the
// agreement page (the native web backend is still pending, so the .8bs layer
// itself is linked and checked in packages/compiler/test/rasterline.test.mjs
// and the bytes are laid down here by hand). --screenshot rasterizes ONE
// memory snapshot, so a raster list a program animated frame to frame would
// be captured mid-phase; this one stands still.

function uleb(n) {
  const bytes = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    bytes.push(b);
  } while (n !== 0);
  return bytes;
}

function sleb(n) {
  const bytes = [];
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    bytes.push(b);
  }
  return bytes;
}

function section(id, content) {
  return [id, ...uleb(content.length), ...content];
}

/** One-page module exporting memory and a main() that store8's each [addr, value]. */
function pokeWasm(pokes) {
  const name = (s) => [s.length, ...Buffer.from(s)];
  const body = [0]; // no locals
  for (const [addr, value] of pokes) {
    body.push(0x41, ...sleb(addr), 0x41, ...sleb(value), 0x3a, 0x00, 0x00);
  }
  body.push(0x0b);
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(3, [1, 0]),
    ...section(5, [1, 0, 1]),
    ...section(7, [2, ...name('memory'), 2, 0, ...name('main'), 0, 0]),
    ...section(10, [1, ...uleb(body.length), ...body]),
  ]);
}

test('captureScreenshot composes the raster list: a color split at its line, a band fine-scrolled', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-raster-shot-'));
  try {
    // Default 48×27 layout: color RAM at 1298, raster control/count/base at
    // 2596/2597/2598 (HOST_OFFSET 2595 + 1/2/3).
    const wasmFile = join(dir, 'program.wasm');
    const shot = join(dir, 'out.png');
    await writeFile(wasmFile, pokeWasm([
      [0, 2], // border: red
      [1, 0], // background: black
      [1298 + 12 * 48, 0x81], // reverse-video white block at cell row 12, col 0
      [1298 + 13 * 48, 0x81], // ...and at cell row 13, col 0, inside the scroll band
      // The list rasterline.8bs's at() would build, ascending:
      [2598, 100], [2599, 0], [2600, 5], // line 100: BORDER green
      [2601, 100], [2602, 1], [2603, 6], // line 100: BACKGROUND blue
      [2604, 104], [2605, 2], [2606, 4], // line 104: SCROLL_X 4
      [2597, 3], // count
      [2596, 1], // enable()
    ]));
    await captureScreenshot('web', wasmFile, shot, { frames: 1 });
    const png = await readFile(shot);
    // Above the split the border is the base red, at line 100 it turns green;
    // the background turns blue on the same line.
    assert.deepEqual(pixelAt(png, 0, 24 + 99), [0x88, 0x39, 0x32]);
    assert.deepEqual(pixelAt(png, 0, 24 + 100), [0x55, 0xa0, 0x49]);
    assert.deepEqual(pixelAt(png, 24 + 300, 24 + 99), [0x00, 0x00, 0x00]);
    assert.deepEqual(pixelAt(png, 24 + 300, 24 + 100), [0x40, 0x31, 0x8d]);
    // The row-12 block, above the band, starts at column 0 unshifted...
    assert.deepEqual(pixelAt(png, 24 + 0, 24 + 96), [0xff, 0xff, 0xff]);
    // ...the row-13 block, inside the band, is shifted 4 px right, and the
    // vacated columns are that row's background (blue), not stale pixels.
    assert.deepEqual(pixelAt(png, 24 + 0, 24 + 104), [0x40, 0x31, 0x8d]);
    assert.deepEqual(pixelAt(png, 24 + 4, 24 + 104), [0xff, 0xff, 0xff]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The PET skin advertises the same raster capability as every web build, and
// all three slots have to land there too: BORDER and BACKGROUND resolve
// through the black/green palette, SCROLL_X shifts a band. Only the per-cell
// foreground stays fixed on this skin.
test('captureScreenshot machine=pet-2001 composes all three raster slots in black and green', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-pet-raster-shot-'));
  try {
    const resolved = resolveHardware(loadCatalog('web'), { overrides: { machine: 'pet-2001' } });
    assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
    // 40×25 PET layout: color RAM at 1002, raster control/count/base at
    // 2004/2005/2006 (HOST_OFFSET 2003 + 1/2/3).
    const wasmFile = join(dir, 'program.wasm');
    const shot = join(dir, 'out.png');
    await writeFile(wasmFile, pokeWasm([
      [1002 + 12 * 40, 0x80], // reverse-video blank at cell row 12, col 0
      [1002 + 13 * 40, 0x80], // ...and at row 13, col 0, inside the scroll band
      // The list rasterline.8bs's at() would build, ascending:
      [2006, 100], [2007, 0], [2008, 5], // line 100: BORDER green
      [2009, 104], [2010, 2], [2011, 4], // line 104: SCROLL_X 4
      [2012, 120], [2013, 1], [2014, 5], // line 120: BACKGROUND green
      [2005, 3], // count
      [2004, 1], // enable()
    ]));
    await captureScreenshot('web', wasmFile, shot, { frames: 1, hardware: resolved.hardware });
    const png = await readFile(shot);
    // The border: black above the split, PET green at and below line 100.
    assert.deepEqual(pixelAt(png, 0, 24 + 99), [0x00, 0x00, 0x00]);
    assert.deepEqual(pixelAt(png, 0, 24 + 100), [0x55, 0xff, 0x55]);
    // The background: black above line 120, green from it down.
    assert.deepEqual(pixelAt(png, 24 + 300, 24 + 119), [0x00, 0x00, 0x00]);
    assert.deepEqual(pixelAt(png, 24 + 300, 24 + 120), [0x55, 0xff, 0x55]);
    // The row-12 block, above the band, fills green from column 0; the row-13
    // block, inside it, is shifted 4 px right with a black vacated strip.
    assert.deepEqual(pixelAt(png, 24 + 0, 24 + 96), [0x55, 0xff, 0x55]);
    assert.deepEqual(pixelAt(png, 24 + 0, 24 + 104), [0x00, 0x00, 0x00]);
    assert.deepEqual(pixelAt(png, 24 + 4, 24 + 104), [0x55, 0xff, 0x55]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('captureScreenshot names a target with no screenshot method', async () => {
  await assert.rejects(
    () => captureScreenshot('unknown', '/dev/null', '/tmp/nope.png'),
    /no screenshot method wired up for target 'unknown'/,
  );
});

test('8bs run web does not serve dist/web as the page — that file can be from another CLI', () => {
  const src = readFileSync(new URL('../src/run.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /root:\s*resolve\('dist',\s*'web'\)/);
});
