// `8bs doctor` — is this machine able to build and run 8BitScript programs?
//
// Every target needs two things: an LLVM-MOS driver (or, for the web, the
// AssemblyScript compiler) to build with, and an emulator to run against.
// Every check reports against what the project actually requires, with a
// pointer to the setup page that installs the tool, an inline brew/apt/
// pacman command when one is known, and — for anything this machine's
// platform can install with a single trusted command — an interactive
// prompt to run that command right here, rather than making the reader
// leave the terminal and come back.
//
// The VIC-20 and Commander X16 checks go further than versions: a VICE
// build without ROMs prints a version and still cannot boot a machine, so
// the doctor launches the emulator for a bounded number of cycles and
// confirms it actually comes up; x16emu's `-version` likewise never touches
// its ROM, so the doctor boots it headless (`-testbench`) — the only check
// that catches the tested macOS failure where x16emu on PATH is a direct
// symlink and dies with "Cannot open /usr/local/bin/rom.bin!" (see
// checkCx16Target()). docs/setup/vice.md is explicit that anything less
// reports success on a setup that cannot run a single build. The other
// targets don't get that same depth yet — existence and, where the tool
// supports it, a version — that's a known gap, not an oversight.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { MEGA65_ROM_920413, validateRomBuffer, inspectXemuRomLink } from './setup/rom.mjs';
import { MEGA65_ROM_CANONICAL_PATH, CX16_ROM_INSTALL_PATH, xemuRomLinkPath } from './setup/paths.mjs';
import { resolveOnPath } from './setup/host.mjs';
import { inspectLauncher } from './setup/launcher.mjs';
import {
  inspectRomFile, x16emuLauncherSpec, isBrokenMacosSymlink, parseX16emuVersion, romLoadFailure, testbenchBooted,
} from './setup/cx16.mjs';

// ---- pure helpers, unit-tested --------------------------------------------

/** First dotted version in a string, as numbers: "pnpm 12.1.0" -> [12,1,0]. */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '');
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** Is `version` at least `minimum`? Both are number arrays. */
export function atLeast(version, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    const a = version[i] ?? 0;
    const b = minimum[i];
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

/** Walk upward from `dir` for node_modules/.bin/<name>. */
export function findLocalBin(dir, name) {
  const binary = process.platform === 'win32' ? `${name}.cmd` : name;
  let current = dir;
  for (;;) {
    const candidate = join(current, 'node_modules', '.bin', binary);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Pick the install plan this platform can actually run, from an installer's
 * `darwin`/`linux` options — the first Linux package manager found on PATH,
 * since a machine only ever has some of apt/pacman/pamac/yay/paru/brew
 * (linuxbrew). `buildFromSource` blocks this outright: x16emu and xmega65
 * (Xemu) are both source-only, and neither one's AUR package is trusted here
 * (see the comments on their INSTALLERS entries) — the interactive one-key
 * install never applies to them; `8bs setup <target>` is the real path in.
 * Returns null for an unsupported platform, or a Linux box with none of the
 * listed managers on PATH (docs/hints still apply either way; this only
 * decides whether the interactive one-key install applies).
 */
export function pickInstallPlan(installer, platform = process.platform, hasBinary = onPath) {
  if (!installer || installer.buildFromSource) return null;
  if (platform === 'darwin') {
    return installer.darwin && hasBinary('brew') ? installer.darwin : null;
  }
  if (platform === 'linux') {
    return (installer.linux ?? []).find((plan) => hasBinary(plan.manager === 'apt' ? 'apt-get' : plan.manager)) ?? null;
  }
  return null;
}

// ---- process running ------------------------------------------------------

/** Run a command; resolve with { code, stdout, stderr, missing, timedOut }. */
function run(command, args, { timeout = 10_000 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolvePromise({ code: null, stdout: '', stderr: '', missing: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr, missing: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, missing: false, timedOut });
    });
  });
}

function onPath(name) {
  const binary = process.platform === 'win32' ? `${name}.exe` : name;
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, binary)));
}

// ---- the checks -----------------------------------------------------------

const OK = 'ok';
const FAIL = 'fail';
const WARN = 'warn';
const SKIP = 'skip';

const result = (status, label, detail, hint = null, extra = {}) => ({
  status, label, detail, hint, installer: extra.installer ?? null, targets: extra.targets ?? [],
});

async function versionCheck(label, command, args, minimum, hint, describeMin) {
  const r = await run(command, args);
  if (r.missing) return result(FAIL, label, 'not found', hint);
  const version = parseVersion(r.stdout + r.stderr);
  if (!version) {
    return result(WARN, label, `installed, but the version was unreadable`, hint);
  }
  const pretty = version.join('.');
  if (minimum && !atLeast(version, minimum)) {
    return result(FAIL, label, `${pretty} — need ${describeMin}`, hint);
  }
  return result(OK, label, minimum ? `${pretty} (need ${describeMin})` : pretty);
}

