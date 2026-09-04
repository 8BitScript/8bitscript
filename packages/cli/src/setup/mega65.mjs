// `8bs setup mega65` — get a macOS or Arch/Manjaro machine from nothing to a
// working `8bs run mega65`: the mos-mega65-clang compiler (checked, not
// installed — see docs/setup/llvm-mos.md), Xemu's MEGA65 core built from
// source, and a legally-obtained MEGA65 ROM installed where both Xemu and
// `8bs doctor` expect it. Every step is idempotent — safe to re-run after a
// partial failure, or just to confirm everything is still in place.
//
// Platform strategies are an explicit table (MEGA65_PLATFORMS below), same
// shape as setup/cx16.mjs's CX16_PLATFORMS — unlike x16emu, xmega65 needs no
// macOS-specific launcher trick (see xemu.mjs's xmega65LauncherSpec()), but
// the package manager and host prerequisites still differ per platform.
import {
  lstat, mkdir as fsMkdir, readFile, readlink, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { execCapture, execInherit, sudoRun } from './exec.mjs';
import { reportStep, reportLine } from './report.mjs';
import { promptLine, confirm, canPromptInteractively } from './prompt.mjs';
import {
  missingPacmanPackages, installPacmanPackages, missingBrewPackages, installBrewPackages,
  XEMU_BUILD_PACKAGES, MSITOOLS_PACKAGE, MEGA65_BREW_PACKAGES,
} from './deps.mjs';
import { hasBinaryOnPath, hasXcodeCommandLineTools, installXcodeCommandLineTools } from './host.mjs';
import { pathExists } from './source.mjs';
import { ensureDirectory } from './install.mjs';
import { ensureLauncher } from './launcher.mjs';
import {
  buildXemuMega65, installXemu, xmega65LauncherSpec, ensureXemuDataDir, inspectXemuDataDir,
} from './xemu.mjs';
import {
  extractC64ForeverMsi, locateC65BaseRom, fetchRomPatch, buildRomdiff, patchRom, cleanupWorkDir,
} from './mega65-rom.mjs';
import {
  C65_BASE_ROM, MEGA65_ROM_920413, validateRomBuffer, ensureXemuRomLink, inspectXemuRomLink,
} from './rom.mjs';
import {
  XEMU_INSTALL_DIR, XMEGA65_INSTALL_PATH, XMEGA65_SYMLINK_PATH,
  MEGA65_ROM_CANONICAL_PATH, MEGA65_ROM_INSTALL_DIR, LOCAL_BIN_DIR,
  xemuRomLinkPath, xemuMega65RealDataDir, mega65WorkDir,
} from './paths.mjs';

/**
 * Per-platform installation strategy — same idea as CX16_PLATFORMS, kept as
 * a table rather than `if (darwin)` branches for the same reason: the next
 * source-built target that needs a platform split should add a column here.
 */
export const MEGA65_PLATFORMS = Object.freeze({
  darwin: Object.freeze({ name: 'macOS', packageManager: 'brew' }),
  linux: Object.freeze({ name: 'Linux', packageManager: 'pacman' }),
});

// msitools (msiextract) is only needed once the ROM step actually extracts a
// C64 Forever MSI — that flow is Linux-oriented and gated behind the
// explicit `--c64-forever` flag (see ensureRom() below) — but it's checked
// alongside the Xemu build dependencies up front on Arch/Manjaro either way:
// one pacman prompt instead of two, and a no-op `pacman -T` check when it's
// already installed.
const ALL_PACMAN_PACKAGES = [...XEMU_BUILD_PACKAGES, MSITOOLS_PACKAGE];

/** `~` and `~/...` expansion for a path a user typed at a prompt — the
 * brief's own example input is `~/Downloads/MEGA65.ROM`, and nothing else
 * in this pipeline expands that. */
export function expandHome(path) {
  if (!path) return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

// Every I/O boundary setupMega65() touches, as one overridable bag — real by
// default, fakes in tests (the brief: no sudo, Homebrew/pacman, clones,
// builds, or GUI launches in unit tests). Same shape as cx16.mjs's defaultIo.
const defaultIo = {
  platform: process.platform,
  env: process.env,
  exec: execCapture,
  execLive: execInherit,
  sudoExec: sudoRun,
  hasBinary: hasBinaryOnPath,
  exists: pathExists,
  lstatFn: lstat,
  readlinkFn: readlink,
  readFileFn: readFile,
  mkdirFn: fsMkdir,
  writeFileFn: writeFile,
  symlinkFn: symlink,
  unlinkFn: unlink,
  // Injectable so tests can exercise a "valid ROM" outcome without the real
  // copyrighted 920413 bytes — same idea as generateRom()'s own tests,
  // which fake patchRomFn's validation result rather than matching the
  // real hash. Production code never overrides this.
  validateRom: validateRomBuffer,
  confirm,
  promptLine,
  canPromptInteractively,
  workDir: mega65WorkDir,
  buildXemu: buildXemuMega65,
  fetchImpl: (typeof fetch === 'function' ? fetch : undefined),
};

async function checkCompiler(io) {
  const home = io.env.LLVM_MOS_HOME;
  if (!home) return { ok: false, detail: 'LLVM_MOS_HOME is not set — docs/setup/llvm-mos.md' };
  const driver = join(home, 'bin', 'mos-mega65-clang');
  const r = await io.exec(driver, ['--version']);
  if (r.missing) return { ok: false, detail: `mos-mega65-clang not found at ${driver} — docs/setup/llvm-mos.md` };
  return { ok: true, detail: 'mos-mega65-clang' };
}

/** macOS host prerequisites: the Apple Command Line Tools (checked with
 * `xcode-select -p` before ever offering the installer), then Homebrew —
 * found via PATH, never a hardcoded /opt/homebrew, and never bootstrapped by
 * curl on the user's behalf. Same shape as cx16.mjs's ensureMacosPrerequisites(). */
async function ensureMacosPrerequisites(io) {
  if (!(await hasXcodeCommandLineTools(io.exec))) {
    reportLine('\n  The Apple Command Line Tools are required to build xmega65 (xcode-select --install).');
    if (io.canPromptInteractively() && await io.confirm('  Open the Command Line Tools installer now?', { defaultValue: true })) {
      await installXcodeCommandLineTools(io.execLive);
      return { ok: false, label: 'Xcode CLT', detail: 'installer opened — re-run `8bs setup mega65` once it finishes' };
    }
    return { ok: false, label: 'Xcode CLT', detail: 'run: xcode-select --install, then re-run `8bs setup mega65`' };
  }
  reportStep('ok', 'Xcode CLT', 'installed');
  if (!io.hasBinary('brew')) {
    reportLine('\n  Homebrew is required by the macOS MEGA65 setup backend, and `brew` is not on PATH.');
    reportLine('  Install it from https://brew.sh (8bs will not run the bootstrap script for you),');
    reportLine('  make sure `brew` is on PATH in this shell, then re-run `8bs setup mega65`.');
    return { ok: false, label: 'Homebrew', detail: 'not found — https://brew.sh' };
  }
  reportStep('ok', 'Homebrew', 'found');
  return { ok: true };
}

async function ensureDependencies(io, platform) {
  if (platform.packageManager === 'brew') {
    const missing = await missingBrewPackages(MEGA65_BREW_PACKAGES, io.exec);
    if (missing.length === 0) return { ok: true, detail: 'installed' };
    reportLine(`\n  Xemu's MEGA65 build needs: ${missing.join(' ')}`);
    const hint = `run: brew install ${missing.join(' ')}`;
    if (!io.canPromptInteractively()) return { ok: false, detail: hint };
    if (!(await io.confirm('  Install with Homebrew now?', { defaultValue: true }))) return { ok: false, detail: hint };
    const result = await installBrewPackages(missing, io.execLive);
    if (result.code !== 0) return { ok: false, detail: 'brew reported an error — see the output above' };
    return { ok: true, detail: 'installed' };
  }
  const missing = await missingPacmanPackages(ALL_PACMAN_PACKAGES, io.exec);
  if (missing.length === 0) return { ok: true, detail: 'installed' };
  reportLine(`\n  Xemu's MEGA65 build needs: ${missing.join(' ')}`);
  const hint = `run: sudo pacman -S --needed ${missing.join(' ')}`;
  if (!io.canPromptInteractively()) return { ok: false, detail: hint };
  if (!(await io.confirm('  Install with pacman now?', { defaultValue: true }))) return { ok: false, detail: hint };
  const result = await installPacmanPackages(missing, io.sudoExec);
  if (result.code !== 0) return { ok: false, detail: 'pacman reported an error — see the output above' };
  return { ok: true, detail: 'installed' };
}

function describeForeignLauncher(inspection) {
  if (inspection.state === 'foreign-symlink') return `a symlink to ${inspection.target}`;
  const first = (inspection.content ?? '').split('\n').find((l) => l.trim() && !l.startsWith('#!'));
  return first ? `a file that isn't managed by 8bs (first line: ${first.trim().slice(0, 60)})` : 'a file that isn\'t managed by 8bs';
}

async function confirmReplaceLauncher(io, inspection) {
  reportLine(`\n  ${XMEGA65_SYMLINK_PATH} already exists and is ${describeForeignLauncher(inspection)}.`);
  if (!io.canPromptInteractively()) {
    reportLine('  Not replacing it without confirmation — remove or rename it, then re-run `8bs setup mega65`.');
    return false;
  }
  return io.confirm('  Replace it with the 8bs-managed launcher?', { defaultValue: false });
}

/** `sudo mkdir -p` only when the directory is actually absent — a re-run
 * against a complete install must never prompt for a password just to
 * re-create a directory that's already there. Same helper as cx16.mjs's
 * ensureDirectoryIfMissing(). */
async function ensureDirectoryIfMissing(io, dir) {
  if (await io.exists(dir)) return { ok: true };
  return ensureDirectory(dir, io.sudoExec);
}

/** Put xmega65 on PATH: a plain symlink works on every platform this
 * project supports (see xemu.mjs's xmega65LauncherSpec() for why that's
 * notable). Foreign content at the launcher path is reported and left
 * alone unless the user confirms replacing it — never silently overwritten. */
async function ensureXmega65Launcher(io) {
  const bin = await ensureDirectoryIfMissing(io, LOCAL_BIN_DIR);
  if (!bin.ok) return { ok: false, detail: `sudo mkdir ${LOCAL_BIN_DIR} failed (exit ${bin.code})` };
  const fs = { lstatFn: io.lstatFn, readlinkFn: io.readlinkFn, readFileFn: io.readFileFn, mkdirFn: io.mkdirFn, writeFileFn: io.writeFileFn };
  const confirmReplace = (inspection) => confirmReplaceLauncher(io, inspection);
  const result = await ensureLauncher({ ...xmega65LauncherSpec(), sudoExec: io.sudoExec, workDir: io.workDir(), confirmReplace }, fs);
  if (!result.ok) {
    return {
      ok: false,
      detail: result.action === 'skipped-foreign' ? `${XMEGA65_SYMLINK_PATH} left untouched` : `sudo ${result.step} failed (exit ${result.code})`,
    };
  }
  reportStep('ok', 'launcher', `${XMEGA65_SYMLINK_PATH} -> ${XMEGA65_INSTALL_PATH}${result.action === 'unchanged' ? '' : `; ${result.action}`}`);
  return { ok: true };
}

async function ensureEmulator(io) {
  if (await io.exists(XMEGA65_INSTALL_PATH)) {
    reportStep('ok', 'emulator', XMEGA65_INSTALL_PATH);
  } else {
    reportStep('running', 'emulator', 'building Xemu MEGA65 target');
    const build = await io.buildXemu({ exec: io.execLive, exists: io.exists, mkdirFn: io.mkdirFn });
    if (!build.ok) {
      return { ok: false, detail: `xemu build failed at '${build.step}' (exit ${build.code}) — docs/setup/mega65.md` };
    }
    const install = await installXemu(build.binaryPath, { sudoExec: io.sudoExec, installDir: XEMU_INSTALL_DIR, installPath: XMEGA65_INSTALL_PATH });
    if (!install.ok) {
      return { ok: false, detail: `installing xmega65 failed at '${install.step}' (exit ${install.code})` };
    }
    reportStep('ok', 'emulator', install.installPath);
  }
  return ensureXmega65Launcher(io);
}

async function installCanonicalRom(buffer, sudoExec, io) {
  const { mkdirFn, writeFileFn, workDirPath } = io;
  const workPath = join(workDirPath, 'MEGA65.ROM');
  await mkdirFn(workDirPath, { recursive: true });
  await writeFileFn(workPath, buffer);
  const mkdirResult = await sudoExec('mkdir', ['-p', MEGA65_ROM_INSTALL_DIR]);
  if (mkdirResult.code !== 0) return { ok: false, detail: `sudo mkdir ${MEGA65_ROM_INSTALL_DIR} failed` };
  const installResult = await sudoExec('install', ['-m644', workPath, MEGA65_ROM_CANONICAL_PATH]);
  if (installResult.code !== 0) return { ok: false, detail: `sudo install ${MEGA65_ROM_CANONICAL_PATH} failed` };
  return { ok: true };
}

// Every piece of I/O generateRom() touches, as one overridable bag — real
// implementations by default, fakes in tests. Kept as a single object rather
// than a long parameter list because every one of these is a genuine
// external boundary (process, network, filesystem, or a terminal prompt) the
// brief asks not to exercise for real in a unit test.
const defaultRomIo = {
  workDirPath: () => mega65WorkDir(),
  exists: pathExists,
  promptLine,
  canPromptInteractively,
  mkdirFn: fsMkdir,
  writeFileFn: writeFile,
  extractMsi: (msiPath, destDir) => extractC64ForeverMsi(msiPath, destDir, execInherit),
  locateBaseRom: locateC65BaseRom,
  fetchPatch: fetchRomPatch,
  buildRomdiffFn: buildRomdiff,
  patchRomFn: patchRom,
  cleanup: cleanupWorkDir,
};

/**
 * Extract the C65 base ROM from a C64 Forever MSI, fetch the official
 * 920413 patch, build romdiff, and patch the two together — the one part of
 * `8bs setup mega65` this project cannot do without the user's own legally
 * obtained files (see docs/setup/mega65.md). Only reached when the user
 * opts in with `--c64-forever` — the macOS milestone's primary path is
 * `--rom`, below, which installs an already-generated ROM directly.
 * Everything downloaded/extracted lives under a scratch work directory that
 * is always cleaned up afterward, success or failure — it can hold
 * copyrighted ROM bytes the user's own C64 Forever install legally
 * supplied, but this project still shouldn't be the thing leaving them
 * sitting around indefinitely after an error.
 */
export async function generateRom(options, sudoExec, fetchImpl, ioOverrides = {}) {
  const io = { ...defaultRomIo, ...ioOverrides };
  reportLine('\n  The full MEGA65 ROM cannot be redistributed by 8BitScript.\n');
  reportLine('  Download the free C64 Forever installer from Cloanto, then provide');
  reportLine('  the MSI path.\n');

  let msiPath = options.c64ForeverPath;
  if (!msiPath) {
    if (!io.canPromptInteractively()) {
      return { ok: false, detail: 'no C64 Forever MSI given — pass --c64-forever <path/to/c64-forever-*.msi>' };
    }
    msiPath = await io.promptLine('  C64 Forever MSI: ');
  }
  if (!msiPath || !(await io.exists(msiPath))) {
    return { ok: false, detail: `C64 Forever MSI not found at '${msiPath || '(none given)'}'` };
  }

  const workDir = typeof io.workDirPath === 'function' ? io.workDirPath() : io.workDirPath;
  const extractDir = join(workDir, 'c64forever');
  try {
    await io.mkdirFn(extractDir, { recursive: true });
    reportStep('running', 'C65 ROM', 'extracting the C64 Forever installer');
    const extraction = await io.extractMsi(msiPath, extractDir);
    if (extraction.missing) {
      return { ok: false, detail: 'msiextract not found — is msitools installed? sudo pacman -S --needed msitools' };
    }
    if (extraction.code !== 0) {
      return { ok: false, detail: `msiextract failed (exit ${extraction.code})` };
    }

    const base = await io.locateBaseRom(extractDir);
    if (!base) {
      return { ok: false, detail: `could not find ${C65_BASE_ROM.filename} inside the extracted MSI` };
    }
    if (!base.validation.ok) {
      return {
        ok: false,
        detail: `${C65_BASE_ROM.filename} (size ${base.validation.size}, sha256 ${base.validation.sha256}) `
          + 'does not match the expected C65 910828 ROM — this is not the expected base ROM; stopping',
      };
    }
    reportStep('ok', 'C65 ROM', '910828');

    reportStep('running', 'ROM patch', `downloading official MEGA65 ${MEGA65_ROM_920413.release} patch`);
    let patch;
    try {
      patch = await io.fetchPatch({ localZipPath: options.romPatchPath, fetchImpl });
    } catch (error) {
      return { ok: false, detail: error.message };
    }

    reportStep('running', 'romdiff', 'building the official MEGA65 patch tool');
    const romdiff = await io.buildRomdiffFn();
    if (!romdiff.ok) {
      return {
        ok: false,
        detail: `building romdiff failed at '${romdiff.step}' (exit ${romdiff.code}) — docs/setup/mega65.md`,
      };
    }

    const rdfPath = join(workDir, 'patch.rdf');
    await io.writeFileFn(rdfPath, patch.rdfBytes);
    const patched = await io.patchRomFn({
      romdiffPath: romdiff.binaryPath,
      rdfPath,
      workDir: join(workDir, 'patched'),
      baseRomPath: base.path,
      header: patch.header,
    });
    if (!patched.ok) {
      return {
        ok: false,
        detail: patched.validation
          ? `generated ROM did not match the expected ${MEGA65_ROM_920413.release} hash (got ${patched.validation.sha256})`
          : `romdiff failed: ${(patched.output ?? '').trim().split('\n').pop() || 'unknown error'}`,
      };
    }
    reportStep('ok', 'MEGA65 ROM', 'generated');

    const installed = await installCanonicalRom(patched.buffer, sudoExec, { ...io, workDirPath: workDir });
    if (!installed.ok) return installed;
    return { ok: true, ready: true, detail: MEGA65_ROM_920413.release };
  } finally {
    await io.cleanup(workDir);
  }
}

/**
 * Install an already-generated MEGA65 ROM file directly — `--rom
 * /path/to/MEGA65.ROM`, or the interactive prompt's answer. This is the
 * macOS milestone's primary ROM path: no C64 Forever MSI, no network patch
 * fetch, just validate-and-install. 8BitScript currently pins the 920413
 * release as the one it verifies for compatibility (see docs/setup/
 * mega65.md) — a right-sized ROM with a different hash is installed anyway
 * (per the brief: never silently reject or delete a same-size ROM of
 * unknown provenance) but reported as unverified, and `ready: false` so the
 * caller doesn't print "MEGA65 is ready" over it; `8bs doctor` will agree
 * and report it as not ready too, rather than the two disagreeing.
 */
export async function installProvidedRom(romPath, sudoExec, io = {}) {
  const {
    readFileFn = readFile, mkdirFn = fsMkdir, writeFileFn = writeFile, workDirPath = mega65WorkDir(),
    validateRom = validateRomBuffer,
  } = io;
  let buffer;
  try {
    buffer = await readFileFn(romPath);
  } catch {
    return { ok: false, detail: `ROM not found at '${romPath}'` };
  }
  const validation = validateRom(buffer, { size: MEGA65_ROM_920413.romSize, sha256: MEGA65_ROM_920413.romSha256 });
  if (!validation.sizeOk) {
    return { ok: false, detail: `'${romPath}' is ${validation.size} bytes — a full MEGA65 ROM is ${MEGA65_ROM_920413.romSize} bytes` };
  }
  const installed = await installCanonicalRom(buffer, sudoExec, { mkdirFn, writeFileFn, workDirPath });
  if (!installed.ok) return installed;
  if (validation.hashOk) return { ok: true, ready: true, detail: MEGA65_ROM_920413.release };
  return {
    ok: true,
    ready: false,
    detail: `installed, but sha256 ${validation.sha256} is not the known-good ${MEGA65_ROM_920413.release} — unverified ROM version`,
  };
}

async function ensureRom(options, io) {
  let canonicalBuffer = null;
  try {
    canonicalBuffer = await io.readFileFn(MEGA65_ROM_CANONICAL_PATH);
  } catch {
    // Not installed yet — fall through below.
  }
  if (canonicalBuffer) {
    const validation = io.validateRom(canonicalBuffer, { size: MEGA65_ROM_920413.romSize, sha256: MEGA65_ROM_920413.romSha256 });
    if (validation.ok) return { ok: true, ready: true, detail: MEGA65_ROM_920413.release };
    reportLine(
      `\n  A ROM already exists at ${MEGA65_ROM_CANONICAL_PATH} but does not match the known `
      + `full MEGA65 ROM (${MEGA65_ROM_920413.release}) — it may be an Open ROM or a different `
      + 'release. Regenerating.',
    );
  }

  // Explicit opt-in only: generating a ROM from a C64 Forever MSI is a
  // separate, Linux-oriented flow (see generateRom()'s own module comment)
  // that isn't offered by default any more now that --rom exists.
  if (options.c64ForeverPath) {
    return generateRom(options, io.sudoExec, io.fetchImpl);
  }

  let romPath = options.romPath;
  if (!romPath) {
    if (!io.canPromptInteractively()) {
      return { ok: false, detail: 'no MEGA65 ROM given — pass --rom /path/to/MEGA65.ROM (or --c64-forever <msi> to generate one)' };
    }
    reportLine('\n  The full MEGA65 ROM cannot be redistributed by 8BitScript.\n');
    romPath = expandHome(await io.promptLine('  Path to MEGA65.ROM: '));
  }
  if (!romPath) return { ok: false, detail: 'no MEGA65 ROM path given' };
  return installProvidedRom(romPath, io.sudoExec, {
    readFileFn: io.readFileFn, mkdirFn: io.mkdirFn, writeFileFn: io.writeFileFn, workDirPath: io.workDir(), validateRom: io.validateRom,
  });
}

async function ensureXemuLink(io) {
  const linkPath = xemuRomLinkPath();
  const fsBag = { lstatFn: io.lstatFn, readlinkFn: io.readlinkFn, readFileFn: io.readFileFn };
  const inspection = await inspectXemuRomLink(linkPath, MEGA65_ROM_CANONICAL_PATH, MEGA65_ROM_920413, fsBag);
  let allowMigrate = false;
  if (inspection.state === 'migratable') {
    allowMigrate = io.canPromptInteractively()
      ? await io.confirm(`  ${linkPath} already has a valid MEGA65 ROM — replace it with a link to the canonical install?`, { defaultValue: true })
      : false;
  }
  return ensureXemuRomLink(linkPath, MEGA65_ROM_CANONICAL_PATH, {
    allowMigrate, expected: MEGA65_ROM_920413, inspect: () => inspection,
    mkdir: io.mkdirFn, symlink: io.symlinkFn, unlink: io.unlinkFn,
  });
}

/**
 * @param {{ c64ForeverPath?: string, romPatchPath?: string, romPath?: string, repair?: boolean }} options
 *   `--repair` is accepted for readability (it's what `8bs doctor` suggests
 *   for a broken launcher or ROM link) and behaves exactly like a plain
 *   run — every step below already checks what's in place first and only
 *   repairs what's actually wrong.
 * @returns {Promise<{ok: boolean}>}
 */
export async function setupMega65(options = {}, ioOverrides = {}) {
  const io = { ...defaultIo, ...ioOverrides };
  reportLine('MEGA65 setup\n');

  const platform = MEGA65_PLATFORMS[io.platform];
  if (!platform) {
    reportStep('attn', 'platform', `no MEGA65 setup backend for '${io.platform}' — docs/setup/mega65.md`);
    return { ok: false };
  }

  const compiler = await checkCompiler(io);
  reportStep(compiler.ok ? 'ok' : 'attn', 'compiler', compiler.detail);
  if (!compiler.ok) return { ok: false };

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

  const emulator = await ensureEmulator(io);
  if (!emulator.ok) {
    reportStep('attn', 'emulator', emulator.detail);
    return { ok: false };
  }

  const rom = await ensureRom(options, io);
  if (!rom.ok) {
    reportStep('attn', 'ROM', rom.detail ?? 'full MEGA65 ROM required');
    return { ok: false };
  }
  reportStep(rom.ready ? 'ok' : 'attn', 'MEGA65 ROM', rom.detail);
  reportStep('ok', 'installed', MEGA65_ROM_CANONICAL_PATH);
  if (!rom.ready) {
    reportLine(`\nMEGA65 ROM installed, but it isn't the verified ${MEGA65_ROM_920413.release} release — \`8bs doctor\` will report it as not ready.`);
    return { ok: false };
  }

  const dataDir = await ensureXemuDataDir({
    platform: io.platform,
    mkdirFn: io.mkdirFn,
    symlinkFn: io.symlinkFn,
    inspect: (linkPath) => inspectXemuDataDir(linkPath, { lstatFn: io.lstatFn, readlinkFn: io.readlinkFn }),
  });
  reportStep('ok', 'Xemu data dir', dataDir.action === 'created' ? dataDir.realDir : (dataDir.target ?? xemuMega65RealDataDir(io.platform)));

  const link = await ensureXemuLink(io);
  if (link.action === 'skipped-foreign') {
    reportStep('attn', 'Xemu ROM', `${xemuRomLinkPath()} exists and isn't the MEGA65 ROM — left untouched`);
  } else if (link.action === 'skipped-migratable') {
    reportStep('attn', 'Xemu ROM', `left as-is at ${xemuRomLinkPath()} (already a valid ROM)`);
  } else {
    reportStep('ok', 'Xemu ROM', xemuRomLinkPath());
  }

  reportLine('\nMEGA65 is ready.');
  return { ok: true };
}
