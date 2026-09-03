// `8bs setup mega65` — get a Manjaro/Arch machine from nothing to a working
// `8bs run mega65`: the mos-mega65-clang compiler (checked, not installed —
// see docs/setup/llvm-mos.md), Xemu's MEGA65 core built from source, and a
// legally-obtained MEGA65 ROM installed where both Xemu and `8bs doctor`
// expect it. Every step is idempotent — safe to re-run after a partial
// failure, or just to confirm everything is still in place.
import {
  access, mkdir as fsMkdir, readFile, writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { execCapture, execInherit, sudoRun } from './exec.mjs';
import { reportStep, reportLine } from './report.mjs';
import { promptLine, confirm, canPromptInteractively } from './prompt.mjs';
import {
  missingPacmanPackages, installPacmanPackages, XEMU_BUILD_PACKAGES, MSITOOLS_PACKAGE,
} from './deps.mjs';
import { buildXemuMega65, installXemu } from './xemu.mjs';
import {
  extractC64ForeverMsi, locateC65BaseRom, fetchRomPatch, buildRomdiff, patchRom, cleanupWorkDir,
} from './mega65-rom.mjs';
import {
  C65_BASE_ROM, MEGA65_ROM_920413, validateRomBuffer, ensureXemuRomLink, inspectXemuRomLink,
} from './rom.mjs';
import {
  XMEGA65_SYMLINK_PATH, MEGA65_ROM_CANONICAL_PATH, MEGA65_ROM_INSTALL_DIR,
  xemuRomLinkPath, mega65WorkDir,
} from './paths.mjs';

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function checkCompiler() {
  const home = process.env.LLVM_MOS_HOME;
  if (!home) return { ok: false, detail: 'LLVM_MOS_HOME is not set — docs/setup/llvm-mos.md' };
  const driver = join(home, 'bin', 'mos-mega65-clang');
  const r = await execCapture(driver, ['--version']);
  if (r.missing) return { ok: false, detail: `mos-mega65-clang not found at ${driver} — docs/setup/llvm-mos.md` };
  return { ok: true, detail: 'mos-mega65-clang' };
}

// msitools (msiextract) is only needed once the ROM step actually extracts
// a C64 Forever MSI, but it's checked alongside the Xemu build dependencies
// up front — one pacman prompt instead of two, and a no-op `pacman -T` check
// when it's already installed either way.
const ALL_PACKAGES = [...XEMU_BUILD_PACKAGES, MSITOOLS_PACKAGE];

async function ensureDependencies(sudoExec) {
  const missing = await missingPacmanPackages(ALL_PACKAGES, execCapture);
  if (missing.length === 0) return { ok: true, detail: 'installed' };
  reportLine(`\n  Xemu's MEGA65 build needs: ${missing.join(' ')}`);
  if (!canPromptInteractively()) {
    return { ok: false, detail: `run: sudo pacman -S --needed ${missing.join(' ')}` };
  }
  const proceed = await confirm('  Install with pacman now?', { defaultValue: true });
  if (!proceed) return { ok: false, detail: `run: sudo pacman -S --needed ${missing.join(' ')}` };
  const result = await installPacmanPackages(missing, sudoExec);
  if (result.code !== 0) return { ok: false, detail: 'pacman reported an error — see the output above' };
  return { ok: true, detail: 'installed' };
}

async function ensureEmulator(sudoExec) {
  if (existsSync(XMEGA65_SYMLINK_PATH)) {
    return { ok: true, detail: XMEGA65_SYMLINK_PATH };
  }
  reportStep('running', 'emulator', 'building Xemu MEGA65 target');
  const build = await buildXemuMega65();
  if (!build.ok) {
    return { ok: false, detail: `xemu build failed at '${build.step}' (exit ${build.code}) — docs/setup/mega65.md` };
  }
  const install = await installXemu(build.binaryPath, { sudoExec });
  if (!install.ok) {
    return { ok: false, detail: `installing xmega65 failed at '${install.step}' (exit ${install.code})` };
  }
  return { ok: true, detail: install.symlinkPath };
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
 * obtained files (see docs/setup/mega65.md). Everything downloaded/extracted
 * lives under a scratch work directory that is always cleaned up afterward,
 * success or failure — it can hold copyrighted ROM bytes the user's own C64
 * Forever install legally supplied, but this project still shouldn't be the
 * thing leaving them sitting around indefinitely after an error.
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
    return { ok: true, detail: MEGA65_ROM_920413.release };
  } finally {
    await io.cleanup(workDir);
  }
}

async function ensureRom(options, sudoExec, fetchImpl) {
  let canonicalBuffer = null;
  try {
    canonicalBuffer = await readFile(MEGA65_ROM_CANONICAL_PATH);
  } catch {
    // Not installed yet — fall through to generation below.
  }
  if (canonicalBuffer) {
    const validation = validateRomBuffer(canonicalBuffer, { size: MEGA65_ROM_920413.romSize, sha256: MEGA65_ROM_920413.romSha256 });
    if (validation.ok) return { ok: true, detail: MEGA65_ROM_920413.release };
    reportLine(
      `\n  A ROM already exists at ${MEGA65_ROM_CANONICAL_PATH} but does not match the known `
      + `full MEGA65 ROM (${MEGA65_ROM_920413.release}) — it may be an Open ROM or a different `
      + 'release. Regenerating.',
    );
  }
  return generateRom(options, sudoExec, fetchImpl);
}

async function ensureXemuLink() {
  const linkPath = xemuRomLinkPath();
  const inspection = inspectXemuRomLink(linkPath, MEGA65_ROM_CANONICAL_PATH, MEGA65_ROM_920413);
  let allowMigrate = false;
  if (inspection.state === 'migratable') {
    allowMigrate = canPromptInteractively()
      ? await confirm(`  ${linkPath} already has a valid MEGA65 ROM — replace it with a link to the canonical install?`, { defaultValue: true })
      : false;
  }
  return ensureXemuRomLink(linkPath, MEGA65_ROM_CANONICAL_PATH, { allowMigrate, inspect: () => inspection });
}

/** @returns {Promise<{ok: boolean}>} */
export async function setupMega65(options = {}, overrides = {}) {
  const sudoExec = overrides.sudoExec ?? sudoRun;
  const fetchImpl = overrides.fetchImpl ?? fetch;

  reportLine('MEGA65 setup\n');

  const compiler = await checkCompiler();
  reportStep(compiler.ok ? 'ok' : 'attn', 'compiler', compiler.detail);
  if (!compiler.ok) return { ok: false };

  const deps = await ensureDependencies(sudoExec);
  reportStep(deps.ok ? 'ok' : 'attn', 'dependencies', deps.detail);
  if (!deps.ok) return { ok: false };

  const emulator = await ensureEmulator(sudoExec);
  reportStep(emulator.ok ? 'ok' : 'attn', 'emulator', emulator.detail);
  if (!emulator.ok) return { ok: false };

  const rom = await ensureRom(options, sudoExec, fetchImpl);
  if (!rom.ok) {
    reportStep('attn', 'ROM', rom.detail ?? 'full MEGA65 ROM required');
    return { ok: false };
  }
  reportStep('ok', 'MEGA65 ROM', rom.detail);
  reportStep('ok', 'installed', MEGA65_ROM_CANONICAL_PATH);

  const link = await ensureXemuLink();
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
