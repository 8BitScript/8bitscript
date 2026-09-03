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
// The VIC-20 check goes further than versions: a VICE build without ROMs
// prints a version and still cannot boot a machine, so the doctor launches
// the emulator for a bounded number of cycles and confirms it actually
// comes up. docs/setup/vice.md is explicit that anything less reports
// success on a setup that cannot run a single build. The other targets
// don't get that same depth yet — existence and, where the tool supports
// it, a version — that's a known gap, not an oversight.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

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
 * since a machine only ever has some of apt/pacman/brew(linuxbrew). Returns
 * null for a source-only installer, an unsupported platform, or a Linux box
 * with none of the listed managers on PATH (docs/hints still apply either
 * way; this only decides whether the interactive one-key install applies).
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
// likely to have them — apt/pacman native packages first, Linuxbrew last),
// and either a `docs/setup/*.md` page or — for the two emulators this
// project could not find a package for — the upstream repo to build from
// source. `pickInstallPlan()` above turns this into the one command this
// specific machine can actually run.
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
    linux: [
      { manager: 'apt', args: ['install', '-y', 'atari800'], sudo: true },
      { manager: 'pacman', args: ['-S', '--noconfirm', 'atari800'], sudo: true },
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
    buildFromSource: true,
    repo: 'https://github.com/X16Community/x16-emulator',
    docs: 'docs/setup/cx16.md',
  },
  xmega65: {
    label: 'Xemu — MEGA65 core (xmega65)',
    buildFromSource: true,
    repo: 'https://github.com/lgblgblgb/xemu',
    docs: 'docs/setup/mega65.md',
  },
};

/** One line: what this machine can run, or where to read more. */
function installerHint(installer) {
  const plan = pickInstallPlan(installer);
  if (plan) {
    const cmd = plan.sudo ? `sudo ${plan.manager === 'apt' ? 'apt-get' : plan.manager}` : plan.manager;
    return `${cmd} ${plan.args.join(' ')} — ${installer.docs}`;
  }
  if (installer.buildFromSource) {
    return `no packaged build found — ${installer.repo} — ${installer.docs}`;
  }
  return `brew install <formula>, or your distro's package manager — ${installer.docs}`;
}

/** Existence + best-effort version for an emulator binary that may hang on
 * an unrecognised flag (a GUI emulator opening a window instead of printing
 * a version) — existence is the check that matters; the version probe only
 * ever upgrades a result, never fails one, so a slow/silent --version can't
 * turn a real install into a false FAIL. */
async function checkEmulator(binary, { label = binary, targets, installerKey, tryVersion = true } = {}) {
  const installer = INSTALLERS[installerKey];
  if (!onPath(binary)) {
    return result(FAIL, label, 'not found', installerHint(installer), { installer, targets });
  }
  if (!tryVersion) return result(OK, label, 'found', null, { targets });
  const r = await run(binary, ['--version']);
  if (r.missing || r.timedOut) return result(OK, label, 'found (version unconfirmed)', null, { targets });
  const version = parseVersion(r.stdout + r.stderr);
  return version
    ? result(OK, label, version.join('.'), null, { targets })
    : result(OK, label, 'found (version unconfirmed)', null, { targets });
}

async function checkVice() {
  const checks = [];
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
    const version = parseVersion(r.stdout + r.stderr);
    if (!version) {
      checks.push(result(WARN, label, 'found, but the version was unreadable', 'docs/setup/vice.md', { targets: [machine] }));
    } else if (!atLeast(version, [3, 10])) {
      checks.push(result(WARN, label, `VICE ${version.join('.')} — the project expects 3.10`, 'docs/setup/vice.md', { targets: [machine] }));
    } else {
      checks.push(result(OK, label, `VICE ${version.join('.')}`, null, { targets: [machine] }));
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

async function checkOtherEmulators() {
  const checks = [
    await checkEmulator('atari800', { label: 'atari800 (Atari 8-bit)', targets: ['atari8'], installerKey: 'atari800' }),
    await checkEmulator('fceux', { label: 'fceux (NES)', targets: ['nes'], installerKey: 'fceux' }),
    // Built from source, with no confirmed --version flag (see the cx16 and
    // mega65 setup docs) — existence is all this checks.
    await checkEmulator('x16emu', { label: 'x16emu (Commander X16)', targets: ['cx16'], installerKey: 'x16emu', tryVersion: false }),
    await checkEmulator('xmega65', { label: 'xmega65 (MEGA65, via Xemu)', targets: ['mega65'], installerKey: 'xmega65', tryVersion: false }),
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

/** @returns {Promise<number>} process exit code */
export async function doctor() {
  process.stdout.write('8bs doctor\n');

  const sections = [
    await checkHost(),
    await checkWeb(),
    await checkMos(),
    await checkVice(),
    await checkOtherEmulators(),
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

  // A target is ready when every check that named it passed. WARN doesn't
  // block readiness (e.g. VICE's `--version` flag is broken upstream —
  // prints nothing parseable — even on a working install, and the VIC-20
  // boot check above is the real, authoritative signal for that one target).
  const ready = (target) => allChecks
    .filter((c) => c.targets.includes(target))
    .every((c) => c.status !== FAIL);
  const targets = ALL_TARGETS.filter(ready);

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
