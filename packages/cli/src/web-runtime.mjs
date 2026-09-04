// The web target's real runtime: a browser tab, a canvas, and a fixed-
// timestep requestAnimationFrame loop — what docs/learn/step1-main-loop.md
// called "its own step, once the runtime for it exists."
//
// A wasm's exported `frame()` (see examples/borders/src/main.8bs, or any
// other program that exports one — this host is generic, not specific to
// borders) is called once per *logical* tick, not once per rAF callback. rAF
// fires at whatever rate the display actually refreshes — 60Hz, 120Hz, 144Hz,
// 50Hz — and a program should not have to know or care which. So the host
// accumulates real elapsed time and drains it in fixed steps of the
// project's configured `frameRate` (8bs.config.ts, default 60): on a screen
// that refreshes at exactly that rate it's one frame() per callback, on a
// faster screen it's one every other callback (or less often), on a slower
// one it's sometimes two. One build runs correctly anywhere, which is the
// point — there is no web equivalent of --pal because nothing here is tied
// to a machine's real refresh rate to begin with.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

// The C64's palette (0-15), reused so a colour number means the same thing
// in every 8BitScript example, on whichever machine it runs on. See the
// header comment on @8bitscript/web's applyColors() for why the web target
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

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const hint = document.getElementById('hint');
const fpsEl = document.getElementById('fps');

// @8bitscript/web's WebRegisters (CHAR_BASE/COLOR_BASE, exported above): a
// virtual 40-column, 1000-cell character screen starting at byte offset 2,
// its colour bytes starting at offset 1002. The cells hold ASCII — the
// portable character codes every machine package's screen.putChar takes:
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
setTimeout(() => hint.classList.add('hidden'), 3000);

async function boot() {
  const res = await fetch('/program.wasm');
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
  const mem = new Uint8Array(instance.exports.memory.buffer);

  // How many times frame() actually ran in the last real second — the
  // number that answers "is the fixed logical step (LOGICAL_STEP_MS above)
  // actually landing the configured frameRate's worth of logical frames a
  // second," independent of whatever Hz the display itself happens to
  // refresh at. Sampled once a second, not redrawn every rAF, so the digits
  // on screen don't flicker every frame.
  let logicalFrameCount = 0;
  let logicalFpsWindowStart = null;
  let logicalFps = 0;

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

  function paint() {
    // Byte 0 is border, byte 1 is background — the same two offsets
    // @8bitscript/web's applyColors() writes, agreed on there.
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

  instance.exports.main();
  paint();

  let acc = 0;
  let last = null;
  function tick(now) {
    if (last === null) last = now;
    acc += now - last;
    last = now;
    // A backgrounded/stalled tab shouldn't spin through a huge backlog of
    // logical frames the instant it regains focus.
    if (acc > LOGICAL_STEP_MS * 10) acc = LOGICAL_STEP_MS * 10;
    while (acc >= LOGICAL_STEP_MS) {
      instance.exports.frame();
      acc -= LOGICAL_STEP_MS;
      logicalFrameCount += 1;
    }
    if (logicalFpsWindowStart === null) logicalFpsWindowStart = now;
    if (now - logicalFpsWindowStart >= 1000) {
      logicalFps = logicalFrameCount;
      logicalFrameCount = 0;
      logicalFpsWindowStart = now;
      // This host's own diagnostic, drawn outside the canvas rather than
      // mixed into whatever the program itself is drawing on its virtual
      // screen — it isn't something the program can see or control.
      fpsEl.textContent = 'FPS ' + logicalFps;
    }
    paint();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

boot();
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

/**
 * Serve a program's .wasm with the canvas/rAF host page, open it in the
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
 *   frame() is paced at (default 60, see 8bs.config.ts).
 * @returns {Promise<number>} exit code
 */
export async function runInBrowser(wasmBytes, { open = true, frameRate = 60 } = {}) {
  const html = renderHtml(frameRate);
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.url === '/program.wasm') {
      res.writeHead(200, { 'Content-Type': 'application/wasm' });
      res.end(wasmBytes);
      return;
    }
    res.writeHead(404);
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
