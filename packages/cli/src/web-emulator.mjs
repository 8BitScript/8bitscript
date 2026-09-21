// `8bs run cx16 --web`: the same program, the same x16emu, in a browser tab
// instead of a native window — the WebAssembly build X16Community ships
// with each release (setup/cx16-web.mjs), served from loopback with the
// freshly built .prg and a page of this CLI's own.
//
// The page is not upstream's x16emu.html. That page's loader
// (webassembly/main.js) rebuilds the emulator's argv from a handful of URL
// parameters (`ram`, `capture`, `mhz`…), so a catalog flag it does not
// know about would silently not apply. This page hands Emscripten the
// argv `emulatorInvocation()` already built for the native launch — the
// catalog's `run.x16emu` flags, the controller flags, `-prg <file> -run` —
// with only the .prg's path swapped for the name it has inside the
// emulator's virtual filesystem. One list, both launches.
//
// Why a tab at all: so Studio can sit in an editor beside the source. The
// mouse follows the argv, as in the window (packages/cx16/AGENTS.md has
// the history): with `-capture` the emulator's grab is the browser's
// Pointer Lock API — a click on the screen takes the mouse, Esc gives it
// back; without it (the stock launch) the mouse is free and the
// emulator's own grab toggle — Ctrl+M in the browser, on every platform —
// takes it for exact tracking. The page says which, and tells a framing
// page (the extension's Studio tab) too.
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { ensureX16emuWasm, X16EMU_WASM_RELEASE } from './setup/cx16-web.mjs';
import { listenWebDev, serveBanner, DEFAULT_WEB_PORT } from './web-lan.mjs';

/** The name the .prg has inside the emulator's filesystem, and its URL. */
export const PROGRAM_NAME = 'program.prg';

/** Which targets have a WebAssembly emulator wired up. */
export const WEB_EMULATORS = Object.freeze({ cx16: X16EMU_WASM_RELEASE });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.prg': 'application/octet-stream',
};

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * The argv the page passes the emulator: the native one with the .prg's
 * host path replaced by its in-emulator name. Every other flag is passed
 * through untouched — that is the point of the page.
 *
 * @param {string[]} emulatorArgs from emulatorInvocation()
 * @param {string} outFile the host path those args name
 * @returns {string[]}
 */
export function webEmulatorArgs(emulatorArgs, outFile) {
  return emulatorArgs.map((arg) => (arg === outFile ? PROGRAM_NAME : arg));
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The page: one canvas, a status line while the emulator loads, and the
 * Module object Emscripten's x16emu.js reads. `</script>` cannot occur in
 * the argv JSON (`<` is escaped), so the inline script is safe to embed.
 *
 * @param {{ args: string[], title?: string, release?: { tag: string } }} options
 * @returns {string}
 */
export function renderEmulatorPage({ args, title = 'Commander X16', release = X16EMU_WASM_RELEASE }) {
  const argv = JSON.stringify(args).replace(/</g, '\\u003c');
  const captured = args.includes('-capture');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; color: #9a9a9a; font: 12px/1.4 system-ui, sans-serif; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100%; }
  #screen { position: relative; width: min(100%, calc((100vh - 2em) * 4 / 3)); }
  canvas { display: block; width: 100%; aspect-ratio: 4 / 3; image-rendering: pixelated; outline: none; }
  #status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #ddd; pointer-events: none; }
  #status[hidden] { display: none; }
  #note { margin: 0.4em 0 0; }
</style>
</head>
<body>
<div id="screen">
  <canvas id="canvas" tabindex="1" oncontextmenu="event.preventDefault()"></canvas>
  <div id="status">Loading x16emu ${escapeHtml(release.tag)}…</div>
</div>
<p id="note">${captured ? 'click the screen to give it the mouse · Esc gives it back' : 'your mouse is free · Ctrl+M on the screen gives it to the machine for exact tracking, and again gives it back'}</p>
<script>
  // Not 'status': at top level that is window.status, a string.
  var canvas = document.getElementById('canvas');
  var loading = document.getElementById('status');
  var Module = {
    arguments: ${argv},
    canvas: canvas,
    preRun: [function () {
      // Keys go to the emulator only while its screen has focus, not to
      // the whole document — this page lives in an editor's tab.
      ENV.SDL_EMSCRIPTEN_KEYBOARD_ELEMENT = '#canvas';
      FS.createPreloadedFile('/', ${JSON.stringify(PROGRAM_NAME)}, ${JSON.stringify(PROGRAM_NAME)}, true, true);
    }],
    // main() never returns (the emulator is a main loop), so postRun
    // never runs: the overlay goes when the runtime is up, just before it.
    onRuntimeInitialized: function () { loading.hidden = true; canvas.focus(); },
    setStatus: function (text) { if (text) loading.textContent = text; },
    print: function (text) { console.log(text); },
    printErr: function (text) { console.error(text); },
  };
  canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); loading.hidden = false; loading.textContent = 'WebGL context lost — reload the page'; });
  // Whoever framed this page cannot see its pointer lock from outside
  // (a cross-origin frame), so it is told: the editor's Studio tab turns
  // these into its "mouse" line, and into "open in the browser" when the
  // tab turns out not to be allowed to capture at all.
  function tellParent(locked, error) {
    if (window.parent === window) return;
    window.parent.postMessage({ source: '8bs-x16emu', type: 'pointerlock', locked: locked, error: error || null }, '*');
  }
  document.addEventListener('pointerlockchange', function () { tellParent(document.pointerLockElement === canvas, null); });
  document.addEventListener('pointerlockerror', function () { tellParent(false, 'pointer lock refused'); });
  // Ctrl+M on every platform: in the browser the emulator's grab toggle
  // answers Ctrl, not ⌘ (verified on a Mac — ⇧⌘M never reaches it here,
  // Ctrl+M locks the pointer). The native window's ⇧⌘M is the window's.
  if (window.parent !== window) {
    window.parent.postMessage({ source: '8bs-x16emu', type: 'mode', captured: ${captured}, grabKey: 'Ctrl+M' }, '*');
  }
