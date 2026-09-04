// `8bs setup cx16` — get a machine from nothing to a working `8bs run cx16`:
// the mos-cx16-clang compiler (checked, not installed — docs/setup/llvm-mos.md),
// x16emu and makecart built from X16Community/x16-emulator, a *matching*
// rom.bin built from X16Community/x16-rom (upstream is explicit that the
// emulator expects a contemporary ROM, so both are always built together
// from current source), all installed under /opt/commander-x16 with
// launchers in /usr/local/bin.
//
// Every step is idempotent. A complete installation is recognised up front
// and skips the dependency/build/install stages entirely; a broken launcher
// is repaired without rebuilding anything; `--update` forces a fresh
// pull+build+install of the pair.
//
// Platform strategies are explicit (CX16_PLATFORMS below) because one of
// them is a tested trap: on macOS, x16emu resolves its default rom.bin
// relative to the path it was invoked through, so the Linux-style
// `/usr/local/bin/x16emu -> /opt/commander-x16/x16emu` symlink fails with
// "Cannot open /usr/local/bin/rom.bin!". macOS therefore gets a wrapper
// script that passes `-rom /opt/commander-x16/rom.bin` explicitly; Linux
// keeps the symlink, which resolves the ROM correctly there.
import {
  access, lstat, mkdir, readFile, readlink, stat, writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

import { execCapture, execInherit, sudoRun } from './exec.mjs';
import { reportStep, reportLine } from './report.mjs';
import { confirm, canPromptInteractively } from './prompt.mjs';
import {
  CX16_BREW_PACKAGES, CX16_PACMAN_PACKAGES, CX16_AUR_TOOLS,
  missingBrewPackages, installBrewPackages, missingPacmanPackages, installPacmanPackages, missingPathTools,
} from './deps.mjs';
import {
  hasBinaryOnPath, isDirOnPath, hasXcodeCommandLineTools, installXcodeCommandLineTools,
} from './host.mjs';
import { syncRepository, runBuild, pathExists } from './source.mjs';
import { ensureDirectory, installFiles } from './install.mjs';
import { ensureLauncher, inspectLauncher } from './launcher.mjs';
import {
  x16EmulatorSourceDir, x16RomSourceDir, cx16WorkDir,
  CX16_INSTALL_DIR, X16EMU_INSTALL_PATH, MAKECART_INSTALL_PATH, CX16_ROM_INSTALL_PATH,
  LOCAL_BIN_DIR, X16EMU_LAUNCHER_PATH, MAKECART_LAUNCHER_PATH,
} from './paths.mjs';

export const X16_EMULATOR_REPO = 'https://github.com/X16Community/x16-emulator.git';
export const X16_ROM_REPO = 'https://github.com/X16Community/x16-rom.git';

/** The one tested `exec` line for the macOS wrapper — `"$@"` after the
 * explicit ROM so `8bs run cx16`'s `-prg <file> -run` still gets through. */
export const X16EMU_WRAPPER_EXEC_LINE = `exec ${X16EMU_INSTALL_PATH} -rom ${CX16_ROM_INSTALL_PATH} "$@"`;

/**
 * Per-platform installation strategy. Deliberately a table, not a set of
 * `if (darwin)` branches: the x16emu launcher kind is the whole reason this
 * table exists (see the module comment), and the next retro target that
 * needs a platform split should add a column here rather than an assumption
 * somewhere else.
 */
export const CX16_PLATFORMS = Object.freeze({
  darwin: Object.freeze({ name: 'macOS', packageManager: 'brew', x16emuLauncher: 'wrapper', makecartLauncher: 'symlink' }),
  linux: Object.freeze({ name: 'Linux', packageManager: 'pacman', x16emuLauncher: 'symlink', makecartLauncher: 'symlink' }),
});

// ---- pure helpers, unit-tested --------------------------------------------

/** "### Release 50 ("next") 77f2bab3" -> "Release 50". Never requires a
 * specific release: the installer builds whatever upstream currently is. */
export function parseX16emuVersion(output) {
  const match = /Release\s+(\d+)/i.exec(output ?? '');
  return match ? `Release ${match[1]}` : null;
}

/** The path x16emu complained about, from "Cannot open <path>!" — the
 * exact symptom of the macOS symlink trap (and of any missing ROM). */
export function romLoadFailure(output) {
  const match = /Cannot open (.+?)!/.exec(output ?? '');
  return match ? match[1] : null;
}

/** Did a `-testbench` run boot the ROM? Testbench mode with stdin closed
 * (confirmed against a real r50 build) prints "Testbench mode...", boots to
 * the KERNAL's "RDY", then "Exit testbench." and exits 0 — with no window.
 * A ROM it can't open exits 1 with "Cannot open <path>!" instead. */
export function testbenchBooted({ code, output }) {
  return code === 0 && /\bRDY\b/.test(output ?? '') && !romLoadFailure(output);
}

// ---- inspection (shared with doctor.mjs) ----------------------------------

const defaultFs = {
  exists: pathExists, statFn: stat, accessFn: access, lstatFn: lstat, readlinkFn: readlink, readFileFn: readFile,
};

/** Is there a usable ROM at `path`: a regular, readable, non-empty file?
 * Existence alone isn't enough — an empty file left by an interrupted copy
 * satisfies `-e` and still can't boot anything. */
export async function inspectRomFile(path, fs = {}) {
  const { statFn, accessFn } = { ...defaultFs, ...fs };
  let stats;
  try {
    stats = await statFn(path);
  } catch {
    return { state: 'missing', path };
  }
  if (!stats.isFile()) return { state: 'not-a-file', path };
  if (stats.size === 0) return { state: 'empty', path, size: 0 };
  try {
    await accessFn(path, fsConstants.R_OK);
  } catch {
    return { state: 'unreadable', path, size: stats.size };
  }
  return { state: 'ok', path, size: stats.size };
}

export function x16emuLauncherSpec(platform) {
  return { path: X16EMU_LAUNCHER_PATH, target: X16EMU_INSTALL_PATH, execLine: X16EMU_WRAPPER_EXEC_LINE, kind: CX16_PLATFORMS[platform]?.x16emuLauncher ?? 'symlink' };
}

export function makecartLauncherSpec(platform) {
  return { path: MAKECART_LAUNCHER_PATH, target: MAKECART_INSTALL_PATH, execLine: null, kind: CX16_PLATFORMS[platform]?.makecartLauncher ?? 'symlink' };
}

/**
 * Every separately-detectable state of a Commander X16 installation, in one
 * read-only pass: source checkouts, build artifacts, installed binaries and
 * ROM, and both launchers. setupCx16() decides what to do from this;
 * doctor.mjs reports from the same shape so the two never disagree about
 * what "installed" means.
 */
export async function inspectCx16Installation({
  platform = process.platform, emulatorSourceDir = x16EmulatorSourceDir(), romSourceDir = x16RomSourceDir(),
} = {}, fs = {}) {
  const io = { ...defaultFs, ...fs };
  const [sourceEmulator, sourceRom, buildEmulator, buildMakecart, buildRom] = await Promise.all([
    io.exists(join(emulatorSourceDir, '.git')),
    io.exists(join(romSourceDir, '.git')),
    io.exists(join(emulatorSourceDir, 'build', 'x16emu')),
    io.exists(join(emulatorSourceDir, 'build', 'makecart')),
    io.exists(join(romSourceDir, 'build', 'x16', 'rom.bin')),
  ]);
  const [emulatorInstalled, makecartInstalled] = await Promise.all([
    io.exists(X16EMU_INSTALL_PATH), io.exists(MAKECART_INSTALL_PATH),
  ]);
  const rom = await inspectRomFile(CX16_ROM_INSTALL_PATH, io);
  const launcher = await inspectLauncher(x16emuLauncherSpec(platform), io);
  const makecartLauncher = await inspectLauncher(makecartLauncherSpec(platform), io);
  const installed = emulatorInstalled && makecartInstalled && rom.state === 'ok';
  return {
    platform,
    source: { emulator: sourceEmulator, rom: sourceRom },
    build: { emulator: buildEmulator && buildMakecart, rom: buildRom },
    emulatorInstalled,
    makecartInstalled,
    rom,
    launcher,
    makecartLauncher,
    installed,
    launcherOk: launcher.state === x16emuLauncherSpec(platform).kind,
    complete: installed && launcher.state === x16emuLauncherSpec(platform).kind
      && makecartLauncher.state === makecartLauncherSpec(platform).kind,
  };
}

/** Is `inspection` (from inspectLauncher) the tested-broken macOS layout:
 * x16emu on PATH as a direct symlink into /opt/commander-x16? */
export function isBrokenMacosSymlink(platform, inspection) {
  return platform === 'darwin' && inspection?.state === 'symlink';
}

// ---- build ----------------------------------------------------------------

/** Clone/update x16-emulator and `make` it. The repository's Makefile
 * delegates to CMake (`cmake -S . -B build -DCMAKE_BUILD_TYPE=Release`,
 * `cmake --build build`); the artifacts land in build/, not the repo root.
 * AppleClang's "ld: warning: reducing alignment of section" is expected and
 * not a failure — see source.mjs's runBuild(). */
export async function buildX16Emulator({
  sourceDir = x16EmulatorSourceDir(), repo = X16_EMULATOR_REPO, exec = execInherit, exists = pathExists, mkdirFn = mkdir,
} = {}) {
  const sync = await syncRepository({ sourceDir, repo, exec, exists, mkdirFn });
  if (!sync.ok) return sync;
  const emulatorPath = join(sourceDir, 'build', 'x16emu');
  const makecartPath = join(sourceDir, 'build', 'makecart');
  const build = await runBuild({ cwd: sourceDir, artifacts: [emulatorPath, makecartPath], exec, exists });
  if (!build.ok) return build;
  return { ok: true, emulatorPath, makecartPath };
}

/** Clone/update x16-rom and `make` it (cc65 + lzsa + python underneath).
 * The build prints pages of ca65/ld65 warnings on a perfectly good run;
 * only a non-zero exit or a missing build/x16/rom.bin is a failure. */
export async function buildX16Rom({
  sourceDir = x16RomSourceDir(), repo = X16_ROM_REPO, exec = execInherit, exists = pathExists, mkdirFn = mkdir,
} = {}) {
  const sync = await syncRepository({ sourceDir, repo, exec, exists, mkdirFn });
  if (!sync.ok) return sync;
  const romPath = join(sourceDir, 'build', 'x16', 'rom.bin');
  const build = await runBuild({ cwd: sourceDir, artifacts: [romPath], exec, exists });
  if (!build.ok) return build;
  return { ok: true, romPath };
}

/** Boot the freshly-built emulator against the freshly-built ROM, headless,
 * before either is installed — `-testbench` with stdin closed (see
 * testbenchBooted()). Both `-version` and the boot go through the real
 * binary with an explicit `-rom`, so this validates the pair itself, not
 * any launcher. */
export async function validateX16Pair({ emulatorPath, romPath, exec = execCapture }) {
  const version = await exec(emulatorPath, ['-rom', romPath, '-version'], { timeout: 30_000 });
  const boot = await exec(emulatorPath, ['-rom', romPath, '-testbench'], { timeout: 60_000 });
  const output = (boot.stdout ?? '') + (boot.stderr ?? '');
  if (boot.missing) return { ok: false, detail: `could not run ${emulatorPath}` };
  if (!testbenchBooted({ code: boot.code, output })) {
    const failure = romLoadFailure(output);
    return {
      ok: false,
      detail: failure
        ? `x16emu could not open ${failure}`
        : `x16emu -testbench did not boot (exit ${boot.code}): ${output.trim().split('\n').pop() || 'no output'}`,
    };
  }
  return { ok: true, version: parseX16emuVersion((version.stdout ?? '') + (version.stderr ?? '')) };
}

// ---- the setup pipeline ---------------------------------------------------

// Every I/O boundary setupCx16() touches, as one overridable bag — real by
// default, fakes in tests (the brief: no sudo, Homebrew, clones, or builds
// in unit tests). Same shape as mega65.mjs's generateRom() io bag.
const defaultIo = {
  platform: process.platform,
  env: process.env,
  exec: execCapture,
  execLive: execInherit,
  sudoExec: sudoRun,
  hasBinary: hasBinaryOnPath,
  exists: pathExists,
  statFn: stat,
  accessFn: access,
  lstatFn: lstat,
  readlinkFn: readlink,
  readFileFn: readFile,
  mkdirFn: mkdir,
  writeFileFn: writeFile,
  confirm,
  canPromptInteractively,
  emulatorSourceDir: x16EmulatorSourceDir,
  romSourceDir: x16RomSourceDir,
  workDir: cx16WorkDir,
  buildEmulator: buildX16Emulator,
  buildRom: buildX16Rom,
  validatePair: validateX16Pair,
};

async function checkCompiler(io) {
  const home = io.env.LLVM_MOS_HOME;
  if (!home) return { ok: false, detail: 'LLVM_MOS_HOME is not set — docs/setup/llvm-mos.md' };
  const driver = join(home, 'bin', 'mos-cx16-clang');
  const r = await io.exec(driver, ['--version']);
  if (r.missing) return { ok: false, detail: `mos-cx16-clang not found at ${driver} — docs/setup/llvm-mos.md` };
  return { ok: true, detail: 'mos-cx16-clang' };
}

/** macOS host prerequisites: the Apple Command Line Tools (checked with
 * `xcode-select -p` before ever offering the installer), then Homebrew —
 * required by this backend, found via PATH (never a hardcoded
 * /opt/homebrew), and never bootstrapped by curl on the user's behalf. */
async function ensureMacosPrerequisites(io) {
  if (!(await hasXcodeCommandLineTools(io.exec))) {
    reportLine('\n  The Apple Command Line Tools are required to build x16emu (xcode-select --install).');
    if (io.canPromptInteractively() && await io.confirm('  Open the Command Line Tools installer now?', { defaultValue: true })) {
      await installXcodeCommandLineTools(io.execLive);
      return { ok: false, label: 'Xcode CLT', detail: 'installer opened — re-run `8bs setup cx16` once it finishes' };
    }
    return { ok: false, label: 'Xcode CLT', detail: 'run: xcode-select --install, then re-run `8bs setup cx16`' };
  }
  reportStep('ok', 'Xcode CLT', 'installed');
  if (!io.hasBinary('brew')) {
    reportLine('\n  Homebrew is required by the macOS Commander X16 setup backend, and `brew` is not on PATH.');
    reportLine('  Install it from https://brew.sh (8bs will not run the bootstrap script for you),');
    reportLine('  make sure `brew` is on PATH in this shell, then re-run `8bs setup cx16`.');
    return { ok: false, label: 'Homebrew', detail: 'not found — https://brew.sh' };
  }
  reportStep('ok', 'Homebrew', 'found');
  return { ok: true };
}

async function ensureDependencies(io, platform) {
  if (platform.packageManager === 'brew') {
    const missing = await missingBrewPackages(CX16_BREW_PACKAGES, io.exec);
    if (missing.length === 0) return { ok: true, detail: 'installed' };
    reportLine(`\n  The Commander X16 build needs: ${missing.join(' ')}`);
    const hint = `run: brew install ${missing.join(' ')}`;
    if (!io.canPromptInteractively()) return { ok: false, detail: hint };
    if (!(await io.confirm('  Install with Homebrew now?', { defaultValue: true }))) return { ok: false, detail: hint };
    const result = await installBrewPackages(missing, io.execLive);
    if (result.code !== 0) return { ok: false, detail: 'brew reported an error — see the output above' };
    return { ok: true, detail: 'installed' };
  }
  // Linux (Arch/Manjaro): official packages via pacman, plus the two
  // AUR-only tools checked on PATH with a pointer rather than an install —
  // there's no single trusted AUR helper to run unattended.
  const missing = await missingPacmanPackages(CX16_PACMAN_PACKAGES, io.exec);
  if (missing.length > 0) {
    reportLine(`\n  The Commander X16 build needs: ${missing.join(' ')}`);
    const hint = `run: sudo pacman -S --needed ${missing.join(' ')}`;
    if (!io.canPromptInteractively()) return { ok: false, detail: hint };
    if (!(await io.confirm('  Install with pacman now?', { defaultValue: true }))) return { ok: false, detail: hint };
    const result = await installPacmanPackages(missing, io.sudoExec);
    if (result.code !== 0) return { ok: false, detail: 'pacman reported an error — see the output above' };
  }
  const aur = missingPathTools(CX16_AUR_TOOLS, io.hasBinary);
  if (aur.length > 0) {
    return { ok: false, detail: `${aur.join(' and ')} not on PATH — AUR only; run: pamac build ${aur.join(' ')} (docs/setup/cx16.md)` };
  }
  return { ok: true, detail: 'installed' };
}

async function buildPair(io) {
  const buildFs = { exec: io.execLive, exists: io.exists, mkdirFn: io.mkdirFn };
  reportStep('running', 'emulator', 'cloning/updating and building x16-emulator');
  const emulator = await io.buildEmulator({ sourceDir: io.emulatorSourceDir(), ...buildFs });
  if (!emulator.ok) {
    const why = emulator.missingArtifact ? `built, but ${emulator.missingArtifact} is missing` : `failed at '${emulator.step}' (exit ${emulator.code})`;
    return { ok: false, label: 'emulator', detail: `x16-emulator build ${why} — docs/setup/cx16.md` };
  }
  reportStep('ok', 'emulator', emulator.emulatorPath);
  reportStep('running', 'ROM', 'cloning/updating and building x16-rom');
  const rom = await io.buildRom({ sourceDir: io.romSourceDir(), ...buildFs });
  if (!rom.ok) {
    const why = rom.missingArtifact ? `built, but ${rom.missingArtifact} is missing` : `failed at '${rom.step}' (exit ${rom.code})`;
    return { ok: false, label: 'ROM', detail: `x16-rom build ${why} — docs/setup/cx16.md` };
  }
  reportStep('ok', 'ROM', rom.romPath);
  const pair = await io.validatePair({ emulatorPath: emulator.emulatorPath, romPath: rom.romPath, exec: io.exec });
  if (!pair.ok) return { ok: false, label: 'validate', detail: pair.detail };
  reportStep('ok', 'validate', `${pair.version ?? 'x16emu'} boots the freshly built ROM`);
  return { ok: true, ...emulator, romPath: rom.romPath };
}

/** `sudo mkdir -p` only when the directory is actually absent — a re-run
 * against a complete install must never prompt for a password just to
 * re-create a directory that's already there. */
async function ensureDirectoryIfMissing(io, dir) {
  if (await io.exists(dir)) return { ok: true };
  return ensureDirectory(dir, io.sudoExec);
}

async function installPair(io, built) {
  const dir = await ensureDirectoryIfMissing(io, CX16_INSTALL_DIR);
  if (!dir.ok) return { ok: false, detail: `sudo mkdir ${CX16_INSTALL_DIR} failed (exit ${dir.code})` };
  const result = await installFiles([
    { src: built.emulatorPath, dst: X16EMU_INSTALL_PATH, mode: '755' },
    { src: built.makecartPath, dst: MAKECART_INSTALL_PATH, mode: '755' },
    { src: built.romPath, dst: CX16_ROM_INSTALL_PATH, mode: '644' },
  ], io.sudoExec, { identical: (a, b) => filesIdenticalWith(io, a, b) });
  if (!result.ok) return { ok: false, detail: `sudo install ${result.path} failed (exit ${result.code})` };
  const detail = result.installed.length === 0
    ? `${CX16_INSTALL_DIR} (already current)`
    : `${CX16_INSTALL_DIR} (${result.installed.length === 3 ? 'x16emu, makecart, rom.bin' : result.installed.map((p) => p.split('/').pop()).join(', ')})`;
  return { ok: true, detail };
}

async function filesIdenticalWith(io, a, b) {
  try {
    const [x, y] = await Promise.all([io.readFileFn(a), io.readFileFn(b)]);
    return Buffer.compare(Buffer.from(x), Buffer.from(y)) === 0;
  } catch {
    return false;
  }
}

function describeForeign(inspection) {
  if (inspection.state === 'foreign-symlink') return `a symlink to ${inspection.target}`;
  const first = (inspection.content ?? '').split('\n').find((l) => l.trim() && !l.startsWith('#!'));
  return first ? `a file that isn't managed by 8bs (first line: ${first.trim().slice(0, 60)})` : 'a file that isn\'t managed by 8bs';
}

async function confirmReplaceLauncher(io, inspection) {
  reportLine(`\n  ${inspection.path} already exists and is ${describeForeign(inspection)}.`);
  if (!io.canPromptInteractively()) {
    reportLine('  Not replacing it without confirmation — remove or rename it, then re-run `8bs setup cx16`.');
    return false;
  }
  return io.confirm('  Replace it with the 8bs-managed launcher?', { defaultValue: false });
}

async function ensureLaunchers(io, platform) {
  const bin = await ensureDirectoryIfMissing(io, LOCAL_BIN_DIR);
  if (!bin.ok) return { ok: false, label: 'launcher', detail: `sudo mkdir ${LOCAL_BIN_DIR} failed (exit ${bin.code})` };
  const fs = { lstatFn: io.lstatFn, readlinkFn: io.readlinkFn, readFileFn: io.readFileFn, mkdirFn: io.mkdirFn, writeFileFn: io.writeFileFn };
  const confirmReplace = (inspection) => confirmReplaceLauncher(io, inspection);

  const x16emu = await ensureLauncher({ ...x16emuLauncherSpec(io.platform), sudoExec: io.sudoExec, workDir: io.workDir(), confirmReplace }, fs);
  if (!x16emu.ok) {
    return {
      ok: false, label: 'launcher',
      detail: x16emu.action === 'skipped-foreign' ? `${X16EMU_LAUNCHER_PATH} left untouched` : `sudo ${x16emu.step} failed (exit ${x16emu.code})`,
    };
  }
  const kind = platform.x16emuLauncher === 'wrapper' ? `wrapper, -rom ${CX16_ROM_INSTALL_PATH}` : `symlink -> ${X16EMU_INSTALL_PATH}`;
  const repaired = x16emu.action === 'repaired' && isBrokenMacosSymlink(io.platform, x16emu.inspection);
  reportStep('ok', 'launcher', `${X16EMU_LAUNCHER_PATH} (${kind}${repaired ? '; replaced the direct symlink that could not find rom.bin' : x16emu.action === 'unchanged' ? '' : `; ${x16emu.action}`})`);

  const makecart = await ensureLauncher({ ...makecartLauncherSpec(io.platform), sudoExec: io.sudoExec, workDir: io.workDir(), confirmReplace }, fs);
  if (!makecart.ok) {
    return {
      ok: false, label: 'makecart',
      detail: makecart.action === 'skipped-foreign' ? `${MAKECART_LAUNCHER_PATH} left untouched` : `sudo ${makecart.step} failed (exit ${makecart.code})`,
    };
  }
  reportStep('ok', 'makecart', `${MAKECART_LAUNCHER_PATH} -> ${MAKECART_INSTALL_PATH}`);
  return { ok: true };
}

/** Run the *installed launcher* — not the /opt binary — headless, exactly as
 * `8bs run cx16` and the user will invoke it. This is the check that would
 * have caught the macOS symlink trap: `-version` alone never touches the
 * ROM (confirmed: it succeeds even with `-rom /nonexistent`), so only a
 * real boot proves the launcher supplies a ROM the emulator can open. */
async function verifyLauncher(io) {
  const version = await io.exec(X16EMU_LAUNCHER_PATH, ['-version'], { timeout: 30_000 });
  const boot = await io.exec(X16EMU_LAUNCHER_PATH, ['-testbench'], { timeout: 60_000 });
  if (version.missing || boot.missing) return { ok: false, detail: `could not run ${X16EMU_LAUNCHER_PATH}` };
  const output = (boot.stdout ?? '') + (boot.stderr ?? '');
  if (!testbenchBooted({ code: boot.code, output })) {
    const failure = romLoadFailure(output);
    return { ok: false, detail: failure ? `x16emu could not open ${failure} — run: 8bs setup cx16 --repair` : `x16emu -testbench did not boot (exit ${boot.code})` };
  }
  const release = parseX16emuVersion((version.stdout ?? '') + (version.stderr ?? ''));
  return { ok: true, detail: `${release ?? 'x16emu'} boots via ${X16EMU_LAUNCHER_PATH}` };
}

/**
 * @param {{ repair?: boolean, update?: boolean }} options — `--repair` is
 *   accepted for readability (it's what `8bs doctor` suggests for a broken
 *   launcher) and behaves exactly like a plain run, which already repairs
 *   without rebuilding; `--update` forces a fresh pull, build and install
 *   of the emulator+ROM pair even when everything is already in place.
 * @returns {Promise<{ok: boolean}>}
 */
export async function setupCx16(options = {}, ioOverrides = {}) {
  const io = { ...defaultIo, ...ioOverrides };
  reportLine('Commander X16 setup\n');

  const platform = CX16_PLATFORMS[io.platform];
  if (!platform) {
    reportStep('attn', 'platform', `no Commander X16 setup backend for '${io.platform}' — docs/setup/cx16.md`);
    return { ok: false };
  }
  reportStep('ok', 'platform', `${platform.name} (x16emu launcher: ${platform.x16emuLauncher})`);

  const compiler = await checkCompiler(io);
  reportStep(compiler.ok ? 'ok' : 'attn', 'compiler', compiler.detail);
  if (!compiler.ok) return { ok: false };

  const fs = { exists: io.exists, statFn: io.statFn, accessFn: io.accessFn, lstatFn: io.lstatFn, readlinkFn: io.readlinkFn, readFileFn: io.readFileFn };
  const state = await inspectCx16Installation({ platform: io.platform, emulatorSourceDir: io.emulatorSourceDir(), romSourceDir: io.romSourceDir() }, fs);

  if (state.installed && !options.update) {
    reportStep('ok', 'installed', `${CX16_INSTALL_DIR} (x16emu, makecart, rom.bin already present)`);
  } else {
    if (state.emulatorInstalled || state.makecartInstalled || state.rom.state === 'ok') {
      const missing = [
        !state.emulatorInstalled && 'x16emu', !state.makecartInstalled && 'makecart',
        state.rom.state !== 'ok' && (state.rom.state === 'missing' ? 'rom.bin' : `rom.bin is ${state.rom.state}`),
      ].filter(Boolean);
      if (missing.length) reportLine(`  ${CX16_INSTALL_DIR} is incomplete (missing: ${missing.join(', ')}) — rebuilding the emulator+ROM pair together so they match.`);
    }
    if (io.platform === 'darwin') {
      const host = await ensureMacosPrerequisites(io);
      if (!host.ok) {
        reportStep('attn', host.label, host.detail);
        return { ok: false };
      }
    }
    const deps = await ensureDependencies(io, platform);
    reportStep(deps.ok ? 'ok' : 'attn', 'dependencies', deps.detail);
    if (!deps.ok) return { ok: false };

    const built = await buildPair(io);
    if (!built.ok) {
      reportStep('attn', built.label, built.detail);
      return { ok: false };
    }
    const installed = await installPair(io, built);
    reportStep(installed.ok ? 'ok' : 'attn', 'installed', installed.detail);
    if (!installed.ok) return { ok: false };
  }

  const launchers = await ensureLaunchers(io, platform);
  if (!launchers.ok) {
    reportStep('attn', launchers.label, launchers.detail);
    return { ok: false };
  }

  if (!isDirOnPath(LOCAL_BIN_DIR, io.env)) {
    reportStep('attn', 'PATH', `${LOCAL_BIN_DIR} is not on PATH in this shell — add it, or \`8bs run cx16\` won't find x16emu`);
  } else {
    reportStep('ok', 'PATH', `${LOCAL_BIN_DIR} is on PATH`);
  }

  const verified = await verifyLauncher(io);
  reportStep(verified.ok ? 'ok' : 'attn', 'verified', verified.detail);
  if (!verified.ok) return { ok: false };

  reportLine('\nCommander X16 is ready.');
  return { ok: true };
}