async function checkHost() {
  const node = parseVersion(process.version);
  const checks = [
    atLeast(node, [26])
      ? result(OK, 'Node.js', `${node.join('.')} (need >=26)`)
      : result(FAIL, 'Node.js', `${node.join('.')} — need >=26`, 'docs/setup/host-toolchain.md'),
    await versionCheck('pnpm', 'pnpm', ['--version'], [12], 'docs/setup/host-toolchain.md', '>=12'),
    await versionCheck('git', 'git', ['--version'], [2, 30], 'docs/setup/host-toolchain.md', '>=2.30'),
  ];
  return { title: 'Host', checks };
}

/**
 * Where the toolchain will actually run `asc` from: the web backend's own
 * dependencies. pnpm isolates each package's node_modules, so the binary lives
 * next to @8bitscript/backend-web rather than at the workspace root. The
 * user's own project is checked as a fallback, for a project that installs
 * assemblyscript itself.
 */
function findAsc() {
  try {
    const require = createRequire(import.meta.url);
    const backend = dirname(require.resolve('@8bitscript/backend-web/package.json'));
    const local = findLocalBin(backend, 'asc');
    if (local) return local;
  } catch {
    // The backend is not resolvable from here; fall through to the cwd walk.
  }
  return findLocalBin(process.cwd(), 'asc');
}

async function checkWeb() {
  const asc = findAsc();
  const checks = [];
  if (!asc) {
    checks.push(result(
      FAIL, 'asc', 'not found',
      'The AssemblyScript compiler ships with the toolchain — a missing asc\n' +
      '      usually means an incomplete install. Run: pnpm install',
    ));
  } else {
    const r = await run(asc, ['--version']);
    const version = parseVersion(r.stdout + r.stderr);
    checks.push(version
      ? result(OK, 'asc', version.join('.'), null, { targets: ['web'] })
      : result(WARN, 'asc', 'found, but the version was unreadable'));
  }
  return { title: 'Web target (.wasm)', checks };
}

// Every LLVM-MOS driver this project builds against, and which target(s) it
// serves. Confirmed directly against llvm-mos-sdk's own mos-platform/ tree
// (github.com/llvm-mos/llvm-mos-sdk) — one driver binary per platform, two
// for Atari 8-bit because that target picks its output format (DOS-loader
// .xex vs XEGS cartridge) via which driver runs, not a build flag.
const CLANG_DRIVERS = [
  { driver: 'mos-vic20-clang', targets: ['vic20'] },
  { driver: 'mos-c64-clang', targets: ['c64'] },
  { driver: 'mos-pet-clang', targets: ['pet'] },
  { driver: 'mos-c128-clang', targets: ['c128'] },
  { driver: 'mos-mega65-clang', targets: ['mega65'] },
  { driver: 'mos-cx16-clang', targets: ['cx16'] },
  { driver: 'mos-nes-nrom-clang', targets: ['nes'] },
  { driver: 'mos-atari8-dos-clang', targets: ['atari8'] },
  { driver: 'mos-atari8-cart-xegs-clang', targets: ['atari8'] },
];

async function checkMos() {
  const checks = [];
  const home = process.env.LLVM_MOS_HOME;
  const allTargets = [...new Set(CLANG_DRIVERS.flatMap((d) => d.targets))];

  if (!home) {
    checks.push(result(FAIL, 'LLVM_MOS_HOME', 'not set', 'docs/setup/llvm-mos.md'));
    for (const { driver, targets } of CLANG_DRIVERS) {
      checks.push(result(SKIP, driver, 'skipped — LLVM_MOS_HOME is not set', null, { targets }));
    }
  } else if (!existsSync(join(home, 'bin'))) {
    checks.push(result(
      FAIL, 'LLVM_MOS_HOME', `set to ${home}, but ${join(home, 'bin')} does not exist`,
      'It must point at the directory that directly contains bin/ — docs/setup/llvm-mos.md',
    ));
    for (const { driver, targets } of CLANG_DRIVERS) {
      checks.push(result(SKIP, driver, 'skipped — LLVM_MOS_HOME is wrong', null, { targets }));
    }
  } else {
    checks.push(result(OK, 'LLVM_MOS_HOME', home, null, { targets: allTargets }));
    for (const { driver, targets } of CLANG_DRIVERS) {
      const path = join(home, 'bin', driver);
      const r = await run(path, ['--version']);
      if (r.missing) {
        checks.push(result(FAIL, driver, `not found at ${path}`, 'docs/setup/llvm-mos.md', { targets }));
      } else if (/clang/i.test(r.stdout + r.stderr)) {
        const version = parseVersion(r.stdout + r.stderr);
        checks.push(result(OK, driver, version ? `clang ${version.join('.')}` : 'a clang', null, { targets }));
      } else {
        checks.push(result(WARN, driver, 'runs, but does not identify itself as clang', null, { targets }));
      }
    }
  }

  return { title: 'LLVM-MOS SDK (every 6502 target)', checks };
}

