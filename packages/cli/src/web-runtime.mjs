// The web target's real runtime: a browser tab, a canvas, and a worker.
//
// The program — the .wasm's one exported function — runs in a Web Worker,
// exactly as it would run on a real machine: it owns its thread, loops
// forever if it wants to, and calls waitFrame() to wait for the next frame.
// The page is the video chip. It never calls into the program; it paints the
// program's screen memory (shared with the worker) every display refresh,
// and releases one logical frame at a time on a fixed timestep at the
// project's configured `frameRate` (8bs.config.ts, default 60) — the same
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
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

// The C64's palette (0-15), reused so a colour number means the same thing
// in every 8BitScript example, on whichever machine it runs on. See the
// header comment on @8bitscript/web/screen's setColors() for why the web target
// borrows this rather than defining its own. Exported (with the layout
// constants below) so screenshot.mjs's --screenshot path can rasterize the
// exact same virtual screen this browser canvas draws, without a second,
// hand-copied version of these numbers to keep in sync by hand.
export const COLORS = [
  '#000000', '#ffffff', '#883932', '#67b6bd',
  '#8b3f96', '#55a049', '#40318d', '#bfce72',
  '#8b5429', '#574200', '#b86962', '#505050',
  '#787878', '#94e089', '#7869c4', '#9f9f9f',
];

// The character grid is the C64's own 40×25 of 8×8 cells — 320×200, the
// same shape @8bitscript/web's virtual screen uses. The coloured border sits
// around that grid, the way the VIC-II/VIC paint it, rather than eating into
// it: characters then live entirely in the background, not clipped into the
// border. This is the canvas's *resolution*, not its on-page size: the
// page stretches it to fill the window (see resize() in the page script
// below) while image-rendering: pixelated keeps every scaled-up pixel a
// hard square instead of a blurred one.
export const GRID_COLS = 40;
export const GRID_ROWS = 25;
export const CHAR_W = 8;
export const CHAR_H = 8;
export const BORDER_PX = 24;
const INNER_W = GRID_COLS * CHAR_W;
const INNER_H = GRID_ROWS * CHAR_H;
const SCREEN_W = INNER_W + BORDER_PX * 2;
const SCREEN_H = INNER_H + BORDER_PX * 2;

// Where the virtual screen's character codes and per-cell colours live in
// the wasm's linear memory — @8bitscript/web's WebRegisters layout, mirrored
// here by hand (there's no shared module the .8bs side and this JS host
// could both import). Byte 0 is border, byte 1 is background.
export const CHAR_BASE = 2;
export const COLOR_BASE = 1002;

// The two words the page and the worker share, in a SharedArrayBuffer beside
// the program's memory: how many logical frames the page has released, and
// how many the program has taken. Their difference is how far behind the
// program is.
const ISSUED = 0;
const CONSUMED = 1;

// The worker: the machine the program runs on. It instantiates the program
// with the one import a program can have — waitFrame(), blocking on the
// page's frame clock — hands the page its memory to paint, and calls the
// program's one exported function.
function renderWorker() {
  return `
const ISSUED = ${ISSUED};
const CONSUMED = ${CONSUMED};

self.onmessage = async ({ data: { ctrl } }) => {
  // Block until the page has released a frame this program hasn't taken yet.
  // Returns at once when one is already owed — two logical frames per real
  // one on a slow display — otherwise sleeps until the page notifies. The
  // same 0/1/2-frames-per-wait behaviour the 6502 backend's accumulator has.
  const waitFrame = () => {
    const next = Atomics.load(ctrl, CONSUMED) + 1;
    for (let issued; (issued = Atomics.load(ctrl, ISSUED)) < next;) {
      Atomics.wait(ctrl, ISSUED, issued);
    }
    Atomics.store(ctrl, CONSUMED, next);
  };

  const response = await fetch('/program.wasm');
  const module = await WebAssembly.compile(await response.arrayBuffer());
  const shared = WebAssembly.Module.imports(module).some((i) => i.module === 'env' && i.name === 'waitFrame');
  const instance = await WebAssembly.instantiate(module, { env: { waitFrame } });
  const entry = Object.values(instance.exports).find((v) => typeof v === 'function');

  // A waitFrame() program's memory is shared, so the page can paint it while
  // the program runs. One that never waits has ordinary memory: it runs to
  // completion first, and the page gets a copy of the result to paint.
  if (shared) self.postMessage({ memory: instance.exports.memory.buffer });
  try {
    entry();
    if (!shared) self.postMessage({ memory: instance.exports.memory.buffer });
    self.postMessage({ done: true });
  } catch (error) {
    if (!shared) self.postMessage({ memory: instance.exports.memory.buffer });
    self.postMessage({ error: String(error) });
  }
};
`;
}