</script>
<script async src="x16emu.js"></script>
</body>
</html>
`;
}

/**
 * Start serving the emulator, the program and the page on loopback.
 * Resolves once listening, with the URL and a `close()`; the caller
 * decides how long it stays up (run() waits for Ctrl+C).
 *
 * @param {{
 *   dir: string, programBytes: Buffer, args: string[], title?: string,
 *   port?: number, release?: typeof X16EMU_WASM_RELEASE, listen?: typeof listenWebDev,
 * }} options
 * @returns {Promise<{ url: string, close: () => Promise<unknown> } | { error: string }>}
 */
export async function serveWebEmulator({
  dir, programBytes, args, title, port = DEFAULT_WEB_PORT, release = X16EMU_WASM_RELEASE, listen = listenWebDev,
}) {
  const page = renderEmulatorPage({ args, title, release });
  const files = new Set(release.files.map((name) => `/${name}`));
  const listening = await listen((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], ...NO_STORE });
      res.end(page);
      return;
    }
    if (pathname === `/${PROGRAM_NAME}`) {
      res.writeHead(200, { 'Content-Type': MIME['.prg'], ...NO_STORE });
      res.end(programBytes);
      return;
    }
    if (files.has(pathname)) {
      const file = join(dir, pathname.slice(1));
      const stream = createReadStream(file);
      stream.on('error', () => {
        res.writeHead(404);
        res.end();
      });
      stream.on('open', () => {
        res.writeHead(200, { 'Content-Type': MIME[pathname.slice(pathname.lastIndexOf('.'))] ?? MIME['.data'] });
        stream.pipe(res);
      });
      return;
    }
    // The browser asks for one on every page; not an error worth a console line.
    res.writeHead(pathname === '/favicon.ico' ? 204 : 404);
    res.end();
  }, { lan: false, port });
  if (listening.error) return { error: listening.error };
  return { url: listening.local, close: listening.close, banner: serveBanner(listening) };
}

/**
 * The `--web` half of `8bs run`: make sure the pinned emulator is
 * unpacked, serve it with the built program, note the URL in the last-run
 * file (the editor's Running machines tree reads it), open the browser
 * unless told not to, and stay up until Ctrl+C.
 *
 * @param {{
 *   target: string, outFile: string, emulatorArgs: string[], open?: boolean, port?: number,
 *   ensure?: typeof ensureX16emuWasm, serve?: typeof serveWebEmulator, openUrl?: (url: string) => unknown,
 *   writeLastRun?: (target: string, patch: object) => Promise<unknown>, wait?: (close: () => Promise<unknown>) => Promise<number>,
 * }} options
 * @returns {Promise<number>} exit code
 */
export async function runInWebEmulator({
  target, outFile, emulatorArgs, open = true, port = DEFAULT_WEB_PORT,
  ensure = ensureX16emuWasm, serve = serveWebEmulator, openUrl, writeLastRun, wait = waitForInterrupt,
}) {
  const release = WEB_EMULATORS[target];
  if (!release) {
    process.stderr.write(`8bs run: --web runs a WebAssembly emulator in the browser, and only the Commander X16 has one (cx16); '${target}' does not yet\n`);
    return 2;
  }
  const emulator = await ensure({ release, report: (line) => process.stderr.write(`8bs run: ${line}\n`) });
  if (!emulator.ok) {
    process.stderr.write(`8bs run: ${emulator.error}\n`);
    return 1;
  }
  const serving = await serve({
    dir: emulator.dir, programBytes: await readFile(outFile), args: webEmulatorArgs(emulatorArgs, outFile),
    title: `${basename(outFile)} — Commander X16`, port, release,
  });
  if (serving.error) {
    process.stderr.write(`8bs run: ${serving.error}\n`);
    return 1;
  }
  process.stdout.write(serving.banner);
  if (writeLastRun) await writeLastRun(target, { emulator: `x16emu ${release.tag} (WebAssembly)`, url: serving.url, lanUrls: [] });
  if (open) {
    // Lazy: web-runtime.mjs is the whole web target, and run.mjs imports
    // this module for WEB_EMULATORS on every launch.
    const openWith = openUrl ?? (await import('./web-runtime.mjs')).openBrowser;
    openWith(serving.url);
  }
  process.stdout.write('press Ctrl+C to stop. (in the page: click the screen to give it the mouse; Esc gives it back)\n');
  return wait(serving.close);
}

/** Stay up until Ctrl+C, then close the server and exit 0. */
function waitForInterrupt(close) {
  return new Promise((resolvePromise) => {
    process.on('SIGINT', () => {
      close().then(() => resolvePromise(0));
    });
  });
}
