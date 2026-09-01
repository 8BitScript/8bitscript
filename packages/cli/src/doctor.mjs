// `8bs doctor` — is this machine able to build and run 8BitScript programs?
//
// Two output targets, two toolchains to verify:
//
//   .wasm — needs the AssemblyScript compiler (asc)
//   .prg  — needs the LLVM-MOS SDK (via $LLVM_MOS_HOME) and the VICE emulators
//
// Every check reports against what the project actually requires, with a
// pointer to the setup page that installs the tool. The VIC-20 check goes
// further than versions: a VICE build without ROMs prints a version and still
// cannot boot a machine, so the doctor launches the emulator for a bounded
// number of cycles and confirms it actually comes up. docs/setup/vice.md is
// explicit that anything less reports success on a setup that cannot run a
// single build.
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

const result = (status, label, detail, hint = null) => ({ status, label, detail, hint });

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
      ? result(OK, 'asc', version.join('.'))
      : result(WARN, 'asc', 'found, but the version was unreadable'));
  }
  return { title: 'Web target (.wasm)', checks };
}

async function checkMos() {
  const checks = [];
  const home = process.env.LLVM_MOS_HOME;

  if (!home) {
    checks.push(result(FAIL, 'LLVM_MOS_HOME', 'not set', 'docs/setup/llvm-mos.md'));
    checks.push(result(SKIP, 'mos-vic20-clang', 'skipped — LLVM_MOS_HOME is not set'));
    checks.push(result(SKIP, 'mos-c64-clang', 'skipped — LLVM_MOS_HOME is not set'));
  } else if (!existsSync(join(home, 'bin'))) {
    checks.push(result(
      FAIL, 'LLVM_MOS_HOME', `set to ${home}, but ${join(home, 'bin')} does not exist`,
      'It must point at the directory that directly contains bin/ — docs/setup/llvm-mos.md',
    ));
    checks.push(result(SKIP, 'mos-vic20-clang', 'skipped — LLVM_MOS_HOME is wrong'));
    checks.push(result(SKIP, 'mos-c64-clang', 'skipped — LLVM_MOS_HOME is wrong'));
  } else {
    checks.push(result(OK, 'LLVM_MOS_HOME', home));
    for (const tool of ['mos-vic20-clang', 'mos-c64-clang']) {
      const path = join(home, 'bin', tool);
      const r = await run(path, ['--version']);
      if (r.missing) {
        checks.push(result(FAIL, tool, `not found at ${path}`, 'docs/setup/llvm-mos.md'));
      } else if (/clang/i.test(r.stdout + r.stderr)) {
        const version = parseVersion(r.stdout + r.stderr);
        checks.push(result(OK, tool, version ? `clang ${version.join('.')}` : 'a clang'));
      } else {
        checks.push(result(WARN, tool, 'runs, but does not identify itself as clang'));
      }
    }
  }

  for (const [binary, machine] of [['xvic', 'VIC-20'], ['x64sc', 'C64']]) {
    if (!onPath(binary)) {
      checks.push(result(FAIL, binary, 'not found', 'docs/setup/vice.md'));
      continue;
    }
    const r = await run(binary, ['--version']);
    const version = parseVersion(r.stdout + r.stderr);
    if (!version) {
      checks.push(result(WARN, binary, 'found, but the version was unreadable', 'docs/setup/vice.md'));
    } else if (!atLeast(version, [3, 10])) {
      checks.push(result(WARN, binary, `VICE ${version.join('.')} — the project expects 3.10`, 'docs/setup/vice.md'));
    } else {
      checks.push(result(OK, binary, `VICE ${version.join('.')} (${machine})`));
    }
  }

  checks.push(await bootCheck());
  return { title: 'VIC-20 / C64 target (.prg)', checks };
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

// ---- report ---------------------------------------------------------------

const MARK = { [OK]: '  ok', [FAIL]: 'FAIL', [WARN]: 'warn', [SKIP]: '  --' };

/** @returns {Promise<number>} process exit code */
export async function doctor() {
  process.stdout.write('8bs doctor\n');

  const sections = [await checkHost(), await checkWeb(), await checkMos()];
  let failures = 0;
  let warnings = 0;

  for (const section of sections) {
    process.stdout.write(`\n${section.title}\n`);
    for (const c of section.checks) {
      if (c.status === FAIL) failures += 1;
      if (c.status === WARN) warnings += 1;
      process.stdout.write(`  ${MARK[c.status]}  ${c.label.padEnd(16)} ${c.detail}\n`);
      if (c.hint && c.status !== OK) process.stdout.write(`        ${c.hint}\n`);
    }
  }

  // WARN doesn't block readiness: e.g. VICE's `--version` flag is broken
  // upstream (prints nothing parseable) even on a working install, and the
  // VIC-20 boot check above is the real, authoritative signal for that target.
  const ready = (section) => section.checks.every((c) => c.status !== FAIL);
  const targets = [];
  if (ready(sections[1])) targets.push('web');
  if (ready(sections[2])) targets.push('vic20/c64');

  process.stdout.write(
    `\nTargets ready: ${targets.length ? targets.join(', ') : 'none'}.\n`,
  );
  if (failures || warnings) {
    process.stdout.write(`${failures} problem(s), ${warnings} warning(s). The setup guide is docs/setup/.\n`);
  } else {
    process.stdout.write('Everything this project needs is installed.\n');
  }
  return failures > 0 ? 1 : 0;
}