// ---- emulator installers ---------------------------------------------------
//
// One entry per emulator this project can launch (`8bs run <target>`). Each
// carries: a doctor-facing label, the target(s) it serves, a brew formula
// for macOS, a Linux package-manager list (tried in the order a machine is
// likely to have them — apt/pacman native packages first, AUR-only packages
// via pamac/yay/paru next, Linuxbrew last), and a `docs/setup/*.md` page.
// `buildFromSource`/`repo` are set on top of that for the platforms (or, for
// x16emu, every platform) with no single-command install — `pickInstallPlan()`
// above only consults `.linux`/`.darwin` for whatever this specific machine
// can actually run, so `buildFromSource` never overrides a real entry.
const INSTALLERS = {
  vice: {
    label: 'VICE (xvic, x64sc, xpet, x128)',
    darwin: { manager: 'brew', args: ['install', 'vice'] },
    linux: [
      { manager: 'apt', args: ['install', '-y', 'vice'], sudo: true },
      { manager: 'pacman', args: ['-S', '--noconfirm', 'vice'], sudo: true },
      { manager: 'brew', args: ['install', 'vice'] },
    ],
    docs: 'docs/setup/vice.md',
  },
  atari800: {
    label: 'atari800 (Atari 8-bit)',
    darwin: { manager: 'brew', args: ['install', 'atari800'] },
    // No pacman plan: atari800 is not in Arch/Manjaro's official repos, only
    // the AUR (confirmed against `pacman -Si atari800` — "package not
    // found"). pamac — Manjaro's default package manager — builds AUR
    // packages out of the box (confirmed: `pamac search atari800` resolves
    // the AUR `atari800` package by exact name) and is tried first among the
    // AUR-capable options since it's what Manjaro ships by default; yay/paru
    // cover plain Arch installs that don't have pamac.
    linux: [
      { manager: 'apt', args: ['install', '-y', 'atari800'], sudo: true },
      { manager: 'pamac', args: ['build', '--no-confirm', 'atari800'] },
      { manager: 'yay', args: ['-S', '--noconfirm', 'atari800'] },
      { manager: 'paru', args: ['-S', '--noconfirm', 'atari800'] },
      { manager: 'brew', args: ['install', 'atari800'] },
    ],
    docs: 'docs/setup/atari8.md',
  },
  fceux: {
    label: 'FCEUX (NES)',
    darwin: { manager: 'brew', args: ['install', 'fceux'] },
    linux: [
      { manager: 'apt', args: ['install', '-y', 'fceux'], sudo: true },
      { manager: 'pacman', args: ['-S', '--noconfirm', 'fceux'], sudo: true },
      { manager: 'brew', args: ['install', 'fceux'] },
    ],
    docs: 'docs/setup/nes.md',
  },
  x16emu: {
    label: 'x16emu (Commander X16)',
    // An AUR `x16-emulator` package exists, but it can drift out of sync
    // with the ROM the emulator needs — the two have to be a matching pair,
    // per upstream's own notes — and may be outdated or broken. There's no
    // single-command install plan here as a result: `8bs setup cx16` builds
    // both the emulator and a matching ROM from upstream source instead
    // (docs/setup/cx16.md). See checkCx16Target() for the resulting checks.
    buildFromSource: true,
    repo: 'https://github.com/X16Community/x16-emulator',
    docs: 'docs/setup/cx16.md',
    setupCommand: 'cx16',
  },
  xmega65: {
    label: 'Xemu — MEGA65 core (xmega65)',
    // No brew formula. An AUR `xmega65-git` package exists, but it's
    // unreliable/outdated and this project doesn't depend on it — `8bs setup
    // mega65` builds targets/mega65 from lgblgblgb/xemu directly instead.
    buildFromSource: true,
    repo: 'https://github.com/lgblgblgb/xemu',
    docs: 'docs/setup/mega65.md',
    // `8bs setup mega65` builds+installs this (and the ROM — see
    // checkMega65Target() below) end to end; point installerHint() at it
    // instead of just the bare upstream repo.
    setupCommand: 'mega65',
  },
};

/** `sudo apt-get install -y foo` style text for one darwin/linux plan. */
function planCommand(plan) {
  const manager = plan.manager === 'apt' ? 'apt-get' : plan.manager;
  return plan.sudo ? `sudo ${manager} ${plan.args.join(' ')}` : `${manager} ${plan.args.join(' ')}`;
}

/**
 * Every command line for this platform, in the order it's tried — so a FAIL
 * always shows concrete things to try, not just the one this machine can run
 * unattended right now, collapsed behind "your distro's package manager".
 * The one `pickInstallPlan` would actually run is marked "(detected)".
 */
function installerHint(installer) {
  const plans = process.platform === 'darwin'
    ? (installer.darwin ? [installer.darwin] : [])
    : process.platform === 'linux'
      ? (installer.linux ?? [])
      : [];
  if (plans.length === 0) {
    if (installer.buildFromSource) {
      const setupHint = installer.setupCommand ? `run: 8bs setup ${installer.setupCommand} — ` : '';
      return `${setupHint}no packaged build found — ${installer.repo} — ${installer.docs}`;
    }
    return `brew install <formula>, or your distro's package manager — ${installer.docs}`;
  }
  const detected = pickInstallPlan(installer);
  const lines = plans.map((plan) => `${planCommand(plan)}${plan === detected ? '  (detected)' : ''}`);
  return `try:\n        ${lines.join('\n        ')}\n        — ${installer.docs}`;
}

