// `8bs doctor` — is this machine able to run 8BitScript programs?
//
// The compiler is 8BitScript's own (native 6502 and WebAssembly backends).
// Building a program never needs an emulator. Running one does, and some
// machines also need ROMs. Emulators and ROMs are optional: a missing
// binary or BIOS is a warning, not a failed doctor, so a machine that
// only has VICE still exits 0. A present-but-broken install (VICE without
// Commodore ROMs, x16emu that cannot boot) is still a FAIL for that
// target. Host tools (Node, pnpm, git) stay required.
//
// Every check reports against what the project actually requires, with a
// pointer to the setup page that installs the tool, an inline
// brew/apt/pacman command when one is known, and — for anything this
// machine's platform can install with a single trusted command — an
// interactive prompt to run that command right here. The prompt defaults
// to every emulator doctor has a trusted plan for (`--want` narrows).
// `--install` runs those plans without a keypress (the VS Code Doctor
// panel uses it; a task terminal is not a TTY). Host tools are always
// in the offer: missing pnpm is `npx get-pnpm` (Corepack no longer
// ships with Node). `8bs doctor --json` is the same report for editors.
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
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { MACHINES } from '@8bitscript/compiler';

import { loadCatalog, viceEmulators, emulatorFor } from './hardware.mjs';

import { MEGA65_ROM_920413, validateRomBuffer, inspectXemuRomLink } from './setup/rom.mjs';
import { MEGA65_ROM_CANONICAL_PATH, CX16_ROM_INSTALL_PATH, xemuRomLinkPath } from './setup/paths.mjs';
import { hostPath, resolveOnPath } from './setup/host.mjs';
import { inspectLauncher } from './setup/launcher.mjs';
import {
  inspectRomFile, x16emuLauncherSpec, isBrokenMacosSymlink, parseX16emuVersion, romLoadFailure, testbenchBooted,
} from './setup/cx16.mjs';

// ---- pure helpers, unit-tested --------------------------------------------

