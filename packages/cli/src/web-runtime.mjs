// The web target's real runtime: a browser tab, a canvas, and a worker.
//
// This module is the *build and dev-server* half. The half that runs in a
// browser lives in web-loader.mjs, which generates 8bitscript.js — a loader
// anybody can include in a page of their own — and the worker it drives. The
// index.html written here is a shell that calls that loader exactly the way
// an embedder would, so there is no private code path that can drift away
// from the public one. web-layout.mjs holds the facts both halves and the
// headless --screenshot rasterizer have to agree on.
//
// The program — the .wasm's one exported function — runs in a Web Worker,
// exactly as it would run on a real machine: it owns its thread, loops
// forever if it wants to, and calls waitFrame() to wait for the next frame.
// The page is the video chip. It never calls into the program; it paints the
// program's screen memory (shared with the worker) every display refresh,
// writes a one-byte input snapshot into that memory for @8bitscript/web/input
// to read, and releases one logical frame at a time on a fixed timestep at the
// project's configured `frameRate` (8bitscript.config.ts, default 60) — the same
// rate on every target, whatever the display actually refreshes at (60Hz,
// 120Hz, 144Hz, 50Hz). waitFrame() in the worker is a wasm import that blocks
// on `Atomics.wait` until the page releases a frame: one build runs correctly
// anywhere, and there is no web equivalent of --pal because nothing here is
// tied to a machine's real refresh rate to begin with.
//
// A program that never calls waitFrame() runs the same way. One that returns
// simply ends (the page says so); one that spins burns its own worker, not
// the tab — the page keeps painting whatever was last written, like a real
// machine with a program stuck in a loop.
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { ELEMENT_NAME, renderCoiServiceWorker, renderLoader, renderWorker } from './web-loader.mjs';

// The screen layout, palette and input mapping, re-exported from the one
// module that defines them. screenshot.mjs and the web tests import these
// from here, which is why they stay on this path rather than moving wholesale.
export {
  BORDER_PX, BORDER_HAIRLINE_PX, CHAR_BASE, CHAR_H, CHAR_W, COLOR_BASE, COLORS,
  GRID_COLS, GRID_ROWS, INNER_H, INNER_W, INPUT_OFFSET, InputEdge, KEY_TO_EDGE,
  SWIPE_THRESHOLD, borderFor, inputBitForKey, screenSize, swipeEdge,
} from './web-layout.mjs';

import { BORDER_PX, GRID_COLS, GRID_ROWS, CHAR_W, CHAR_H } from './web-layout.mjs';

const INNER_W = GRID_COLS * CHAR_W;
const INNER_H = GRID_ROWS * CHAR_H;
const SCREEN_W = INNER_W + BORDER_PX * 2;
const SCREEN_H = INNER_H + BORDER_PX * 2;

export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const STATUS_JSON = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

/**
 * Live status the browser page posts once a second, and that GET /status
 * returns for the editor's Running machines tree. `fps` is null until
 * the first sample; `frames` is how many logical frames the program has
 * taken. Exported so the store is tested without standing up a server.
 *
 * @param {number} [frameRate]
 */
export function createStatusStore(frameRate = 60) {
  let current = { fps: null, frames: 0, done: false, error: null, frameRate };
  return {
    get() {
      return { ...current };
    },
    post(body) {
      if (!body || typeof body !== 'object') return current;
      if (typeof body.fps === 'number' && Number.isFinite(body.fps)) current.fps = body.fps;
      if (typeof body.frames === 'number' && Number.isFinite(body.frames)) current.frames = body.frames;
      if (body.done === true) current.done = true;
      if (typeof body.error === 'string') current.error = body.error;
      return current;
    },
  };
}
/**
 * Read a small JSON body, or null when it is missing, too large, or not JSON.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 */