/** Existence + best-effort version for an emulator binary that may hang on
 * an unrecognised flag (a GUI emulator opening a window instead of printing
 * a version) — existence is the check that matters; the version probe only
 * ever upgrades a result, never fails one, so a slow/silent version flag
 * can't turn a real install into a false FAIL. `versionArgs` is there for
 * a tool whose flag isn't `--version` (x16emu's is `-version`, but that
 * one has its own deeper checks now — checkCx16Target()). */
async function checkEmulator(binary, { label = binary, targets, installerKey, tryVersion = true, versionArgs = ['--version'] } = {}) {
  const installer = INSTALLERS[installerKey];
  if (!onPath(binary)) {
    return result(FAIL, label, 'not found', installerHint(installer), { installer, targets });
  }
  if (!tryVersion) return result(OK, label, 'found', null, { targets });
  const r = await run(binary, versionArgs);
  if (r.missing || r.timedOut) return result(OK, label, 'found (version unconfirmed)', null, { targets });
  const output = r.stdout + r.stderr;
  const version = parseVersion(output);
  if (version) return result(OK, label, version.join('.'), null, { targets });
  // No dotted version to parse (x16emu reports "Release NN" instead) — show
  // the real first line rather than a canned "unconfirmed" for output we did
  // get back.
  const firstLine = output.trim().split('\n')[0]?.trim();
  return result(OK, label, firstLine || 'found (version unconfirmed)', null, { targets });
}

/**
 * Ask the package manager that installed VICE what version it put down,
 * bypassing the binaries entirely. This is the fallback for
 * `xvic --version` et al crashing outright on some Homebrew bottles
 * (confirmed on 3.9, reproduced here on 3.10) with "Error - argv[0] is
 * NULL, giving up" — a known upstream regression, vice-emu bug #2108 —
 * rather than printing anything a version check could parse. The package
 * manager still knows the version even when the binary can't report its
 * own; null if no manager confirms one.
 */
export async function vicePackageManagerVersion({
  platform = process.platform, hasBinary = onPath, exec = run,
} = {}) {
  if (platform === 'darwin' && hasBinary('brew')) {
    const r = await exec('brew', ['list', '--versions', 'vice']);
    const version = parseVersion(r.stdout);
    if (version) return version;
  }
  if (platform === 'linux') {
    const dpkg = await exec('dpkg-query', ['-W', '-f=${Version}', 'vice']);
    const dpkgVersion = parseVersion(dpkg.stdout);
    if (dpkgVersion) return dpkgVersion;
    const pacman = await exec('pacman', ['-Q', 'vice']);
    const pacmanVersion = parseVersion(pacman.stdout);
    if (pacmanVersion) return pacmanVersion;
  }
  return null;
}

async function checkVice() {
  const checks = [];
  // Fetched lazily, at most once per checkVice() run — one VICE install
  // serves all four binaries, so the four fallback lookups would otherwise
  // be identical repeats of each other.
  let packageManagerVersion; // undefined until first needed, then cached (possibly null)
  for (const [binary, machine, label] of [
    ['xvic', 'vic20', 'xvic (VIC-20)'],
    ['x64sc', 'c64', 'x64sc (C64)'],
    ['xpet', 'pet', 'xpet (PET)'],
    ['x128', 'c128', 'x128 (C128)'],
  ]) {
    if (!onPath(binary)) {
      checks.push(result(FAIL, label, 'not found', installerHint(INSTALLERS.vice), { installer: INSTALLERS.vice, targets: [machine] }));
      continue;
    }
    const r = await run(binary, ['--version']);
    let version = parseVersion(r.stdout + r.stderr);
    let viaPackageManager = false;
    if (!version) {
      if (packageManagerVersion === undefined) packageManagerVersion = await vicePackageManagerVersion();
      if (packageManagerVersion) {
        version = packageManagerVersion;
        viaPackageManager = true;
      }
    }
    if (!version) {
      checks.push(result(WARN, label, 'found, but the version was unreadable', 'docs/setup/vice.md', { targets: [machine] }));
    } else if (!atLeast(version, [3, 10])) {
      checks.push(result(WARN, label, `VICE ${version.join('.')} — the project expects 3.10`, 'docs/setup/vice.md', { targets: [machine] }));
    } else {
      const detail = viaPackageManager
        ? `VICE ${version.join('.')} (via the package manager — ${binary} --version doesn't print one on this build)`
        : `VICE ${version.join('.')}`;
      checks.push(result(OK, label, detail, null, { targets: [machine] }));
    }
  }
  checks.push(await bootCheck());
  return { title: 'VICE (VIC-20 / C64 / PET / C128)', checks };
}

/**
 * Launch xvic for a bounded number of cycles and confirm it reaches a running
 * machine. This is the check a version string cannot stand in for: a VICE
 * without ROMs reports its version and then refuses to boot.
 *
 * Two things about real VICE builds shape this code, both learned the hard way
 * against the GTK3 build Arch ships:
 *
 *   - The exit-screenshot flag is spelled `-exitscreenshot` on GTK3 builds and
 *     `-exitscreenshotname` on SDL builds, so the flags are probed from
 *     `xvic -help` rather than assumed.
 *   - Reaching the cycle limit is reported as an *error* ("cycle limit
 *     reached") with a non-zero exit, even though it is exactly the success
 *     case. The exit code is useless here; the evidence of a boot is the
 *     screenshot on disk, with the cycle-limit message as fallback.
 *
 * ~8 million cycles is a few seconds of emulated VIC-20, comfortably past the
 * BASIC startup screen; -warp makes it quick on the host.
 */