/** First dotted version in a string, as numbers: "pnpm 12.1.0" -> [12,1,0]. */
export function parseVersion(text) {
  const s = text ?? '';
  const n = s.length;
  let i = 0;
  while (i < n && (s.charCodeAt(i) < 48 || s.charCodeAt(i) > 57)) i += 1;
  if (i >= n) return null;
  const read = () => {
    const start = i;
    while (i < n && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i += 1;
    return start === i ? null : Number(s.slice(start, i));
  };
  const major = read();
  if (major === null || s[i] !== '.') return null;
  i += 1;
  const minor = read();
  if (minor === null) return null;
  let patch = 0;
  if (s[i] === '.') {
    i += 1;
    const third = read();
    if (third !== null) patch = third;
  }
  return [major, minor, patch];
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

/** The binary `pickInstallPlan` looks for: apt's scriptable name is apt-get. */
function planBinary(plan) {
  return plan.manager === 'apt' ? 'apt-get' : plan.manager;
}

/**
 * Pick the install plan this platform can actually run. `any` is tried
 * first on every OS (pnpm is `npx get-pnpm`, which is not a brew/apt
 * formula). Then `darwin`/`linux` — the first Linux package manager found
 * on PATH, since a machine only ever has some of apt/pacman/pamac/yay/paru/brew
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
  if (installer.any && hasBinary(planBinary(installer.any))) return installer.any;
  if (platform === 'darwin') {
    return installer.darwin && hasBinary(planBinary(installer.darwin)) ? installer.darwin : null;
  }
  if (platform === 'linux') {
    return (installer.linux ?? []).find((plan) => hasBinary(planBinary(plan))) ?? null;
  }
  return null;
}

/**
 * What a doctor keypress can actually run. Packaged brew/apt/npx first;
 * then `8bs setup <target>` for a source-built installer that names a
 * setupCommand (cx16, mega65). Those used to be hint-only because
 * pickInstallPlan refuses buildFromSource.
 */
export function pickFixPlan(installer, platform = process.platform, hasBinary = onPath) {
  const packaged = pickInstallPlan(installer, platform, hasBinary);
  if (packaged) return packaged;
  if (installer?.setupCommand) {
    return { manager: '8bs', args: ['setup', installer.setupCommand] };
  }
  return null;
}

/** FAIL or WARN checks doctor can offer, one per distinct command: four
 * VICE binaries share `brew install vice`, and cx16's emulator + ROM share
 * `8bs setup cx16`. Missing emulators are WARN (optional) but still
 * installable from the prompt. */
export function uniqueFixable(checks, platform = process.platform, hasBinary = onPath) {
  const seen = new Set();
  const out = [];
  for (const check of checks) {
    if (check.status !== FAIL && check.status !== WARN) continue;
    const plan = pickFixPlan(check.installer, platform, hasBinary);
    if (!plan) continue;
    const key = `${plan.manager}\0${(plan.args ?? []).join('\0')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(check);
  }
  return out;
}

/** Installer keys with a trusted one-command plan (brew/apt/`8bs setup`).
 * Host tools (pnpm) are always offered on top. The default offer is
 * every one of these (`--want` narrows). The original five are the ones
 * doctor could install before the rest of the catalog grew plans. */
export const ORIGINAL_INSTALLERS = ['vice', 'atari800', 'fceux', 'x16emu', 'xmega65'];

/** Parse `8bs doctor` argv after the command. `--all` wins over `--want`.
 * `want: null` is every installer doctor knows; `[]` is host tools only.
 * `--install` runs the offers without a prompt. */
export function parseDoctorArgs(argv) {
  const json = argv.includes('--json');
  const install = argv.includes('--install');
  if (argv.includes('--all')) return { json, install, want: 'all' };
  const idx = argv.indexOf('--want');
  if (idx < 0) return { json, install, want: null };
  const next = argv[idx + 1];
  if (!next || next.startsWith('-')) return { json, install, want: [] };
  return { json, install, want: next.split(',').map((s) => s.trim()).filter(Boolean) };
}

/** Which INSTALLERS key (or `'pnpm'`) a check's installer object is. */
export function installerId(installer) {
  return installer?.id ?? null;
}

/**
 * uniqueFixable, then keep only the emulators `want` asked for.
 * `want` is `null` or `'all'` (every installer doctor knows — the default),
 * or an installer-key array. pnpm is never filtered out.
 */
export function wantedFixable(checks, want, platform = process.platform, hasBinary = onPath) {
  const fixable = uniqueFixable(checks, platform, hasBinary);
  if (want === 'all' || want == null) return fixable;
  const keys = new Set(want);
  return fixable.filter((check) => {
    const id = installerId(check.installer);
    return id === 'pnpm' || keys.has(id);
  });
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
  return Boolean(resolveOnPath(name));
}

// ---- the checks -----------------------------------------------------------

const OK = 'ok';
const FAIL = 'fail';
const WARN = 'warn';
const SKIP = 'skip';

const result = (status, label, detail, hint = null, extra = {}) => ({
  status, label, detail, hint, installer: extra.installer ?? null, targets: extra.targets ?? [],
});

async function versionCheck(label, command, args, minimum, hint, describeMin, extra = {}) {
  const r = await run(command, args);
  if (r.missing) return result(FAIL, label, 'not found', hint, extra);
  const version = parseVersion(r.stdout + r.stderr);
  if (!version) {
    return result(WARN, label, `installed, but the version was unreadable`, hint, extra);
  }
  const pretty = version.join('.');
  if (minimum && !atLeast(version, minimum)) {
    return result(FAIL, label, `${pretty} — need ${describeMin}`, hint, extra);
  }
  return result(OK, label, minimum ? `${pretty} (need ${describeMin})` : pretty, null, extra);
}

async function checkHost() {
  const node = parseVersion(process.version);
  const checks = [
    atLeast(node, [26])
      ? result(OK, 'Node.js', `${node.join('.')} (need >=26)`)
      : result(FAIL, 'Node.js', `${node.join('.')} — need >=26`, 'docs/language/project.md'),
    await versionCheck(
      'pnpm', 'pnpm', ['--version'], [12], installerHint(PNPM_INSTALLER), '>=12',
      { installer: PNPM_INSTALLER },
    ),
    await versionCheck('git', 'git', ['--version'], [2, 30], 'docs/language/project.md', '>=2.30'),
  ];
  return { title: 'Host', checks };
}

// pnpm is not an emulator: Corepack no longer ships with Node, and the
// standalone installer (`npx get-pnpm`) writes a native binary into
// PNPM_HOME — which a GUI editor never sees from `.zshrc`. `any` makes
// the one-key prompt work on every OS that has npx, without brew/apt.
export const PNPM_INSTALLER = {
  id: 'pnpm',
  label: 'pnpm',
  any: { manager: 'npx', args: ['--yes', 'get-pnpm'] },
  docs: 'docs/language/project.md',
};

// ---- emulator installers ---------------------------------------------------
//
// One entry per emulator doctor can one-key install. The original nine
// (VICE, atari800, FCEUX, x16emu, xmega65) have trusted brew/apt/`8bs setup`
// plans. Each carries: a doctor-facing label, the target(s) it serves, a
// brew formula or cask for macOS when one exists, a Linux package-manager
// list (tried in the order a machine is likely to have them — apt/pacman
// native packages first, AUR-only packages via pamac/yay/paru next,
// Linuxbrew last), and a `docs/setup/*.md` page. Never `brew`/`apt`
// install a package named `fuse` for the ZX emulator — that is the
// filesystem.
// `buildFromSource`/`repo` are set on top of that for the platforms (or, for
// x16emu, every platform) with no single-command install — `pickInstallPlan()`
// above only consults `.linux`/`.darwin` for whatever this specific machine
// can actually run, so `buildFromSource` never overrides a real entry.
const INSTALLERS = {
  vice: {
    id: 'vice',
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
    id: 'atari800',
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
    id: 'fceux',
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
    id: 'x16emu',
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
    id: 'xmega65',
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
  stella: {
    id: 'stella',
    label: 'Stella (Atari 2600)',
    darwin: { manager: 'brew', args: ['install', 'stella'] },
    linux: [
      { manager: 'apt', args: ['install', '-y', 'stella'], sudo: true },
      { manager: 'pacman', args: ['-S', '--noconfirm', 'stella'], sudo: true },
      { manager: 'brew', args: ['install', 'stella'] },
    ],
    docs: 'docs/setup/atari2600.md',
  },
  sameboy: {
    id: 'sameboy',
    label: 'SameBoy (GB, GBC)',
    // Homebrew has no formula; the cask installs SameBoy.app. Linux has
    // no Debian package (confirmed against games-emulator recommends);
    // Arch/Manjaro get it from the AUR.
    darwin: { manager: 'brew', args: ['install', '--cask', 'sameboy'] },
    linux: [
      { manager: 'pamac', args: ['build', '--no-confirm', 'sameboy'] },
      { manager: 'yay', args: ['-S', '--noconfirm', 'sameboy'] },
      { manager: 'paru', args: ['-S', '--noconfirm', 'sameboy'] },
    ],
    docs: 'docs/setup/gb.md',
  },
  fuse: {
    id: 'fuse',
    label: 'Fuse (ZX Spectrum)',
    // `brew install fuse` / `apt install fuse` is the filesystem, not the
    // ZX emulator. Debian's package is fuse-emulator-gtk (binary `fuse`).
    // Homebrew has no formula that puts `fuse` on PATH; the `fredm-fuse`
    // cask installs Fuse.app (resolved via DARWIN_APP_BINARIES).
    darwin: { manager: 'brew', args: ['install', '--cask', 'fredm-fuse'] },
    linux: [
      { manager: 'apt', args: ['install', '-y', 'fuse-emulator-gtk'], sudo: true },
      { manager: 'pamac', args: ['build', '--no-confirm', 'fuse-emulator'] },
      { manager: 'yay', args: ['-S', '--noconfirm', 'fuse-emulator'] },
      { manager: 'paru', args: ['-S', '--noconfirm', 'fuse-emulator'] },
    ],
    docs: 'docs/setup/spectrum.md',
  },
  openmsx: {
    id: 'openmsx',
    label: 'openMSX (MSX)',
    darwin: { manager: 'brew', args: ['install', 'openmsx'] },
    linux: [
      { manager: 'apt', args: ['install', '-y', 'openmsx'], sudo: true },
      { manager: 'pacman', args: ['-S', '--noconfirm', 'openmsx'], sudo: true },
      { manager: 'brew', args: ['install', 'openmsx'] },
    ],
    docs: 'docs/setup/msx.md',
  },
  caprice32: {
    id: 'caprice32',
    label: 'Caprice32 (Amstrad CPC)',
    // No Homebrew formula (not cap32, not caprice32). Debian package
    // caprice32 provides the `cap32` binary the catalog launches.
    linux: [
      { manager: 'apt', args: ['install', '-y', 'caprice32'], sudo: true },
      { manager: 'pamac', args: ['build', '--no-confirm', 'caprice32'] },
      { manager: 'yay', args: ['-S', '--noconfirm', 'caprice32'] },
      { manager: 'paru', args: ['-S', '--noconfirm', 'caprice32'] },
    ],
    docs: 'docs/setup/cpc.md',
  },
  xroar: {
    id: 'xroar',
    label: 'XRoar (Color Computer)',
    darwin: { manager: 'brew', args: ['install', 'xroar'] },
    linux: [
      { manager: 'apt', args: ['install', '-y', 'xroar'], sudo: true },
      { manager: 'pacman', args: ['-S', '--noconfirm', 'xroar'], sudo: true },
      { manager: 'pamac', args: ['build', '--no-confirm', 'xroar'] },
      { manager: 'yay', args: ['-S', '--noconfirm', 'xroar'] },
      { manager: 'paru', args: ['-S', '--noconfirm', 'xroar'] },
      { manager: 'brew', args: ['install', 'xroar'] },
    ],
    docs: 'docs/setup/coco.md',
  },
  vecx: {
    id: 'vecx',
    label: 'Vecx (Vectrex)',
    // No Homebrew formula. Debian has none either. Arch AUR `vecx`.
    linux: [
      { manager: 'pamac', args: ['build', '--no-confirm', 'vecx'] },
      { manager: 'yay', args: ['-S', '--noconfirm', 'vecx'] },
      { manager: 'paru', args: ['-S', '--noconfirm', 'vecx'] },
    ],
    docs: 'docs/setup/vectrex.md',
  },
  mednafen: {
    id: 'mednafen',
    label: 'Mednafen (SMS, Game Gear, PC Engine)',
    darwin: { manager: 'brew', args: ['install', 'mednafen'] },
    linux: [
      { manager: 'apt', args: ['install', '-y', 'mednafen'], sudo: true },
      { manager: 'pacman', args: ['-S', '--noconfirm', 'mednafen'], sudo: true },
      { manager: 'brew', args: ['install', 'mednafen'] },
    ],
    docs: 'docs/setup/sms.md',
  },
  mame: {
    id: 'mame',
    label: 'MAME',
    darwin: { manager: 'brew', args: ['install', 'mame'] },
    linux: [
      { manager: 'apt', args: ['install', '-y', 'mame'], sudo: true },
      { manager: 'pacman', args: ['-S', '--noconfirm', 'mame'], sudo: true },
      { manager: 'brew', args: ['install', 'mame'] },
    ],
    docs: 'docs/setup/apple2.md',
  },
};

/** Every installer key doctor can offer, in object order. */
export { INSTALLERS };

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
 * `any` is listed on every OS (that's the point of it).
 */
export function installerHint(installer, platform = process.platform) {
  if (!installer) return 'brew install <formula>, or your distro\'s package manager';
  const plans = [
    ...(installer.any ? [installer.any] : []),
    ...(platform === 'darwin'
      ? (installer.darwin ? [installer.darwin] : [])
      : platform === 'linux'
        ? (installer.linux ?? [])
        : []),
  ];
  if (plans.length === 0) {
    if (installer.buildFromSource) {
      const setupHint = installer.setupCommand ? `run: 8bs setup ${installer.setupCommand} — ` : '';
      return `${setupHint}no packaged build found — ${installer.repo} — ${installer.docs}`;
    }
    return `brew install <formula>, or your distro's package manager — ${installer.docs}`;
  }
  const detected = pickInstallPlan(installer, platform);
  const lines = plans.map((plan) => `${planCommand(plan)}${plan === detected ? '  (detected)' : ''}`);
  return `try:\n        ${lines.join('\n        ')}\n        — ${installer.docs}`;
}

/** Existence + best-effort version for an emulator binary that may hang on
 * an unrecognized flag (a GUI emulator opening a window instead of printing
 * a version) — existence is the check that matters; the version probe only
 * ever upgrades a result, never fails one, so a slow/silent version flag
 * can't turn a real install into a false FAIL. `versionArgs` is there for
 * a tool whose flag isn't `--version` (x16emu's is `-version`, but that
 * one has its own deeper checks now — checkCx16Target()). */
async function checkEmulator(binary, { label = binary, targets, installerKey, tryVersion = true, versionArgs = ['--version'] } = {}) {
  const installer = INSTALLERS[installerKey];
  if (!onPath(binary)) {
    return result(WARN, label, 'not found', installerHint(installer), { installer, targets });
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
  // serves every binary in the family, so the fallback lookups would
  // otherwise be identical repeats of each other. The machines come from
  // each package's `"8bitscript".emulator` (`family: "vice"`).
  let packageManagerVersion; // undefined until first needed, then cached (possibly null)
  for (const [machine, binary] of Object.entries(viceEmulators())) {
    const title = loadCatalog(machine).title;
    const label = `${binary} (${title})`;
    if (!onPath(binary)) {
      checks.push(result(WARN, label, 'not found', installerHint(INSTALLERS.vice), { installer: INSTALLERS.vice, targets: [machine] }));
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
    : result(WARN, 'xmega65 (MEGA65, via Xemu)', 'not found', installerHint(installer), { installer, targets }));

  const found = await find({ canonicalPath, linkPath });
  let romOk = false;
  if (!found) {
    checks.push(result(
      WARN, 'MEGA65 ROM', 'not found',
      hasEmulator
        ? 'xmega65 is installed, but the full MEGA65 ROM is missing.\n        run: 8bs setup mega65'
        : 'run: 8bs setup mega65',
      { installer, targets },
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
      { installer, targets },
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
    // "MEGA65.ROM exists but Xemu is not configured" is only true when
    // the ROM itself is already installed.
    if (!romOk) {
      checks.push(result(SKIP, 'Xemu ROM link', 'skipped — MEGA65 ROM is not installed', null, { targets }));
    } else {
      checks.push(result(
        FAIL, 'Xemu ROM link', 'MEGA65.ROM exists but Xemu is not configured to use it.',
        'run: 8bs setup mega65 --repair', { installer, targets },
      ));
    }
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
 * Every boundary is injectable for the unit tests; the defaults are real.
 */
export async function checkCx16Target({
  platform = process.platform, resolveBinary = resolveOnPath, exec = run,
  realpathFn = realpath, fs = {},
} = {}) {
  const installer = INSTALLERS.x16emu;
  const targets = ['cx16'];
  const checks = [];
  const launcherPath = resolveBinary('x16emu');

  checks.push(launcherPath
    ? result(OK, 'x16emu (Commander X16)', launcherPath, null, { targets })
    : result(WARN, 'x16emu (Commander X16)', 'not found', installerHint(installer), { installer, targets }));

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
      launcherPath ? FAIL : WARN, 'Commander X16 ROM', 'not found',
      launcherPath ? 'emulator installed but ROM is missing\n        run: 8bs setup cx16' : 'run: 8bs setup cx16',
      { installer, targets },
    ));
  } else {
    checks.push(result(FAIL, 'Commander X16 ROM', `${rom.path} is ${ROM_STATE_WORDS[rom.state]}`, 'run: 8bs setup cx16', { installer, targets }));
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

  const firstFail = checks.find((c) => c.status === FAIL);
  const firstMissing = checks.find((c) => isMissingInstall(c));
  const blocker = firstFail ?? firstMissing;
  checks.push(blocker
    ? result(SKIP, 'Commander X16', `not ready — ${blocker.label} must pass first`, null, { targets })
    : result(OK, 'Commander X16', 'ready', null, { targets }));
  return checks;
}

/** Catalog installer id → doctor INSTALLERS key (`cx16` is `x16emu`). */
export function doctorInstallerKey(emu) {
  const key = emu?.installer;
  if (key === 'cx16') return 'x16emu';
  if (key === 'mega65') return 'xmega65';
  return key ?? null;
}

async function checkOtherEmulators() {
  const checks = [];
  const seen = new Set();
  for (const machine of MACHINES) {
    const emu = emulatorFor(machine);
    if (!emu.binary || emu.family === 'vice') continue;
    const key = doctorInstallerKey(emu);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const targets = MACHINES.filter((id) => doctorInstallerKey(emulatorFor(id)) === key);
    if (key === 'x16emu') {
      checks.push(...await checkCx16Target());
      continue;
    }
    if (key === 'xmega65') {
      const mega65EmulatorPath = resolveOnPath('xmega65');
      checks.push(...await checkMega65Target({
        hasEmulator: Boolean(mega65EmulatorPath),
        emulatorPath: mega65EmulatorPath,
      }));
      continue;
    }
    checks.push(await checkEmulator(emu.binary, {
      label: INSTALLERS[key]?.label ?? `${emu.binary} (${key})`,
      targets,
      installerKey: key,
      tryVersion: key === 'atari800' || key === 'fceux',
    }));
  }
  return { title: 'Emulators', checks };
}

// ---- screenshot capability (8bs run <target> --screenshot) -----------------
//
// `--screenshot` (see screenshot.mjs) mostly rides on emulators doctor
// already checks above — a target with a working emulator has a working
// screenshot path too, with two exceptions worth a dedicated check because
// they're easy to miss until a --screenshot call fails confusingly later:
//
//   - cx16's path needs `ffmpeg` on PATH (to pull a still frame out of
//     x16emu's -gif recording). A `.8ba` FLAC source needs the same binary
//     (`@8bitscript/audio-tools`); WAV still decodes in-process without it.
//   - atari8's path needs macOS Screen Recording permission (it captures
//     the emulator's real window, since atari800 has no scriptable
//     screenshot flag — see screenshot.mjs's own header comment). Unlike
//     every other check in this file, there's no package manager fix to
//     offer: only a person clicking a checkbox in System Settings can grant
//     this, so the fix here is the exact settings pane to open, not a
//     command to run. This never fails the overall doctor run — a machine
//     with the permission not yet granted can still build and run every
//     target, `--screenshot atari8` just isn't available until it is.
async function checkScreenshotCapability() {
  const checks = [
    result(
      onPath('ffmpeg') ? OK : WARN,
      'ffmpeg (cx16 --screenshot, .8ba FLAC)',
      onPath('ffmpeg') ? 'found' : 'not found — cx16 --screenshot cannot extract a still frame, and a .8ba FLAC source cannot decode, without it',
      onPath('ffmpeg') ? null : 'brew install ffmpeg (macOS) / apt install ffmpeg (Debian/Ubuntu) / pacman -S ffmpeg (Arch)',
      { targets: [] },
    ),
  ];

  if (process.platform === 'darwin') {
    if (!onPath('atari800')) {
      checks.push(result(SKIP, 'macOS Screen Recording (atari8 --screenshot)', 'atari800 not installed — nothing to check yet', null, { targets: [] }));
    } else {
      let granted = false;
      let checkError = null;
      try {
        const { hasScreenRecordingPermission } = await import('./mac-window-capture.mjs');
        granted = await hasScreenRecordingPermission();
      } catch (err) {
        checkError = err;
      }
      if (checkError) {
        checks.push(result(WARN, 'macOS Screen Recording (atari8 --screenshot)', `could not check: ${checkError.message}`, null, { targets: [] }));
      } else {
        checks.push(result(
          granted ? OK : WARN,
          'macOS Screen Recording (atari8 --screenshot)',
          granted ? 'granted' : 'not granted — atari8 --screenshot would capture a blank/black window',
          granted ? null : 'Grant Screen Recording to whatever runs `8bs` (Terminal, your IDE, ...): System Settings -> Privacy & Security -> Screen Recording. Open that pane directly with: open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"',
          { targets: [] },
        ));
      }
    }
  } else {
    checks.push(result(SKIP, 'macOS Screen Recording (atari8 --screenshot)', 'not macOS — atari8 --screenshot has no equivalent on this platform yet', null, { targets: [] }));
  }

  return { title: 'Screenshot capability (`8bs run <target> --screenshot`)', checks };
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

function offerScopeLine(want) {
  if (want === 'all' || want == null) {
    return 'every emulator this doctor can install (default; `--want` to narrow)';
  }
  if (Array.isArray(want)) {
    return want.length ? `--want ${want.join(',')}` : 'host tools only (`--want` with no emulators)';
  }
  return 'every emulator this doctor can install';
}

/**
 * Run one install plan. Only called for a check that carries a pickFixPlan.
 *
 * @returns {Promise<{ ran: boolean, ok: boolean }>}
 */
async function runInstall(check) {
  const plan = pickFixPlan(check.installer);
  if (!plan) return { ran: false, ok: false };
  let command;
  let args;
  if (plan.manager === '8bs') {
    command = process.execPath;
    args = [process.argv[1], ...plan.args];
  } else {
    command = plan.sudo ? 'sudo' : (plan.manager === 'apt' ? 'apt-get' : plan.manager);
    args = plan.sudo ? [plan.manager === 'apt' ? 'apt-get' : plan.manager, ...plan.args] : plan.args;
  }
  const ok = await spawnInstall(command, args);
  process.stdout.write(ok ? `  ${plan.manager} reported success.\n` : `  ${plan.manager} reported an error — see the output above.\n`);
  return { ran: true, ok };
}

async function runAllInstalls(fixable) {
  let installsRan = 0;
  let installsFailed = 0;
  for (const check of fixable) {
    const { ran, ok } = await runInstall(check);
    if (ran) installsRan += 1;
    if (ran && !ok) installsFailed += 1;
  }
  return { installsRan, installsFailed };
}

/**
 * Offer each missing tool in turn. [i] this one, [s] skip this one,
 * [a] the rest, [q] stop offering. The list is printed first so a
 * thirty-machine catalog is not a mystery sequence of one-key prompts.
 *
 * @returns {Promise<{ installsRan: number, installsFailed: number }>}
 */
async function offerInstalls(fixable) {
  process.stdout.write(`  [i] install this, [s] skip this, [a] install all remaining, [q] stop offering\n`);
  let installsRan = 0;
  let installsFailed = 0;
  let remainder = false;
  for (const check of fixable) {
    if (!remainder) {
      const plan = pickFixPlan(check.installer);
      const offered = plan?.manager === '8bs' ? `8bs ${plan.args.join(' ')}` : (plan?.manager ?? 'the package manager');
      process.stdout.write(`\n  ${check.label}: ${check.installer.label} is missing.\n`);
      process.stdout.write(`  Press [i] to install with ${offered} now, [s]/[a]/[q]: `);
      const key = (await readKey()).toLowerCase();
      process.stdout.write('\n');
      if (key === 'q') break;
      if (key === 's') continue;
      if (key === 'a') remainder = true;
      else if (key !== 'i') continue;
    }
    const { ran, ok } = await runInstall(check);
    if (ran) installsRan += 1;
    if (ran && !ok) installsFailed += 1;
  }
  return { installsRan, installsFailed };
}

// ---- report ---------------------------------------------------------------

const MARK = { [OK]: '  ok', [FAIL]: 'FAIL', [WARN]: 'warn', [SKIP]: '  --' };

const ALL_TARGETS = MACHINES;

/**
 * Which of `targets` are ready: every check that named a target passed. WARN
 * doesn't block readiness (e.g. VICE's `--version` flag is broken upstream —
 * prints nothing parseable — even on a working install, and the VIC-20 boot
 * check is the real, authoritative signal for that one target) — only FAIL
 * does. For mega65 specifically, this is what turns three separate checks
 * (xmega65, MEGA65 ROM, Xemu ROM link) into one readiness bit: all three
 * carry `targets: ['mega65']`, so mega65 is ready only when none of them
 * FAIL.
 */
export function readyTargets(checks, targets = ALL_TARGETS) {
  return targets.filter((target) => checks
    .filter((c) => c.targets.includes(target))
    .every((c) => c.status !== FAIL));
}

/** A check that means the optional emulator or ROM was never installed. */
export function isMissingInstall(check) {
  if (check.status !== WARN && check.status !== SKIP) return false;
  return /not found|not installed/i.test(check.detail ?? '');
}

/**
 * Targets whose emulator or ROM is simply not installed (WARN), with no
 * FAIL on a present-but-broken install. Distinct from readyTargets, which
 * only looks at FAIL.
 */
export function notInstalledTargets(checks, targets = ALL_TARGETS) {
  return targets.filter((target) => {
    const relevant = checks.filter((c) => c.targets.includes(target));
    if (relevant.some((c) => c.status === FAIL)) return false;
    return relevant.some((c) => isMissingInstall(c));
  });
}

/** Targets that can actually `8bs run` on this machine. */
export function runnableTargets(checks, targets = ALL_TARGETS) {
  const missing = new Set(notInstalledTargets(checks, targets));
  return readyTargets(checks, targets).filter((target) => !missing.has(target));
}

function doctorReport(sections, targets = ALL_TARGETS) {
  const allChecks = sections.flatMap((s) => s.checks);
  const failures = allChecks.filter((c) => c.status === FAIL).length;
  const warnings = allChecks.filter((c) => c.status === WARN).length;
  const ready = runnableTargets(allChecks, targets);
  const notInstalled = notInstalledTargets(allChecks, targets);
  const failed = targets.filter((target) => allChecks
    .filter((c) => c.targets.includes(target))
    .some((c) => c.status === FAIL));
  return {
    ok: failures === 0,
    failures,
    warnings,
    sections: sections.map((section) => ({
      title: section.title,
      checks: section.checks.map((c) => ({
        status: c.status,
        label: c.label,
        detail: c.detail,
        hint: c.hint,
        targets: c.targets,
      })),
    })),
    ready,
    notInstalled,
    failed,
  };
}

/** @returns {Promise<number>} process exit code */
export async function doctor({ json = false, want = null, install = false } = {}) {
  // A Dock-launched editor's PATH has none of nvm / pnpm / Homebrew. Append
  // those well-known bins before any check or one-key install runs, so
  // `pnpm` and `npx get-pnpm` resolve the same way the editor does.
  process.env.PATH = hostPath();

  const sections = [
    await checkHost(),
    await checkVice(),
    await checkOtherEmulators(),
    await checkScreenshotCapability(),
  ];
  const report = doctorReport(sections, ALL_TARGETS);
  const { failures, warnings, ready: targets, notInstalled } = report;

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return failures > 0 ? 1 : 0;
  }

  process.stdout.write('8bs doctor\n');
  process.stdout.write('compiler: built in (native backends)\n');

  for (const section of sections) {
    process.stdout.write(`\n${section.title}\n`);
    for (const c of section.checks) {
      process.stdout.write(`  ${MARK[c.status]}  ${c.label.padEnd(28)} ${c.detail}\n`);
      if (c.hint && c.status !== OK) process.stdout.write(`        ${c.hint}\n`);
    }
  }

  process.stdout.write(
    `\nTargets ready: ${targets.length ? targets.join(', ') : 'none'}.\n`,
  );
  process.stdout.write(
    `Not installed: ${notInstalled.length ? notInstalled.join(', ') : 'none'}.\n`,
  );

  // Offer to install missing optional emulators, or repair a FAIL, one
  // tool at a time — only checks that carry an installer this platform
  // can actually run unattended, only the ones `--want`/`--all` asked
  // for (all of them by default). `--install` skips the prompt (a VS Code
  // task terminal is not a TTY). Otherwise only a real interactive
  // terminal sees the keypress offer.
  const fixable = wantedFixable(sections.flatMap((s) => s.checks), want);
  if (fixable.length && install) {
    process.stdout.write(`\nInstalling ${fixable.length} (${offerScopeLine(want)}):\n`);
    for (const check of fixable) process.stdout.write(`  - ${check.label}\n`);
    const { installsRan, installsFailed } = await runAllInstalls(fixable);
    process.stdout.write('\nRe-run `8bs doctor` to confirm.\n');
    return (installsRan === fixable.length && installsFailed === 0) ? 0 : (failures > 0 ? 1 : 0);
  }

  const promptable = canPromptInteractively();
  if (fixable.length && promptable) {
    process.stdout.write(`\n${fixable.length} of those can be installed right now (${offerScopeLine(want)}):\n`);
    for (const check of fixable) process.stdout.write(`  - ${check.label}\n`);
    const { installsRan, installsFailed } = await offerInstalls(fixable);
    process.stdout.write('\nRe-run `8bs doctor` to confirm.\n');
    return (installsRan === fixable.length && installsFailed === 0) ? 0 : (failures > 0 ? 1 : 0);
  }

  if (failures || warnings) {
    process.stdout.write(`${failures} problem(s), ${warnings} warning(s). The setup guide is docs/setup/.\n`);
  } else {
    process.stdout.write('Everything this project needs is installed.\n');
  }
  return failures > 0 ? 1 : 0;
}