function renderHtml(frameRate) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>8BitScript</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
  body { display: flex; align-items: center; justify-content: center; }
  canvas { image-rendering: pixelated; display: block; }
  #hint {
    position: fixed;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    font: 12px/1.4 ui-monospace, Menlo, monospace;
    color: rgba(255, 255, 255, 0.55);
    background: rgba(0, 0, 0, 0.35);
    padding: 5px 10px;
    border-radius: 6px;
    pointer-events: none;
    transition: opacity 0.6s ease;
  }
  #hint.hidden { opacity: 0; }
  #fps {
    position: fixed;
    top: 10px;
    right: 14px;
    font: 11px/1.4 ui-monospace, Menlo, monospace;
    color: rgba(255, 255, 255, 0.4);
    pointer-events: none;
  }
</style>
</head>
<body>
<canvas id="screen" width="${SCREEN_W}" height="${SCREEN_H}"></canvas>
<div id="hint">double-click, or press F, for fullscreen</div>
<div id="fps">FPS --</div>
<script>
const COLORS = ${JSON.stringify(COLORS)};
const LOGICAL_STEP_MS = 1000 / ${frameRate};
const BORDER_PX = ${BORDER_PX};
const GRID_COLS = ${GRID_COLS};
const GRID_ROWS = ${GRID_ROWS};
const CHAR_W = ${CHAR_W};
const CHAR_H = ${CHAR_H};
const INNER_W = ${INNER_W};
const INNER_H = ${INNER_H};
const SCREEN_W = ${SCREEN_W};
const SCREEN_H = ${SCREEN_H};
const ISSUED = ${ISSUED};
const CONSUMED = ${CONSUMED};

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const hint = document.getElementById('hint');
const fpsEl = document.getElementById('fps');

// @8bitscript/web's WebRegisters (CHAR_BASE/COLOR_BASE, exported above): a
// virtual 40-column, 1000-cell character screen starting at byte offset 2,
// its colour bytes starting at offset 1002. The cells hold ASCII — the
// portable character codes every machine's text.putChar takes:
// space, '0'-'9', 'A'-'Z' and a little punctuation, upper case only, 32-95.
// The Commodore packages turn those into screen codes for a character ROM;
// this host has no ROM, so it draws them as the text they already are.
const CHAR_BASE = ${CHAR_BASE};
const COLOR_BASE = ${COLOR_BASE};

function decodeScreenCode(code) {
  if (code >= 32 && code <= 95) return String.fromCharCode(code);
  return null; // 0 (never written) and everything outside the portable set
}

// The canvas's on-page size, not its pixel grid: as large as fits the
// window while keeping the screen's own aspect ratio, so it reads as one
// screen filling the tab rather than a fixed-size box floating in it.
function resize() {
  const scale = Math.min(window.innerWidth / SCREEN_W, window.innerHeight / SCREEN_H);
  canvas.style.width = Math.floor(SCREEN_W * scale) + 'px';
  canvas.style.height = Math.floor(SCREEN_H * scale) + 'px';
}
window.addEventListener('resize', resize);
document.addEventListener('fullscreenchange', resize);
resize();

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.body.requestFullscreen().catch(() => {});
}
canvas.addEventListener('dblclick', toggleFullscreen);
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});
let hintTimer = setTimeout(() => hint.classList.add('hidden'), 3000);
function say(text) {
  clearTimeout(hintTimer);
  hint.textContent = text;
  hint.classList.remove('hidden');
}

// A real character ROM's 8×8 bits sit entirely inside the cell. System
// fonts do not: with textBaseline 'top', glyphs still paint a fraction of
// a pixel above y, which (scaled up, pixelated) is the top of "TICK"
// clipping into the border. Shift by that overflow so row 0 stays on
// the background. Clip to the inner rectangle as well — on the VIC-20/C64
// characters cannot draw in the border, and a font that overflows a cell
// should not either.
ctx.font = CHAR_H + 'px ui-monospace, Menlo, monospace';
ctx.textBaseline = 'top';
ctx.textAlign = 'left';
const glyphY = Math.ceil(ctx.measureText('M').actualBoundingBoxAscent || 0);

function paint(mem) {
  // Byte 0 is border, byte 1 is background — the same two offsets
  // @8bitscript/web's screen.setColors() writes, agreed on in that
  // package's WebRegisters.
  ctx.fillStyle = COLORS[mem[0] & 15];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = COLORS[mem[1] & 15];
  ctx.fillRect(BORDER_PX, BORDER_PX, INNER_W, INNER_H);

  // Whatever the program poked into the virtual character screen — this
  // host doesn't know or care what any of it means, the same way a real
  // VIC-20/C64 doesn't know what a program's screen memory says. Blank
  // cells (never written, or written as a literal space) draw nothing.
  ctx.save();
  ctx.beginPath();
  ctx.rect(BORDER_PX, BORDER_PX, INNER_W, INNER_H);
  ctx.clip();
  for (let cell = 0; cell < GRID_COLS * GRID_ROWS; cell += 1) {
    const glyph = decodeScreenCode(mem[CHAR_BASE + cell]);
    if (glyph === null) continue;
    const col = cell % GRID_COLS;
    const row = (cell - col) / GRID_COLS;
    ctx.fillStyle = COLORS[mem[COLOR_BASE + cell] & 15];
    ctx.fillText(
      glyph,
      BORDER_PX + col * CHAR_W,
      BORDER_PX + row * CHAR_H + glyphY,
    );
  }
  ctx.restore();
}