async function bootCheck() {
  if (!onPath('xvic')) return result(SKIP, 'VIC-20 boot', 'skipped — xvic is not installed');

  const help = await run('xvic', ['-help']);
  const helpText = help.stdout + help.stderr;
  if (!/-limitcycles\b/.test(helpText)) {
    return result(WARN, 'VIC-20 boot', 'could not be verified — this VICE does not support -limitcycles');
  }
  const screenshotFlag = /-exitscreenshot\b/.test(helpText)
    ? '-exitscreenshot'
    : /-exitscreenshotname\b/.test(helpText)
      ? '-exitscreenshotname'
      : null;

  const scratch = await mkdtemp(join(tmpdir(), '8bs-doctor-'));
  try {
    const shot = join(scratch, 'boot.png');
    const args = ['-default', '-warp', '+sound', '-limitcycles', '8000000'];
    if (screenshotFlag) args.push(screenshotFlag, shot);
    const r = await run('xvic', args, { timeout: 60_000 });
    const output = r.stdout + r.stderr;

    if (r.timedOut) {
      return result(FAIL, 'VIC-20 boot', 'the emulator did not finish within 60s', 'docs/setup/vice.md');
    }
    if (/cannot load system file|sysfile.*error/i.test(output)) {
      return result(
        FAIL, 'VIC-20 boot', 'xvic cannot load its ROMs',
        'The emulator is installed but the Commodore ROM images are missing — docs/setup/vice.md',
      );
    }
    const booted =
      (screenshotFlag && existsSync(shot)) || /cycle limit reached/i.test(output);
    if (booted) {
      return result(OK, 'VIC-20 boot', 'the emulator boots to a running machine');
    }
    const reason = (r.stderr.trim().split('\n').pop() ?? '').slice(0, 120);
    return result(
      FAIL, 'VIC-20 boot',
      `xvic exited without booting${reason ? ` — ${reason}` : ''}`,
      'docs/setup/vice.md',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Does a MEGA65 ROM exist at either place `8bs setup mega65` (or a manual
 * install) would put it, and is it the full, official 920413 ROM — not just
 * present, since a redistributable Open ROM or some other file at the same
 * path is not equivalent for target readiness (see docs/setup/mega65.md).
 * Checks the canonical install first, then Xemu's own per-user copy, mirroring
 * setup/mega65.mjs's own read order.
 */
export async function findMega65Rom({
  canonicalPath = MEGA65_ROM_CANONICAL_PATH, linkPath = xemuRomLinkPath(), read = readFile,
} = {}) {
  for (const path of [canonicalPath, linkPath]) {
    try {
      const buffer = await read(path);
      return { path, validation: validateRomBuffer(buffer, { size: MEGA65_ROM_920413.romSize, sha256: MEGA65_ROM_920413.romSha256 }) };
    } catch {
      // Not at this path — try the next, or report not-found below.
    }
  }
  return null;
}

/**
 * MEGA65 readiness, as four separate checks, not one — `xmega65` existing
 * on `PATH` proves nothing about whether it can actually run the machine:
 *
 *   xmega65        the launcher on PATH, reported as its resolved path
 *                  (like checkCx16Target()'s x16emu, not just "found")
 *   MEGA65 ROM     a full, official 920413 ROM exists *somewhere* this
 *                  project or a manual install would put it — the full ROM
 *                  cannot be redistributed by this project
 *                  (docs/setup/mega65.md), so a fresh Xemu install has none
 *                  until `8bs setup mega65` (or the manual steps) makes one
 *   Xemu ROM link  separately: can *Xemu itself* actually see that ROM?
 *                  `MEGA65 ROM ok` alone doesn't imply this — a canonical
 *                  install at /opt/mega65/MEGA65.ROM with no
 *                  ~/.xemu-lgb/MEGA65.ROM link is a real, tested gap this
 *                  check exists to catch (see setup/rom.mjs's
 *                  inspectXemuRomLink(), shared with `8bs setup mega65`)
 *   MEGA65         ready only when every check above passes
 */
export async function checkMega65Target({
  hasEmulator, emulatorPath = null, find = findMega65Rom,
  canonicalPath = MEGA65_ROM_CANONICAL_PATH, linkPath = xemuRomLinkPath(), inspectLink = inspectXemuRomLink,
} = {}) {
  const targets = ['mega65'];
  const installer = INSTALLERS.xmega65;
  const checks = [];

  checks.push(hasEmulator
    ? result(OK, 'xmega65 (MEGA65, via Xemu)', emulatorPath ?? 'found', null, { targets })
    : result(FAIL, 'xmega65 (MEGA65, via Xemu)', 'not found', installerHint(installer), { installer, targets }));

  const found = await find({ canonicalPath, linkPath });
  let romOk = false;
  if (!found) {
    checks.push(result(
      FAIL, 'MEGA65 ROM', 'not found',
      hasEmulator
        ? 'xmega65 is installed, but the full MEGA65 ROM is missing.\n        run: 8bs setup mega65'
        : 'run: 8bs setup mega65',
      { targets },
    ));
  } else if (found.validation.ok) {
    romOk = true;
    checks.push(result(OK, 'MEGA65 ROM', MEGA65_ROM_920413.release, null, { targets }));
  } else {
    checks.push(result(
      FAIL, 'MEGA65 ROM',
      `found at ${found.path}, but it isn't the full ${MEGA65_ROM_920413.release} ROM `
      + '(may be an Open ROM, or a different release)',
      'run: 8bs setup mega65',
      { targets },
    ));
  }

  const linkInspection = await inspectLink(linkPath, canonicalPath, MEGA65_ROM_920413);
  let linkOk = false;
  if (linkInspection.state === 'linked') {
    linkOk = true;
    checks.push(result(OK, 'Xemu ROM link', 'configured', null, { targets }));
  } else if (linkInspection.state === 'migratable') {
    linkOk = true;
    checks.push(result(OK, 'Xemu ROM link', `${linkPath} (installed directly, not linked to the canonical copy)`, null, { targets }));
  } else if (linkInspection.state === 'absent') {
    checks.push(result(
      FAIL, 'Xemu ROM link', 'MEGA65.ROM exists but Xemu is not configured to use it.',
      'run: 8bs setup mega65 --repair', { targets },
    ));
  } else {
    checks.push(result(
      FAIL, 'Xemu ROM link', `${linkPath} exists but isn't the MEGA65 ROM`,
      'run: 8bs setup mega65 --repair', { targets },
    ));
  }

  const ready = hasEmulator && romOk && linkOk;
  const firstFail = checks.find((c) => c.status === FAIL);
  checks.push(ready
    ? result(OK, 'MEGA65', 'ready', null, { targets })
    : result(SKIP, 'MEGA65', `not ready — ${firstFail?.label ?? 'xmega65'} must pass first`, null, { targets }));

  return checks;
}

const ROM_STATE_WORDS = {
  'not-a-file': 'not a regular file', empty: 'an empty file', unreadable: 'not readable',
};

/**
 * Commander X16 readiness, as five separate checks plus a summary — because
 * `command -v x16emu` succeeding proves almost nothing here. Every one of
 * these has failed for real on a setup that passed the one before it:
 *
 *   x16emu         the launcher on PATH (reported as the path, so a reader
 *                  sees /usr/local/bin/x16emu vs. some other install)
 *   ROM            /opt/commander-x16/rom.bin is a regular, readable,
 *                  non-empty file — or, for an install this project didn't
 *                  make, a rom.bin beside the real binary
 *   launcher       on macOS, a direct symlink into /opt/commander-x16 is
 *                  the tested-broken layout (x16emu looks for rom.bin beside
 *                  the *symlink*): reported specifically, with the repair
 *   version        `x16emu -version` → "Release NN" (any release)
 *   boot           `x16emu -testbench` headless — the only probe that
 *                  actually loads the ROM through the launcher
 *
 * `compilerOk` is mos-cx16-clang's status from checkMos(), folded into the
 * summary line so "ready" means the whole toolchain, not just the emulator.
 * Every boundary is injectable for the unit tests; the defaults are real.
 */
export async function checkCx16Target({
  platform = process.platform, compilerOk = true, resolveBinary = resolveOnPath, exec = run,
  realpathFn = realpath, fs = {},
} = {}) {
  const installer = INSTALLERS.x16emu;
  const targets = ['cx16'];
  const checks = [];
  const launcherPath = resolveBinary('x16emu');

  checks.push(launcherPath
    ? result(OK, 'x16emu (Commander X16)', launcherPath, null, { targets })
    : result(FAIL, 'x16emu (Commander X16)', 'not found', installerHint(installer), { installer, targets }));

  let rom = await inspectRomFile(CX16_ROM_INSTALL_PATH, fs);
  if (rom.state !== 'ok' && launcherPath) {
    // Not the 8bs-managed layout — but an official release zip, or a manual
    // install, keeps rom.bin beside the real binary, and x16emu finds that
    // by itself. Accept it, but say so.
    try {
      const beside = join(dirname(await realpathFn(launcherPath)), 'rom.bin');
      if (beside !== CX16_ROM_INSTALL_PATH) {
        const found = await inspectRomFile(beside, fs);
        if (found.state === 'ok') rom = { ...found, beside: true };
      }
    } catch {
      // realpath failed (dangling symlink) — the launcher/boot checks below report it.
    }
  }
  if (rom.state === 'ok') {
    checks.push(result(OK, 'Commander X16 ROM', rom.beside ? `${rom.path} (beside x16emu — not the 8bs-managed layout)` : rom.path, null, { targets }));
  } else if (rom.state === 'missing') {
    checks.push(result(
      FAIL, 'Commander X16 ROM', 'not found',
      launcherPath ? 'emulator installed but ROM is missing\n        run: 8bs setup cx16' : 'run: 8bs setup cx16',
      { targets },
    ));
  } else {
    checks.push(result(FAIL, 'Commander X16 ROM', `${rom.path} is ${ROM_STATE_WORDS[rom.state]}`, 'run: 8bs setup cx16', { targets }));
  }

  let brokenSymlink = false;
  if (launcherPath) {
    const spec = x16emuLauncherSpec(platform);
    const inspection = await inspectLauncher({ ...spec, path: launcherPath }, fs);
    brokenSymlink = isBrokenMacosSymlink(platform, inspection);
    if (brokenSymlink) {
      checks.push(result(
        FAIL, 'Commander X16 launcher', 'x16emu is installed as a direct symlink and cannot locate rom.bin.',
        'run: 8bs setup cx16 --repair', { targets },
      ));
    } else if (inspection.state === 'wrapper') {
      checks.push(result(OK, 'Commander X16 launcher', `wrapper, -rom ${CX16_ROM_INSTALL_PATH}`, null, { targets }));
    } else if (inspection.state === 'symlink') {
      checks.push(result(OK, 'Commander X16 launcher', `symlink -> ${inspection.target}`, null, { targets }));
    } else if (inspection.state === 'foreign-symlink' && platform === 'darwin') {
      checks.push(result(
        WARN, 'Commander X16 launcher', `a symlink to ${inspection.target}, not 8bs-managed`,
        'On macOS x16emu looks for rom.bin beside the symlink, not the real binary — the boot check below is authoritative', { targets },
      ));
    } else {
      checks.push(result(OK, 'Commander X16 launcher', `${launcherPath} (not 8bs-managed)`, null, { targets }));
    }

    // -version: exits 0 with "### Release NN (...)" on stdout, no window —
    // confirmed against a real r50 build. It never loads the ROM (also
    // confirmed: it succeeds with `-rom /nonexistent`), hence the boot below.
    const version = await exec('x16emu', ['-version']);
    const versionOut = (version.stdout ?? '') + (version.stderr ?? '');
    const release = parseX16emuVersion(versionOut);
    if (version.missing || version.timedOut) {
      checks.push(result(WARN, 'x16emu version', 'unconfirmed — `x16emu -version` did not respond', null, { targets }));
    } else if (release) {
      checks.push(result(OK, 'x16emu version', release, null, { targets }));
    } else if (version.code !== 0) {
      checks.push(result(FAIL, 'x16emu version', `\`x16emu -version\` exited ${version.code}: ${versionOut.trim().split('\n').pop() || 'no output'}`, 'run: 8bs setup cx16', { targets }));
    } else {
      checks.push(result(WARN, 'x16emu version', versionOut.trim().split('\n')[0] || 'unreadable', null, { targets }));
    }

    const boot = await exec('x16emu', ['-testbench'], { timeout: 30_000 });
    const bootOut = (boot.stdout ?? '') + (boot.stderr ?? '');
    const failure = romLoadFailure(bootOut);
    if (boot.timedOut) {
      checks.push(result(FAIL, 'Commander X16 boot', 'x16emu -testbench did not finish within 30s', 'docs/setup/cx16.md', { targets }));
    } else if (failure) {
      checks.push(result(
        FAIL, 'Commander X16 boot', `x16emu cannot open its ROM (${failure})`,
        brokenSymlink ? 'run: 8bs setup cx16 --repair' : 'run: 8bs setup cx16', { targets },
      ));
    } else if (testbenchBooted({ code: boot.code, output: bootOut })) {
      checks.push(result(OK, 'Commander X16 boot', 'boots to BASIC (headless -testbench)', null, { targets }));
    } else {
      const reason = (bootOut.trim().split('\n').pop() ?? '').slice(0, 120);
      checks.push(result(FAIL, 'Commander X16 boot', `x16emu exited without booting${reason ? ` — ${reason}` : ''}`, 'run: 8bs setup cx16', { targets }));
    }
  }

  const firstFail = !compilerOk ? { label: 'mos-cx16-clang' } : checks.find((c) => c.status === FAIL);
  checks.push(firstFail
    ? result(SKIP, 'Commander X16', `not ready — ${firstFail.label} must pass first`, null, { targets })
    : result(OK, 'Commander X16', 'ready', null, { targets }));
  return checks;
}

async function checkOtherEmulators({ cx16CompilerOk }) {
  const mega65EmulatorPath = resolveOnPath('xmega65');
  const checks = [
    await checkEmulator('atari800', { label: 'atari800 (Atari 8-bit)', targets: ['atari8'], installerKey: 'atari800' }),
    await checkEmulator('fceux', { label: 'fceux (NES)', targets: ['nes'], installerKey: 'fceux' }),
    // Commander X16 is five checks, not one — see checkCx16Target().
    ...(await checkCx16Target({ compilerOk: cx16CompilerOk })),
    // MEGA65 is four checks, not one — see checkMega65Target().
    ...(await checkMega65Target({ hasEmulator: Boolean(mega65EmulatorPath), emulatorPath: mega65EmulatorPath })),
  ];
  return { title: 'Atari 8-bit / NES / Commander X16 / MEGA65 emulators', checks };
}

// ---- interactive installer -------------------------------------------------
//
// A single keypress, only when there's somewhere for the answer to go: both
// ends of the terminal have to be interactive (stdin AND stdout — a doctor
// run piped into `less` or a log file has no way to show the prompt or read
// a reply) and the install has to be an installer this doctor actually knows
// how to run unattended (a real package-manager command, not a "build it
// yourself" pointer). CI and `8bs doctor > log.txt` runs never see a prompt.
function canPromptInteractively() {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Read one keypress. Restores whatever raw-mode state stdin had before. */
function readKey() {
  return new Promise((resolvePromise) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (buf) => {
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      resolvePromise(buf.toString('utf8'));
    });
  });
}

function spawnInstall(command, args) {
  process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', () => resolvePromise(false));
    child.on('close', (code) => resolvePromise(code === 0));
  });
}

