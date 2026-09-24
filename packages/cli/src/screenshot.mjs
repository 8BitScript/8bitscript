// `8bs run <target> --screenshot <file>` — build, then capture one PNG of
// what the program is doing, through whichever mechanism that target's own
// emulator offers, instead of opening an interactive window. The point is
// letting an agent (or a script) see a program's actual output without a
// human at the keyboard or a general-purpose "grab my screen" tool: every
// target here calls into something the emulator itself exposes for exactly
// this — VICE's -exitscreenshot, Xemu's -screenshot, FCEUX's
// gui.savescreenshotas, MAME's -seconds_to_run snapshot, openMSX's Tcl
// `screenshot -raw` — except machines whose emulator has no such flag,
// which fall back to macOS capturing just that one window's real pixels,
// with Screen Recording permission and no synthetic input.
//
// --frames means a different unit on every target, because what's being
// counted really is different hardware — see each capture function's own
// comment. In every case, count generously: the number has to cover
// whatever the machine's own boot sequence (BASIC's power-on banner, the
// KERNAL's autostart, an NES cartridge's reset handler) costs before the
// *program's* first real frame, not just the frames you want to see after
// that. Each target's DEFAULT_FRAMES was chosen by testing against
// examples until the boot sequence had clearly cleared.
import { spawn } from 'node:child_process';
import {
  access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_LOAD, VICE_EMULATOR_ARGS, VICE_MODEL_ARGS,
  emulatorInvocation,
} from './run.mjs';
import { emulatorFor, loadArgs, loadCatalog, resolveHardware } from './hardware.mjs';
import { resolveOnPath } from './setup/host.mjs';

/** The stock hardware, for a caller that did not resolve any. */
const stockHardware = (target) => resolveHardware(loadCatalog(target)).hardware;
import { encodePNG } from './png.mjs';
import { runProgram } from './wasm-host.mjs';
import { renderFrame, rgbPalette } from './web-scanline.mjs';
import { BORDER_PX, DEFAULT_LAYOUT, layoutFromHardware } from './web-runtime.mjs';

function resolveBinary(command) {
  if (command.includes('/') || command.includes('\\')) return command;
  return resolveOnPath(command) ?? command;
}

function spawnError(command, err) {
  if (err.code === 'ENOENT') {
    return new Error(`8bs run: cannot start ${command}. Run '8bs doctor' — docs/setup/index.md`);
  }
  return err;
}