// The frame clock. Real elapsed time accumulates and is released to the
// program in fixed logical steps — on a display refreshing at exactly
// frameRate that is one frame per callback, on a faster one fewer, on a
// slower one sometimes two. The program is *behind* by however many
// released frames it hasn't taken yet; when that reaches two, a step is
// dropped rather than banked — the same rule the 6502 backend's accumulator
// has, where at most about two frames can ever be owed and the rest are
// lost. Without it, a program that lagged for a while would race through a
// backlog at full speed afterwards, which no real machine does.
const ctrl = new Int32Array(new SharedArrayBuffer(8));
let mem = null;
let acc = 0;
let last = null;
let fpsWindowStart = null;
let fpsConsumedAtWindowStart = 0;
function tick(now) {
  if (last === null) last = now;
  acc += now - last;
  last = now;
  // A backgrounded/stalled tab shouldn't spin through a huge backlog of
  // logical frames the instant it regains focus.
  if (acc > LOGICAL_STEP_MS * 10) acc = LOGICAL_STEP_MS * 10;
  while (acc >= LOGICAL_STEP_MS) {
    acc -= LOGICAL_STEP_MS;
    if (Atomics.load(ctrl, ISSUED) - Atomics.load(ctrl, CONSUMED) < 2) {
      Atomics.add(ctrl, ISSUED, 1);
      Atomics.notify(ctrl, ISSUED);
    }
  }
  // How many frames the program actually took in the last real second —
  // the number that answers "is it really running at frameRate," whatever
  // Hz the display refreshes at. Sampled once a second so the digits don't
  // flicker. This host's own diagnostic, drawn outside the canvas: not
  // something the program can see or control.
  if (fpsWindowStart === null) fpsWindowStart = now;
  if (now - fpsWindowStart >= 1000) {
    const consumed = Atomics.load(ctrl, CONSUMED);
    fpsEl.textContent = 'FPS ' + (consumed - fpsConsumedAtWindowStart);
    fpsConsumedAtWindowStart = consumed;
    fpsWindowStart = now;
  }
  if (mem) paint(mem);
  requestAnimationFrame(tick);
}

const worker = new Worker('/worker.js');
worker.onmessage = ({ data }) => {
  if (data.memory) mem = new Uint8Array(data.memory);
  if (data.done) say('the program finished');
  if (data.error) say('the program failed: ' + data.error);
};
worker.onerror = (e) => say('the program failed: ' + e.message);
worker.postMessage({ ctrl });
requestAnimationFrame(tick);
</script>
</body>
</html>
`;
}

function openBrowser(url) {
  if (process.platform === 'darwin') return spawn('open', [url], { stdio: 'ignore' });
  if (process.platform === 'win32') return spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore' });
  return spawn('xdg-open', [url], { stdio: 'ignore' });
}

// SharedArrayBuffer — what lets the page paint the worker's memory and the
// worker block on the page's frame clock — is only available to a page that
// opts into cross-origin isolation with these two headers. Everything this
// server sends is same-origin, so they cost nothing.
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Serve a program's .wasm with the canvas page and its worker, open it in the
 * system browser, and keep running until the user interrupts (Ctrl+C) —
 * there is no window-close signal to wait on the way VICE gives run.mjs one.
 *
 * @param {Buffer} wasmBytes
 * @param {{ open?: boolean, frameRate?: number }} [options] `open` spawns the
 *   OS browser (default true). An editor's own embedded browser (VS
 *   Code/Cursor's "Simple Browser: Show") has no terminal-invokable
 *   equivalent — it is a command inside the editor, not a URI or CLI flag —
 *   so the printed URL is always the fallback; pass `open: false` to skip
 *   the OS browser and use only that. `frameRate` is the logical Hz
 *   waitFrame() is paced at (default 60, see 8bs.config.ts).
 * @returns {Promise<number>} exit code
 */
export async function runInBrowser(wasmBytes, { open = true, frameRate = 60 } = {}) {
  const html = renderHtml(frameRate);
  const worker = renderWorker();
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...ISOLATION_HEADERS });
      res.end(html);
      return;
    }
    if (req.url === '/worker.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', ...ISOLATION_HEADERS });
      res.end(worker);
      return;
    }
    if (req.url === '/program.wasm') {
      res.writeHead(200, { 'Content-Type': 'application/wasm', ...ISOLATION_HEADERS });
      res.end(wasmBytes);
      return;
    }
    res.writeHead(404, ISOLATION_HEADERS);
    res.end();
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;
  process.stdout.write(`serving ${url}\n`);
  process.stdout.write(
    'in VS Code or Cursor: Cmd/Ctrl+Shift+P -> "Simple Browser: Show" -> paste that URL, ' +
    'to view it inside the editor.\n',
  );
  if (open) openBrowser(url);
  process.stdout.write('press Ctrl+C to stop. (in the page: double-click, or F, for fullscreen)\n');

  return new Promise((resolvePromise) => {
    process.on('SIGINT', () => {
      server.close(() => resolvePromise(0));
    });
  });
}
