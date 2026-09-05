// `8bs run <target> --screenshot <file>` — build, then capture one PNG of
// what the program is doing, through whichever mechanism that target's own
// emulator offers, instead of opening an interactive window. The point is
// letting an agent (or a script) see a program's actual output without a
// human at the keyboard or a general-purpose "grab my screen" tool: every
// target here calls into something the emulator itself exposes for exactly
// this — VICE's -exitscreenshot, Xemu's -screenshot, FCEUX's
// gui.savescreenshotas — except atari8, which has no such flag (see its
// section below) and falls back to macOS capturing just that one window's
// real pixels, with Screen Recording permission and no synthetic input.
//
// --frames means a different unit on every target, because what's being
// counted really is different hardware — see each capture function's own
// comment. In every case, count generously: the number has to cover
// whatever the machine's own boot sequence (BASIC's power-on banner, the
// KERNAL's autostart, an NES cartridge's reset handler) costs before the
// *program's* first real frame, not just the frames you want to see after
// that. Each target's DEFAULT_FRAMES was chosen by testing against
// examples/borders until the boot sequence had clearly cleared.
import { spawn } from 'node:child_process';
import {
  access, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ATARI8_MODEL_ARG, VICE_EMULATOR, VICE_EMULATOR_ARGS, VICE_MODEL_ARGS, VIC20_MEMORY_ARG,
  atari800CleanDisplayConfig,
} from './run.mjs';
import { encodePNG } from './png.mjs';
import { runProgram } from './wasm-host.mjs';
import { glyphRows } from './font8x8.mjs';
import {
  BORDER_PX, CHAR_BASE, CHAR_H, CHAR_W, COLOR_BASE, COLORS, GRID_COLS, GRID_ROWS,
} from './web-runtime.mjs';

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      rejectPromise(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask a child process to quit and wait for it to actually do so — SIGTERM
 * first, SIGKILL after `graceMs` if it's still alive — the same two-stage
 * shutdown packages/cli/test/emulator-smoke.test.mjs already relies on for
 * atari800/xmega65/fceux, all of which either ignore SIGTERM or need a
 * moment to flush state (Xemu's screenshot, FCEUX's log) before exiting.
 * A fixed `sleep` after `kill()` has no way to know that flush finished;
 * waiting on 'close' does.
 */
function terminateAndWait(child, { graceMs = 2000 } = {}) {
  return new Promise((resolvePromise) => {
    let killTimer;
    child.once('close', () => { clearTimeout(killTimer); resolvePromise(); });
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  });
}

// ---- VICE (vic20/c64/pet/c128) ---------------------------------------------
//
// -limitcycles makes VICE run exactly that many CPU cycles under -warp
// (as fast as the host can) and then quit on its own — the same technique
// packages/cli/test/emulator-smoke.test.mjs and doctor.mjs's VIC-20 boot
// check already use to prove a build is alive, extended here to name a real
// output file instead of a throwaway temp one. c128 needs
// -exitscreenshotvicii, not -exitscreenshot: x128 drives two displays (the
// VIC-IIe this target actually draws to, and an unused 80-column VDC —
// see VICE_EMULATOR_ARGS's -hidevdcwindow comment in run.mjs), and plain
// -exitscreenshot grabs the VDC's blank power-on RAM, not the screen this
// target draws to.
//
// Real NTSC/PAL CPU clocks (Hz), taken from the same crystal/divisor
// figures documented on packages/backend-6502's FRAME_SYNC (vic20/c64/c128
// share the C64's clock derivation) — used only to convert an explicit
// --frames into a cycle count; DEFAULT_CYCLES below is what a plain
// `--screenshot` with no --frames uses.
const VICE_CLOCK_HZ = {
  vic20: { ntsc: 1_022_727, pal: 1_108_405 },
  c64: { ntsc: 1_022_727, pal: 985_248 },
  c128: { ntsc: 1_022_727, pal: 985_248 },
};
const VICE_FPS = { ntsc: 60, pal: 50 };

// -limitcycles values confirmed in this project's own testing to comfortably
// clear -autostartprgmode's BASIC/KERNAL boot and land on examples/borders'
// own steady state (not the boot banner), checked by eye against the
// resulting PNG on each machine individually. These are not derived from a
// shared formula across machines and shouldn't be compared to each other —
// each is just "generously past boot," picked per machine.
const VICE_DEFAULT_CYCLES = {
  vic20: 14_000_000, c64: 5_000_000, pet: 8_000_000, c128: 8_000_000,
};
// The PET has no NTSC/PAL split (see FRAME_SYNC's pet entry in
// backend-6502): a flat, region-independent 1MHz CPU clock and a measured
// ~50Hz refresh.
const PET_CLOCK_HZ = 1_000_000;
const PET_FPS = 50;

function viceCycles(target, region, frames) {
  if (frames === undefined) return VICE_DEFAULT_CYCLES[target];
  const clockHz = target === 'pet' ? PET_CLOCK_HZ : VICE_CLOCK_HZ[target][region];
  const fps = target === 'pet' ? PET_FPS : VICE_FPS[region];
  return Math.round((clockHz * frames) / fps);
}

async function viceScreenshot(target, outFile, screenshotPath, { pal, profile, frames }) {
  const region = pal ? 'pal' : 'ntsc';
  const emulator = VICE_EMULATOR[target];
  const vic20Profile = target === 'vic20' ? profile : undefined;
  const cycles = viceCycles(target, region, frames);
  const exitFlag = target === 'c128' ? '-exitscreenshotvicii' : '-exitscreenshot';

  // c64's REU is purely additive hardware (see run.mjs's own comment on
  // this) — attaching it here too, not just for the interactive `8bs run`
  // path, so `--profile reu512 --screenshot out.png` actually reflects the
  // REU the program was linked against instead of silently running without it.
  let reuArgs = [];
  if (target === 'c64' && profile && profile !== 'stock') {
    const { C64_REU_SIZE_KIB } = await import('@8bitscript/backend-6502');
    reuArgs = ['-reu', '-reusize', String(C64_REU_SIZE_KIB[profile])];
  }

  const args = [
    '-default', '-warp', '+sound',
    ...(VICE_EMULATOR_ARGS[target] ?? []),
    ...(VICE_MODEL_ARGS[target]?.[region] ?? []),
    ...(vic20Profile ? ['-memory', VIC20_MEMORY_ARG[vic20Profile]] : []),
    ...reuArgs,
    '-limitcycles', String(cycles),
    '+confirmonexit',
    '-autostart', outFile,
    exitFlag, screenshotPath,
  ];
  const { stderr } = await run(emulator, args);
  if (!(await fileExists(screenshotPath))) {
    throw new Error(`8bs run: ${emulator} did not produce a screenshot:\n${stderr.slice(-500)}`);
  }
}

// ---- Atari 8-bit (atari800) -------------------------------------------------
//
// atari800 has no exit-and-screenshot flag the way VICE and Xemu do — its
// -screenshots flag only sets the filename *pattern* for screenshots taken
// from the running UI (its own AKEY_SCREENSHOT hotkey), and there's no CLI
// or monitor-console way this project found to trigger that hotkey without
// a real keypress. So this launches the real windowed emulator, waits for
// --frames worth of real time (atari800 has no -limitcycles-style flag
// either), and asks macOS to capture that one window's actual pixels,
// matched by this child's own PID (not by process name — an interactive
// `8bs run atari8` window left open elsewhere on the same machine would
// otherwise be a second, indistinguishable "atari800" window to pick from)
// — see mac-window-capture.mjs's header comment for exactly what permission
// that needs and why it isn't the same thing as OS-level keystroke
// injection. Not available on non-macOS hosts.
const ATARI8_FPS = 60;
const ATARI8_DEFAULT_FRAMES = 240; // ~4s: measured enough for the OS boot and a program's own steady state

async function atari8Screenshot(outFile, screenshotPath, { pal, profile, frames }) {
  if (process.platform !== 'darwin') {
    throw new Error('8bs run: atari8 --screenshot needs macOS (window capture via Screen Recording permission); no equivalent has been wired up for this platform yet.');
  }
  const { findWindowIdForPid, captureWindow } = await import('./mac-window-capture.mjs');
  const { ATARI8_DEFAULT_PROFILE } = await import('@8bitscript/backend-6502');
  const displayCfg = await atari800CleanDisplayConfig();
  const args = [
    ...(displayCfg ? ['-config', displayCfg, '-no-autosave-config'] : []),
    ATARI8_MODEL_ARG[profile ?? ATARI8_DEFAULT_PROFILE],
    pal ? '-pal' : '-ntsc',
    '-run', outFile,
  ];
  const child = spawn('atari800', args, { stdio: 'ignore' });
  try {
    await sleep(1000 * ((frames ?? ATARI8_DEFAULT_FRAMES) / ATARI8_FPS));
    const windowId = await findWindowIdForPid(child.pid);
    if (windowId === null) throw new Error('8bs run: could not find the atari800 window to capture.');
    await captureWindow(windowId, screenshotPath);
  } finally {
    child.kill('SIGKILL');
  }
}

// ---- Commander X16 (x16emu) -------------------------------------------------
//
// x16emu's own screenshot hotkey (F12, per its README) triggers a UI action
// this project found no CLI/monitor equivalent for either, but -gif *does*
// work headlessly: it records the video output to a file for as long as
// the emulator runs, no window interaction needed. So this records for
// --frames worth of real time, terminates the emulator (waiting for the
// GIF file to actually be closed, not a fixed sleep), and asks ffmpeg for
// the GIF's last frame as a still PNG — ffmpeg is a hard requirement of
// this path (checked up front, not left to a cryptic spawn ENOENT).
const CX16_FPS = 60;
const CX16_DEFAULT_FRAMES = 300; // ~5s: measured enough for -run's BASIC RUN and a program's own steady state

async function cx16Screenshot(outFile, screenshotPath, { frames }) {
  const ffmpegCheck = await run('ffmpeg', ['-version']).catch(() => ({ code: 1 }));
  if (ffmpegCheck.code !== 0) {
    throw new Error('8bs run: cx16 --screenshot needs ffmpeg on PATH (to pull a still frame out of x16emu\'s -gif recording).');
  }
  const scratch = await mkdtemp(join(tmpdir(), '8bs-cx16-shot-'));
  const gifPath = join(scratch, 'capture.gif');
  try {
    const child = spawn('x16emu', ['-prg', outFile, '-run', '-gif', gifPath, '-sound', 'none'], { stdio: 'ignore' });
    await sleep(1000 * ((frames ?? CX16_DEFAULT_FRAMES) / CX16_FPS));
    await terminateAndWait(child);
    const { code, stderr } = await run('ffmpeg', ['-y', '-sseof', '-0.1', '-i', gifPath, '-update', '1', '-frames:v', '1', screenshotPath]);
    if (code !== 0 || !(await fileExists(screenshotPath))) {
      throw new Error(`8bs run: ffmpeg could not extract a still frame from x16emu's recording:\n${stderr.slice(-500)}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---- MEGA65 (Xemu's xmega65) ------------------------------------------------
//
// -screenshot <file> is a real Xemu flag: "Save screenshot (PNG) on exit".
// This project's own testing found it also fires on a plain SIGTERM
// (Xemu's normal shutdown path runs the same exit handler as a clean quit,
// unlike fceux/atari800 where SIGTERM just kills the process) — so this
// waits for --frames worth of real time, then terminates it and waits for
// the process to actually close (Xemu block-buffers its own log/exit
// handling, so a fixed sleep after kill() has no way to know the PNG write
// finished) before confirming the file landed.
const MEGA65_FPS = 60;
const MEGA65_DEFAULT_FRAMES = 480; // ~8s: measured enough for Hyppo boot + the READY. autoload inject

async function mega65Screenshot(outFile, screenshotPath, { pal, frames }) {
  const args = [
    '-besure', '-screenshot', screenshotPath, '-prg', outFile, '-videostd', pal ? '0' : '1',
  ];
  const child = spawn('xmega65', args, { stdio: 'ignore' });
  await sleep(1000 * ((frames ?? MEGA65_DEFAULT_FRAMES) / MEGA65_FPS));
  await terminateAndWait(child, { graceMs: 3000 });
  if (!(await fileExists(screenshotPath))) {
    throw new Error('8bs run: xmega65 did not produce a screenshot.');
  }
}

// ---- NES (FCEUX) -------------------------------------------------------------
//
// FCEUX's Lua scripting is its only headless-friendly control surface (no
// CLI flag runs N frames and exits): --loadlua runs a script alongside the
// ROM, so this writes a small script (LUA_SCRIPT below) that advances
// exactly --frames emulated frames, calls gui.savescreenshotas, then exits
// the emulator itself — frame-exact, unlike atari8/mega65/cx16's wall-clock
// waits, because Lua's emu.frameadvance() is a real per-frame hook, not a
// timer.
const NES_DEFAULT_FRAMES = 120; // ~2s: measured enough for the NES's own reset handler and a program's own steady state

function nesLuaScript(frames, screenshotPath) {
  // Lua single-quoted strings: only ' and \ need escaping for a path.
  const escaped = screenshotPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return [
    'emu.speedmode("nothrottle")',
    `for i = 1, ${Math.max(1, Math.round(frames))} do emu.frameadvance() end`,
    `gui.savescreenshotas('${escaped}')`,
    'emu.frameadvance()',
    'if emu.exit then emu.exit() end',
  ].join('\n');
}

async function nesScreenshot(outFile, screenshotPath, { frames }) {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-nes-shot-'));
  const luaPath = join(scratch, 'screenshot.lua');
  try {
    await writeFile(luaPath, nesLuaScript(frames ?? NES_DEFAULT_FRAMES, screenshotPath));
    const { stderr } = await run('fceux', ['--no-config', '1', '--loadlua', luaPath, outFile]);
    if (!(await fileExists(screenshotPath))) {
      throw new Error(`8bs run: fceux did not produce a screenshot:\n${stderr.slice(-500)}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---- Web (Node's own WebAssembly runtime) -----------------------------------
//
// The cleanest of the nine: no emulator, no process, no timing guesswork.
// This runs the real .wasm build for exactly --frames waitFrame() calls (or
// until it returns), then rasterizes the exact same virtual screen web-runtime.mjs's
// browser canvas draws — imported from there directly (COLORS, the grid/
// border layout, CHAR_BASE/COLOR_BASE) so there's exactly one place that
// describes this layout, not two hand-synced copies — using an 8x8 bitmap
// font instead of a browser's own text renderer, and writes the result out
// with png.mjs.
const WEB_DEFAULT_FRAME_SECONDS = 3;

// COLORS is a list of CSS hex strings (a canvas fillStyle); the PNG
// rasterizer below needs RGB triples instead.
const RGB_COLORS = COLORS.map((hex) => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
]);

function setPixel(rgba, width, x, y, [r, g, b]) {
  const i = (y * width + x) * 4;
  rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
}

function fillRect(rgba, width, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) setPixel(rgba, width, x, y, color);
  }
}

async function webScreenshot(outFile, screenshotPath, { frames, frameRate = 60 }) {
  const bytes = await readFile(outFile);
  // The program runs until it returns or has taken --frames waitFrame()s
  // (3 logical seconds' worth by default), whichever comes first; a program
  // that never calls waitFrame() and never returns cannot be bounded and
  // would spin here, exactly as it would on a real machine.
  const { memory } = await runProgram(bytes, { frames: frames ?? frameRate * WEB_DEFAULT_FRAME_SECONDS });

  const mem = new Uint8Array(memory.buffer);
  const innerW = GRID_COLS * CHAR_W;
  const innerH = GRID_ROWS * CHAR_H;
  const width = innerW + BORDER_PX * 2;
  const height = innerH + BORDER_PX * 2;
  const rgba = new Uint8Array(width * height * 4);

  fillRect(rgba, width, 0, 0, width, height, RGB_COLORS[mem[0] & 15]);
  fillRect(rgba, width, BORDER_PX, BORDER_PX, innerW, innerH, RGB_COLORS[mem[1] & 15]);

  for (let cell = 0; cell < GRID_COLS * GRID_ROWS; cell += 1) {
    const code = mem[CHAR_BASE + cell];
    const rows = glyphRows(code);
    if (rows === null) continue;
    const col = cell % GRID_COLS;
    const row = (cell - col) / GRID_COLS;
    const color = RGB_COLORS[mem[COLOR_BASE + cell] & 15];
    const x0 = BORDER_PX + col * CHAR_W;
    const y0 = BORDER_PX + row * CHAR_H;
    for (let gy = 0; gy < 8; gy += 1) {
      const bits = rows[gy];
      for (let gx = 0; gx < 8; gx += 1) {
        if ((bits >> gx) & 1) setPixel(rgba, width, x0 + gx, y0 + gy, color);
      }
    }
  }

  await writeFile(screenshotPath, encodePNG(width, height, rgba));
}

/**
 * Build `target` and capture one screenshot of the result to `screenshotPath`.
 * Any stale file already at `screenshotPath` is removed first, so a failed
 * capture can never be mistaken for a fresh one by its mere presence.
 * @param {string} target
 * @param {string} outFile The already-built file (from build.mjs's compile()).
 * @param {string} screenshotPath
 * @param {{ pal?: boolean, profile?: string, frames?: number, frameRate?: number }} [options]
 *   `frameRate` (default 60) only matters for the `web` target, whose default
 *   `--frames` count (3 logical seconds' worth) scales with it.
 * @returns {Promise<void>}
 */
export async function captureScreenshot(target, outFile, screenshotPath, options = {}) {
  await rm(screenshotPath, { force: true });
  if (target in VICE_EMULATOR) {
    await viceScreenshot(target, outFile, screenshotPath, options);
  } else if (target === 'atari8') {
    await atari8Screenshot(outFile, screenshotPath, options);
  } else if (target === 'cx16') {
    await cx16Screenshot(outFile, screenshotPath, options);
  } else if (target === 'mega65') {
    await mega65Screenshot(outFile, screenshotPath, options);
  } else if (target === 'nes') {
    await nesScreenshot(outFile, screenshotPath, options);
  } else if (target === 'web') {
    await webScreenshot(outFile, screenshotPath, options);
  } else {
    throw new Error(`8bs run: no screenshot method wired up for target '${target}'`);
  }
}