function run(command, args, { timeoutMs, env } = {}) {
  const bin = resolveBinary(command);
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (err) {
      rejectPromise(spawnError(command, err));
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      : null;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      rejectPromise(spawnError(command, err));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Window-capture screenshots (atari800, Stella, SameBoy, Fuse, Mednafen,
// and the rest without a still-frame flag) share a display. One capture at
// a time, with a stale-pid break so a killed test cannot leave the next
// one waiting forever.
const WINDOW_SHOT_LOCK = join(tmpdir(), '8bs-window-screenshot.lock');

async function withWindowScreenshotLock(fn) {
  const started = Date.now();
  while (true) {
    try {
      await mkdir(WINDOW_SHOT_LOCK);
      await writeFile(join(WINDOW_SHOT_LOCK, 'pid'), String(process.pid));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const holder = Number.parseInt(await readFile(join(WINDOW_SHOT_LOCK, 'pid'), 'utf8'), 10);
        if (!Number.isFinite(holder) || !pidAlive(holder)) {
          await rm(WINDOW_SHOT_LOCK, { recursive: true, force: true });
          continue;
        }
      } catch {
        await rm(WINDOW_SHOT_LOCK, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - started > 180_000) {
        throw new Error('8bs run: timed out waiting for another window screenshot to finish');
      }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(WINDOW_SHOT_LOCK, { recursive: true, force: true });
  }
}

/** Wall-clock seconds a window/openMSX capture waits for `frames`. */
export function waitSeconds(target, frames) {
  const emu = emulatorFor(target);
  const n = frames ?? emu.defaultFrames ?? 3;
  if (emu.framesUnit === 'seconds') return Math.max(1, n);
  const fps = emu.frameRate ?? 60;
  return Math.max(0.5, n / fps);
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
// figures documented on packages/compiler/src/mos FRAME_SYNC (vic20/c64/c128
// share the C64's clock derivation) — used only to convert an explicit
// --frames into a cycle count; DEFAULT_CYCLES below is what a plain
// `--screenshot` with no --frames uses.
const VICE_CLOCK_HZ = {
  vic20: { ntsc: 1_022_727, pal: 1_108_405 },
  c64: { ntsc: 1_022_727, pal: 985_248 },
  c128: { ntsc: 1_022_727, pal: 985_248 },
  plus4: { ntsc: 894_886, pal: 886_724 },
};
const VICE_FPS = { ntsc: 60, pal: 50 };

// -limitcycles values confirmed in this project's own testing to comfortably
// clear -autostartprgmode's BASIC/KERNAL boot and land on a program's
// own steady state (not the boot banner), checked by eye against the
// resulting PNG on each machine individually. These are not derived from a
// shared formula across machines and shouldn't be compared to each other —
// each is just "generously past boot," picked per machine.
function viceDefaultCycles(target) {
  return emulatorFor(target).defaultFrames;
}
// The PET's CPU clock is a flat, region-independent 1MHz (FRAME_SYNC.pet
// in packages/compiler/src/mos). Video refresh is the xpet model's — the catalog's
// `video.frameRate` fact for the model fitted (the 3xxx ~60Hz, the CRTC
// models 50Hz); these numbers only convert an explicit --frames into a
// cycle count. The program still measures the actual period at startup.
const PET_CLOCK_HZ = 1_000_000;

function viceCycles(target, region, frames, hardware) {
  if (frames === undefined) return viceDefaultCycles(target);
  const clockHz = target === 'pet' ? PET_CLOCK_HZ : (VICE_CLOCK_HZ[target] ?? VICE_CLOCK_HZ.c64)[region];
  const fps = target === 'pet' ? (hardware.facts['video.frameRate'] ?? 60) : VICE_FPS[region];
  return Math.round((clockHz * frames) / fps);
}

async function viceScreenshot(target, outFile, screenshotPath, { pal, hardware = stockHardware(target), frames }) {
  const region = pal ? 'pal' : 'ntsc';
  const emulator = emulatorFor(target).binary;
  const cycles = viceCycles(target, region, frames, hardware);
  const exitFlag = target === 'c128' ? '-exitscreenshotvicii' : '-exitscreenshot';

  // The same hardware flags the interactive `8bs run` passes (the
  // catalog's `run` list), so a screenshot reflects the REU, the mouse, the
  // model the program was built for instead of silently running without.
  const args = [
    '-default', '-warp', '+sound',
    // VICE adds a random delay before autostart by default, so a fixed
    // -limitcycles capture lands on a different amount of program progress
    // every run — sometimes on the boot screen itself. Off, the capture is
    // cycle-deterministic.
    '+autostart-delay-random',
    ...(VICE_EMULATOR_ARGS[target] ?? ['-autostartprgmode', '1']),
    ...(VICE_MODEL_ARGS[target]?.[region] ?? []),
    ...(hardware.run[emulator] ?? []),
    '-limitcycles', String(cycles),
    '+confirmonexit',
    ...loadArgs(hardware, emulator, outFile, (DEFAULT_LOAD[emulator] ?? ((out) => ['-autostart', out]))(outFile)),
    exitFlag, screenshotPath,
  ];
  const { stderr } = await run(emulator, args);
  if (!(await fileExists(screenshotPath))) {
    throw new Error(`8bs run: ${emulator} did not produce a screenshot:\n${stderr.slice(-500)}`);
  }
}

// ---- Window capture (atari800, Stella, SameBoy, Fuse, Mednafen, …) ----------
//
// These emulators have no exit-and-screenshot flag the way VICE and Xemu
// do. atari800's -screenshots flag only sets the filename *pattern* for
// screenshots taken from the running UI; Stella, SameBoy, Fuse, Mednafen,
// XRoar, Caprice32, and Vecx are the same kind of gap. So this launches
// the real windowed emulator (the same argv `8bs run` would), waits for
// --frames worth of real time, and asks macOS to capture that one window's
// actual pixels, matched by this child's own PID — see
// mac-window-capture.mjs's header comment for exactly what permission that
// needs. Not available on non-macOS hosts.
async function windowScreenshot(target, outFile, screenshotPath, { pal, hardware = stockHardware(target), frames }) {
  const emu = emulatorFor(target);
  if (process.platform !== 'darwin') {
    throw new Error(
      `8bs run: ${target} --screenshot needs macOS (window capture via Screen Recording permission); ${emu.binary} has no headless snapshot flag.`,
    );
  }
  return withWindowScreenshotLock(async () => {
    const { findWindowIdForPid, captureWindow } = await import('./mac-window-capture.mjs');
    const invocation = await emulatorInvocation(target, { pal, hardware, outFile });
    if (!invocation.ok) throw new Error(`8bs run: ${invocation.error}`);
    const bin = resolveBinary(invocation.emulator);
    const child = spawn(bin, invocation.emulatorArgs, { stdio: 'ignore' });
    try {
      await Promise.race([
        new Promise((_, reject) => child.once('error', (err) => reject(spawnError(invocation.emulator, err)))),
        sleep(1000 * waitSeconds(target, frames)),
      ]);
      let windowId = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        windowId = await findWindowIdForPid(child.pid);
        if (windowId !== null) break;
        await sleep(250);
      }
      if (windowId === null) {
        throw new Error(`8bs run: could not find the ${invocation.emulator} window to capture.`);
      }
      await captureWindow(windowId, screenshotPath);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* spawn never started */ }
    }
  });
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

async function cx16Screenshot(outFile, screenshotPath, { frames, hardware = stockHardware('cx16') }) {
  const ffmpegCheck = await run('ffmpeg', ['-version']).catch(() => ({ code: 1 }));
  if (ffmpegCheck.code !== 0) {
    throw new Error('8bs run: cx16 --screenshot needs ffmpeg on PATH (to pull a still frame out of x16emu\'s -gif recording).');
  }
  const scratch = await mkdtemp(join(tmpdir(), '8bs-cx16-shot-'));
  const gifPath = join(scratch, 'capture.gif');
  try {
    // The catalog's own flags first (the banked-RAM size, the mouse grab),
    // then how the built file is handed over — the same list the interactive
    // `8bs run` passes, so a screenshot reflects the hardware the program
    // was built for instead of silently running on the emulator's defaults.
    // Keep `-capture`. Without it, x16emu reports the host cursor as off
    // the window and mouse_scan slams the KERNAL pointer to the last cell
    // (a probe printed CELL 04255); the sprite sits off-screen
    // and packages/pointer's center-arrow count is 0. An earlier x16emu
    // exited 13 combining `-capture` with a gif and no window; r50
    // ("next" 77f2bab3) records the gif with `-capture` and the arrow
    // is in the still (measured: 43 white pixels in the 24×24 center box,
    // 0 without `-capture`).
    const args = [
      ...(hardware.run.x16emu ?? []),
      ...loadArgs(hardware, 'x16emu', outFile, ['-prg', outFile, '-run']),
      '-gif', gifPath, '-sound', 'none',
    ];
    const child = spawn('x16emu', args, { stdio: 'ignore' });
    await sleep(1000 * ((frames ?? emulatorFor('cx16').defaultFrames) / CX16_FPS));
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

async function mega65Screenshot(outFile, screenshotPath, { pal, frames, hardware = stockHardware('mega65') }) {
  const args = [
    '-besure', '-screenshot', screenshotPath,
    ...(hardware.run.xmega65 ?? []),
    ...loadArgs(hardware, 'xmega65', outFile, ['-prg', outFile]),
    '-videostd', pal ? '0' : '1',
  ];
  const child = spawn('xmega65', args, { stdio: 'ignore' });
  await sleep(1000 * ((frames ?? emulatorFor('mega65').defaultFrames) / MEGA65_FPS));
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

async function nesScreenshot(outFile, screenshotPath, { frames, hardware = stockHardware('nes') }) {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-nes-shot-'));
  const luaPath = join(scratch, 'screenshot.lua');
  try {
    await writeFile(luaPath, nesLuaScript(frames ?? emulatorFor('nes').defaultFrames, screenshotPath));
    const { stderr } = await run('fceux', [
      '--no-config', '1', '--loadlua', luaPath,
      ...(hardware.run.fceux ?? []),
      ...loadArgs(hardware, 'fceux', outFile, [outFile]),
    ]);
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
// browser canvas draws — the layout imported from there (agreementFor's
// offsets) and the per-scanline compositor from web-scanline.mjs, the one
// place that knows how a raster list changes the picture — using the same
// 8x8 bitmap font the browser canvas stamps, and writes the result out
// with png.mjs. Note --screenshot rasterizes ONE memory snapshot, so a
// raster list a program animates frame to frame is captured mid-phase.
async function webScreenshot(outFile, screenshotPath, { frames, frameRate = 60, hardware }) {
  const bytes = await readFile(outFile);
  // The program runs until it returns or has taken --frames waitFrame()s
  // (the catalog's defaultFrames, 3 logical seconds at 60 Hz), whichever
  // comes first; a program that never calls waitFrame() and never returns
  // cannot be bounded and would spin here, exactly as it would on a real
  // machine. HOST_OFFSET is left at 0: a screenshot has no viewport, so
  // TOUCH stays clear and NO_KEYBOARD too — the desktop layout, with a
  // keyboard.
  const { memory } = await runProgram(bytes, { frames: frames ?? emulatorFor('web').defaultFrames ?? frameRate * 3 });

  const layout = hardware ? layoutFromHardware(hardware) : DEFAULT_LAYOUT;
  const mem = new Uint8Array(memory.buffer);
  // On a resizable host the grid is whatever the host last wrote, and a
  // screenshot has no viewport to write one from — so these stay zero and the
  // program lays itself out against the compiled default (see columns() in
  // packages/web/src/geometry.8bs). Read them anyway: if anything ever does
  // write a grid before the capture, the picture follows it rather than
  // rasterizing one shape while the program drew another.
  const liveCols = layout.resizable ? mem[layout.columnsOffset] : 0;
  const liveRows = layout.resizable ? mem[layout.rowsOffset] : 0;
  const gridCols = liveCols > 0 ? liveCols : layout.cols;
  const gridRows = liveRows > 0 ? liveRows : layout.rows;

  const { width, height, rgba } = renderFrame(
    mem,
    { ...layout, cols: gridCols, rows: gridRows, border: BORDER_PX },
    rgbPalette(layout.palette),
  );
  await writeFile(screenshotPath, encodePNG(width, height, rgba));
}

/**
 * Build `target` and capture one screenshot of the result to `screenshotPath`.
 * Any stale file already at `screenshotPath` is removed first, so a failed
 * capture can never be mistaken for a fresh one by its mere presence.
 * @param {string} target
 * @param {string} outFile The already-built file (from build.mjs's compile()).
 * @param {string} screenshotPath
 * @param {{ pal?: boolean, hardware?: object, frames?: number, frameRate?: number }} [options]
 *   `hardware` is the resolved hardware the program was built for (from
 *   compile()); left off, the stock machine.
 *   `frameRate` (default 60) only matters for the `web` target, whose default
 *   `--frames` count (3 logical seconds' worth) scales with it.
 * @returns {Promise<void>}
 */
// ---- MAME -------------------------------------------------------------------
//
// `-seconds_to_run` / `-str` writes a snapshot on exit. A bare filename
// after the system name is a *software-list* shortname, not a host file,
// so the image goes on `-<slot>` (`-cart`, `-cass`, `-flop1`) when the
// catalog names one. Machines with no slot (Apple II, BBC Micro as a
// boot ROM) capture the stock machine instead of hanging on a missing
// list entry.
export function mameCaptureArgs(target, outFile, scratch, { frames, hardware } = {}) {
  const emu = emulatorFor(target);
  const system = emu.system;
  if (!system) throw new Error(`8bs run: ${target} names MAME but no emulator.system`);
  const fitted = hardware ?? stockHardware(target);
  const runFlags = (fitted.run?.mame ?? []).filter((arg) => arg !== system);
  const seconds = Math.max(1, Math.round(frames ?? emu.defaultFrames ?? 8));
  const media = emu.slot && outFile ? [`-${emu.slot}`, outFile] : [];
  return {
    seconds,
    args: [
      system,
      ...runFlags,
      ...media,
      '-video', 'none',
      '-sound', 'none',
      '-skip_gameinfo',
      '-seconds_to_run', String(seconds),
      '-snapshot_directory', scratch,
      '-snapname', 'shot',
    ],
  };
}

async function firstPng(dir) {
  const names = await readdir(dir, { recursive: true });
  const png = names.find((name) => name.toLowerCase().endsWith('.png'));
  return png ? join(dir, png) : null;
}

async function mameScreenshot(target, outFile, screenshotPath, { frames, hardware }) {
  const emu = emulatorFor(target);
  const scratch = await mkdtemp(join(tmpdir(), '8bs-mame-shot-'));
  try {
    const { seconds, args } = mameCaptureArgs(target, outFile, scratch, { frames, hardware });
    const { stderr } = await run(emu.binary, args, { timeoutMs: (seconds + 20) * 1000 });
    const found = await firstPng(scratch);
    if (!found) {
      throw new Error(`8bs run: mame ${emu.system} did not produce a screenshot:\n${(stderr ?? '').slice(-500)}`);
    }
    await copyFile(found, screenshotPath);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---- openMSX ----------------------------------------------------------------
//
// `screenshot -raw` writes the emulated VDP, not an OS window. A Tcl
// script waits `--frames` of realtime (the catalog counts frames at 60 Hz)
// then captures and exits. C-BIOS is built in; a missing machine ROM is
// the emulator's own error.
export function openmsxCaptureScript(screenshotPath, seconds) {
  const escaped = screenshotPath.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
  return [
    'set throttle off',
    `after realtime ${seconds} { screenshot -raw {${escaped}}; exit }`,
  ].join('\n');
}

async function openmsxScreenshot(target, outFile, screenshotPath, { frames, hardware = stockHardware(target) }) {
  const emu = emulatorFor(target);
  const seconds = waitSeconds(target, frames);
  const scratch = await mkdtemp(join(tmpdir(), '8bs-openmsx-shot-'));
  const tclPath = join(scratch, 'shot.tcl');
  try {
    await writeFile(tclPath, openmsxCaptureScript(screenshotPath, seconds));
    const args = [
      '-script', tclPath,
      ...(hardware.run.openmsx ?? []),
      ...loadArgs(hardware, 'openmsx', outFile, [outFile]),
    ];
    const { stderr } = await run(emu.binary, args, { timeoutMs: (seconds + 20) * 1000 });
    if (!(await fileExists(screenshotPath))) {
      throw new Error(`8bs run: openmsx did not produce a screenshot:\n${(stderr ?? '').slice(-500)}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const SCREENSHOT_KIND = {
  vice: viceScreenshot,
  window: windowScreenshot,
  gif: (target, outFile, screenshotPath, options) => cx16Screenshot(outFile, screenshotPath, options),
  xemu: (target, outFile, screenshotPath, options) => mega65Screenshot(outFile, screenshotPath, options),
  lua: (target, outFile, screenshotPath, options) => {
    if (emulatorFor(target).binary === 'fceux') return nesScreenshot(outFile, screenshotPath, options);
    return windowScreenshot(target, outFile, screenshotPath, options);
  },
  openmsx: openmsxScreenshot,
  web: (target, outFile, screenshotPath, options) => webScreenshot(outFile, screenshotPath, options),
  mame: mameScreenshot,
};

export async function captureScreenshot(target, outFile, screenshotPath, options = {}) {
  await rm(screenshotPath, { force: true });
  let kind;
  try {
    kind = emulatorFor(target).screenshot;
  } catch {
    throw new Error(`8bs run: no screenshot method wired up for target '${target}'`);
  }
  const capture = SCREENSHOT_KIND[kind];
  if (!capture) {
    throw new Error(`8bs run: no screenshot method wired up for target '${target}'`);
  }
  await capture(target, outFile, screenshotPath, options);
}