/**
 * Offer to install one missing tool, right here. Only called for a FAIL
 * check that carries an `installer` this platform has a real plan for
 * (`pickInstallPlan` found a package manager on PATH) — a build-from-source
 * tool, or a platform/manager combination this doctor doesn't recognise,
 * only ever gets the printed hint, never a prompt.
 *
 * @returns {Promise<boolean>} whether an install ran (regardless of outcome)
 */
async function offerInstall(check) {
  const plan = pickInstallPlan(check.installer);
  if (!plan) return false;
  process.stdout.write(`\n  ${check.label}: ${check.installer.label} is missing.\n`);
  process.stdout.write(`  Press [i] to install with ${plan.manager} now, any other key to skip: `);
  const key = await readKey();
  process.stdout.write('\n');
  if (key.toLowerCase() !== 'i') return false;
  const command = plan.sudo ? 'sudo' : (plan.manager === 'apt' ? 'apt-get' : plan.manager);
  const args = plan.sudo ? [plan.manager === 'apt' ? 'apt-get' : plan.manager, ...plan.args] : plan.args;
  const ok = await spawnInstall(command, args);
  process.stdout.write(ok ? `  ${plan.manager} reported success.\n` : `  ${plan.manager} reported an error — see the output above.\n`);
  return true;
}

