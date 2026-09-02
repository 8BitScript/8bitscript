// The web target's real runtime: a browser tab, a canvas, and a fixed-
// timestep requestAnimationFrame loop — what docs/learn/step1-main-loop.md
// called "its own step, once the runtime for it exists."
//
// A wasm's exported `frame()` (see examples/border/src/main.web.8bs) is
// called once per *logical* tick, not once per rAF callback. rAF fires at
// whatever rate the display actually refreshes — 60Hz, 120Hz, 144Hz, 50Hz —
// and a program should not have to know or care which. So the host
// accumulates real elapsed time and drains it in fixed 1/60s steps: on a
// 60Hz screen that is one frame() per callback, on 120Hz it is one every
// other callback, on 50Hz it is sometimes two. One build runs correctly
// anywhere, which is the point — there is no web equivalent of --pal because
// nothing here is tied to a machine's real refresh rate to begin with.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

// The C64's palette (0-15), reused so a colour number means the same thing
// in every 8BitScript example, on whichever machine it runs on. See the
// header comment on @8bitscript/web's applyColors() for why the web target
// borrows this rather than defining its own.
const COLORS = [
  '#000000', '#ffffff', '#883932', '#67b6bd',
  '#8b3f96', '#55a049', '#40318d', '#bfce72',
  '#8b5429', '#574200', '#b86962', '#505050',
  '#787878', '#94e089', '#7869c4', '#9f9f9f',
];

const LOGICAL_HZ = 60;

// The screen's own pixel grid — a VIC-20/C64-ish 4:3-ish frame at a size
// that keeps whole-number scaling clean. This is the canvas's *resolution*,
// not its on-page size: the page stretches it to fill the window (see
// resize() in the page script below) while image-rendering: pixelated keeps
// every scaled-up pixel a hard square instead of a blurred one.
const SCREEN_W = 320;
const SCREEN_H = 200;

function renderHtml() {
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
</style>
</head>
<body>
<canvas id="screen" width="${SCREEN_W}" height="${SCREEN_H}"></canvas>
<div id="hint">double-click, or press F, for fullscreen</div>
<script>
const COLORS = ${JSON.stringify(COLORS)};
const LOGICAL_STEP_MS = 1000 / ${LOGICAL_HZ};
const BORDER_PX = 24;
const SCREEN_W = ${SCREEN_W};
const SCREEN_H = ${SCREEN_H};

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const hint = document.getElementById('hint');

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

  function paint() {
    // Byte 0 is border, byte 1 is background — the same two offsets
    // @8bitscript/web's applyColors() writes, agreed on there.
    ctx.fillStyle = COLORS[mem[0] & 15];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = COLORS[mem[1] & 15];
    ctx.fillRect(BORDER_PX, BORDER_PX, canvas.width - BORDER_PX * 2, canvas.height - BORDER_PX * 2);

    // Bytes 2 and 3 are the two screen.showDigit() slots — the web
    // target's stand-in for the on-screen digits @8bitscript/vic20 and
    // @8bitscript/c64 poke straight into real screen RAM for, agreed on in
    // @8bitscript/web's WebRegisters.
    ctx.font = '16px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(mem[2] % 10), BORDER_PX + 6, BORDER_PX + 4);
    ctx.fillText(String(mem[3] % 10), BORDER_PX + 20, BORDER_PX + 4);
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
 * @param {{ open?: boolean }} [options] Spawn the OS browser (default true).
 *   An editor's own embedded browser (VS Code/Cursor's "Simple Browser: Show")
 *   has no terminal-invokable equivalent — it is a command inside the editor,
 *   not a URI or CLI flag — so the printed URL is always the fallback; pass
 *   `open: false` to skip the OS browser and use only that.
 * @returns {Promise<number>} exit code
 */
export async function runInBrowser(wasmBytes, { open = true } = {}) {
  const html = renderHtml();
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