export function readJsonBody(req, limit = 4096) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let n = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolvePromise(value);
    };
    req.on('data', (chunk) => {
      n += chunk.length;
      if (n > limit) {
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

/**
 * Handle GET/POST /status. Returns true when the request was for /status
 * (even a 405), so the file server does not try to open a file of that name.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @param {ReturnType<typeof createStatusStore>} store
 */
export async function handleStatusRequest(req, res, pathname, store) {
  if (pathname !== '/status') return false;
  if (req.method === 'GET') {
    res.writeHead(200, { ...STATUS_JSON, ...ISOLATION_HEADERS });
    res.end(JSON.stringify(store.get()));
    return true;
  }
  if (req.method === 'POST') {
    store.post(await readJsonBody(req));
    res.writeHead(204, ISOLATION_HEADERS);
    res.end();
    return true;
  }
  res.writeHead(405, ISOLATION_HEADERS);
  res.end();
  return true;
}

// Cloudflare Pages / Netlify read this file. The two headers are what make
// SharedArrayBuffer — and therefore the page-paints-the-worker's-memory
// arrangement this target is built on — legal at all. See web-loader.mjs's
// header comment for what was measured without them, and
// docs/web-embedding.md for the Apache/nginx/Vercel equivalents.
const HEADERS_FILE = `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
`;

/**
 * index.html: the shell around the loader.
 *
 * Everything specific to *this page being the whole tab* lives here — the
 * viewport meta tags, the black body, the mobile-Safari toolbar nudge — and
 * everything about running a program lives in 8bitscript.js. The page is a
 * consumer of the loader like any other, which is the point: if embedding
 * breaks, this breaks too, and it is the page we look at every day.
 *
 * @param {number} frameRate
 */
export function renderHtml(frameRate) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>8BitScript</title>
<style>
  /* 100% first for a browser with neither unit; 100dvh (the visible area,
     shrinking and growing with mobile Safari's own toolbar) overrides it
     on anything that understands it. Real height still comes from the
     loader's resize() reading visualViewport — this only keeps the black
     background from leaving a gap the size of a hidden toolbar.
     html is NOT overflow: hidden, on purpose — nudgeChromeCollapsed()
     below needs an actual pixel of overflow to scroll into, since that is
     the one thing that sometimes still collapses mobile Safari's own
     toolbar. touch-action: none on both stops every user-driven scroll
     gesture from ever reaching it, so this costs nothing when it doesn't
     work — see nudgeChromeCollapsed. */
  html { margin: 0; height: 100%; height: 100dvh; background: #000; touch-action: none; }
  body {
    margin: 0; min-height: calc(100% + 1px); min-height: calc(100dvh + 1px);
    display: flex; align-items: center; justify-content: center;
    background: #000; touch-action: none;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    box-sizing: border-box;
  }
</style>
</head>
<body>
<script src="8bitscript.js"></script>
<script>
// The dev server (8bs run web) reads this to drive the editor's Running
// machines tree. Only ever posted back to a loopback origin: a deployed copy
// of this page has no /status endpoint, and shouldn't be asking a stranger's
// server for one either.
var LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]';
function postStatus(body) {
  if (!LOCAL) return;
  fetch('/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(function () {});
}

var screen = EightBitScript.mount(document.body, {
  src: 'program.wasm',
  frameRate: ${frameRate},
  fullPage: true,
  hud: true,
  hint: 'arrows or swipe to move \\u00b7 double-click or F for fullscreen',
  onSample: postStatus,
  onDone: function () { postStatus({ done: true }); },
  onError: function (error) { postStatus({ error: String(error) }); },
});

// Best-effort only — there is no API that hides a mobile browser's own
// toolbar on request, and Apple has changed how/whether scrolling
// collapses it across iOS versions. touch-action: none above already
// stops every user-driven scroll gesture, so this fakes the one thing
// that sometimes still triggers a collapse: the page itself scrolling by
// a pixel. Harmless where it does nothing.
function nudgeChromeCollapsed() {
  if (document.documentElement.scrollHeight <= window.innerHeight) return;
  window.scrollTo(0, 1);
}
window.addEventListener('load', nudgeChromeCollapsed);
window.addEventListener('orientationchange', function () { setTimeout(nudgeChromeCollapsed, 300); });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', function () { setTimeout(nudgeChromeCollapsed, 300); });
}
</script>
</body>
</html>
`;
}

/**
 * embed.html: a worked example, in the bundle, of the thing the bundle is for.
 *
 * Deliberately a page that is mostly *not* the game — text above and below a
 * screen sitting in an article column — because that is the case index.html
 * cannot demonstrate and the case that actually goes wrong.
 */
export function renderEmbedExample() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Embedding an 8BitScript program</title>
<style>
  body { margin: 0 auto; padding: 2rem 1rem 4rem; max-width: 42rem; background: #14161a; color: #d7dae0;
         font: 16px/1.65 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 1.4rem; }
  code, pre { font-family: ui-monospace, Menlo, monospace; }
  pre { background: #0b0d10; border: 1px solid #262b33; border-radius: 8px; padding: 1rem; overflow-x: auto; font-size: 13px; }
  ${ELEMENT_NAME} { border-radius: 10px; overflow: hidden; }
</style>
<script src="8bitscript.js"></script>
</head>
<body>
<h1>Embedding an 8BitScript program</h1>
<p>
  Everything below the heading is an ordinary page. The screen is one custom
  element, sized by the column it sits in — narrow the window and the border
  disappears on its own, because at that size the picture is worth more than
  the frame.
</p>

<${ELEMENT_NAME} src="program.wasm" hint="swipe or tap to play"></${ELEMENT_NAME}>

<p>That is this, in full:</p>
<pre>&lt;script src="8bitscript.js"&gt;&lt;/script&gt;
&lt;${ELEMENT_NAME} src="program.wasm"&gt;&lt;/${ELEMENT_NAME}&gt;</pre>

<p>
  Copy <code>8bitscript.js</code>, <code>program.wasm</code> and (if your host
  will not send COOP/COEP headers) <code>coi.js</code> next to your page. The
  <code>_headers</code> file in this bundle is the Cloudflare Pages and Netlify
  form of those headers; <code>docs/web-embedding.md</code> has Apache, nginx
  and Vercel.
</p>
</body>
</html>
`;
}

/**
 * Open a URL in whatever the system considers the default browser.
 *
 * Exported because `8bs controller` opens one for the same reason `8bs run
 * web` does — the browser is the only thing on the machine that can do the
 * job, here because it is the only thing that can see a gamepad — and two
 * copies of a three-way platform switch is two things to get wrong.
 */
export function openBrowser(url) {
  if (process.platform === 'darwin') return spawn('open', [url], { stdio: 'ignore' });
  if (process.platform === 'win32') return spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore' });
  return spawn('xdg-open', [url], { stdio: 'ignore' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Write the hostable web bundle. `8bs build --target web` writes this to
 * dist/web/; wrangler (or any static host) serves the same directory.
 *
 *   index.html      the game, full tab
 *   embed.html      the same program in somebody else's page, as an example
 *   8bitscript.js   the loader: mount() and <eightbit-screen>
 *   worker.js       the same worker the loader inlines, for pages whose CSP
 *                   forbids blob: workers
 *   coi.js          opt-in cross-origin-isolation shim for hosts that cannot
 *                   send headers
 *   program.wasm    the compiled program
 *   _headers        COOP/COEP for Cloudflare Pages and Netlify
 *
 * @param {string} dir
 * @param {Buffer} wasmBytes
 * @param {{ frameRate?: number }} [options]
 */
export async function writeWebBundle(dir, wasmBytes, { frameRate = 60 } = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), renderHtml(frameRate));
  await writeFile(join(dir, 'embed.html'), renderEmbedExample());
  await writeFile(join(dir, '8bitscript.js'), renderLoader({ frameRate }));
  await writeFile(join(dir, 'worker.js'), renderWorker());
  await writeFile(join(dir, 'coi.js'), renderCoiServiceWorker());
  await writeFile(join(dir, 'program.wasm'), wasmBytes);
  await writeFile(join(dir, '_headers'), HEADERS_FILE);
}

/**
 * Serve a program's .wasm with the canvas page and its worker, open it in the
 * system browser, and keep running until the user interrupts (Ctrl+C) —
 * there is no window-close signal to wait on the way VICE gives run.mjs one.
 *
 * When `root` is set, the directory is served as-is (the dist/web/ bundle
 * `8bs build --target web` writes). Otherwise the same files are generated
 * in memory so `8bs run web` still works without a prior build.
 *
 * @param {Buffer} wasmBytes
 * @param {{ open?: boolean, frameRate?: number, root?: string, lastRunTarget?: string }} [options]
 * @returns {Promise<number>} exit code
 */
export async function runInBrowser(wasmBytes, { open = true, frameRate = 60, root, lastRunTarget } = {}) {
  // Generated once up front, not per request: `8bs run web` without a prior
  // build serves exactly the bytes `8bs build --target web` would have written.
  const generated = root ? null : new Map([
    ['/index.html', [renderHtml(frameRate), MIME['.html']]],
    ['/embed.html', [renderEmbedExample(), MIME['.html']]],
    ['/8bitscript.js', [renderLoader({ frameRate }), MIME['.js']]],
    ['/worker.js', [renderWorker(), MIME['.js']]],
    ['/coi.js', [renderCoiServiceWorker(), MIME['.js']]],
  ]);
  const status = createStatusStore(frameRate);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    handleStatusRequest(req, res, pathname, status).then((handled) => {
      if (handled) return;
      serveProgram(req, res, pathname);
    });
  });

  function serveProgram(req, res, pathname) {
    if (root) {
      if (pathname.includes('..')) {
        res.writeHead(404, ISOLATION_HEADERS);
        res.end();
        return;
      }
      const file = join(root, pathname.slice(1));
      const type = MIME[extname(file)] ?? 'application/octet-stream';
      const stream = createReadStream(file);
      stream.on('error', () => {
        res.writeHead(404, ISOLATION_HEADERS);
        res.end();
      });
      stream.on('open', () => {
        res.writeHead(200, { 'Content-Type': type, ...ISOLATION_HEADERS });
        stream.pipe(res);
      });
      return;
    }
    const hit = generated.get(pathname);
    if (hit) {
      res.writeHead(200, { 'Content-Type': hit[1], ...ISOLATION_HEADERS });
      res.end(hit[0]);
      return;
    }
    if (pathname === '/program.wasm') {
      res.writeHead(200, { 'Content-Type': 'application/wasm', ...ISOLATION_HEADERS });
      res.end(wasmBytes);
      return;
    }
    res.writeHead(404, ISOLATION_HEADERS);
    res.end();
  }

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;
  process.stdout.write(`serving ${url}\n`);
  process.stdout.write(
    'in VS Code or Cursor: Cmd/Ctrl+Shift+P -> "Simple Browser: Show" -> paste that URL, ' +
    'to view it inside the editor.\n',
  );
  if (lastRunTarget) {
    const { writeLastRun } = await import('./last-run.mjs');
    await writeLastRun(lastRunTarget, { emulator: 'browser', url });
  }
  if (open) openBrowser(url);
  process.stdout.write('press Ctrl+C to stop. (in the page: swipe or arrows to move; F for fullscreen)\n');

  return new Promise((resolvePromise) => {
    process.on('SIGINT', () => {
      server.close(() => resolvePromise(0));
    });
  });
}