// ---- report ---------------------------------------------------------------

const MARK = { [OK]: '  ok', [FAIL]: 'FAIL', [WARN]: 'warn', [SKIP]: '  --' };

const ALL_TARGETS = ['web', 'vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65'];

/**
 * Which of `targets` are ready: every check that named a target passed. WARN
 * doesn't block readiness (e.g. VICE's `--version` flag is broken upstream —
 * prints nothing parseable — even on a working install, and the VIC-20 boot
 * check is the real, authoritative signal for that one target) — only FAIL
 * does. For mega65 specifically, this is what turns four separate checks
 * (mos-mega65-clang, xmega65, MEGA65 ROM, Xemu ROM link) into one readiness
 * bit: all four carry `targets: ['mega65']`, so mega65 is ready only when
 * none of them FAIL.
 */
export function readyTargets(checks, targets = ALL_TARGETS) {
  return targets.filter((target) => checks
    .filter((c) => c.targets.includes(target))
    .every((c) => c.status !== FAIL));
}

/** @returns {Promise<number>} process exit code */
export async function doctor() {
  process.stdout.write('8bs doctor\n');

  const mos = await checkMos();
  const cx16CompilerOk = mos.checks.some((c) => c.label === 'mos-cx16-clang' && c.status === OK);
  const sections = [
    await checkHost(),
    await checkWeb(),
    mos,
    await checkVice(),
    await checkOtherEmulators({ cx16CompilerOk }),
  ];
  const allChecks = sections.flatMap((s) => s.checks);
  let failures = 0;
  let warnings = 0;

  for (const section of sections) {
    process.stdout.write(`\n${section.title}\n`);
    for (const c of section.checks) {
      if (c.status === FAIL) failures += 1;
      if (c.status === WARN) warnings += 1;
      process.stdout.write(`  ${MARK[c.status]}  ${c.label.padEnd(28)} ${c.detail}\n`);
      if (c.hint && c.status !== OK) process.stdout.write(`        ${c.hint}\n`);
    }
  }

  const targets = readyTargets(allChecks, ALL_TARGETS);

  process.stdout.write(
    `\nTargets ready: ${targets.length ? targets.join(', ') : 'none'}.\n`,
  );

  // Offer to fix what's broken, one tool at a time, before the final
  // summary — only the FAIL checks that carry an installer this platform
  // can actually run unattended, and only in a real interactive terminal.
  const fixable = allChecks.filter((c) => c.status === FAIL && pickInstallPlan(c.installer));
  if (fixable.length && canPromptInteractively()) {
    process.stdout.write(`\n${fixable.length} of those can be installed right now:\n`);
    for (const check of fixable) {
      await offerInstall(check);
    }
    process.stdout.write('\nRe-run `8bs doctor` to confirm.\n');
    return failures > 0 ? 1 : 0;
  }

  if (failures || warnings) {
    process.stdout.write(`${failures} problem(s), ${warnings} warning(s). The setup guide is docs/setup/.\n`);
  } else {
    process.stdout.write('Everything this project needs is installed.\n');
  }
  return failures > 0 ? 1 : 0;
}
