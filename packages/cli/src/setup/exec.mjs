// Process execution for `8bs setup`. Two shapes, both plain argv arrays
// (never a shell string — see execCapture/execInherit below), plus a sudo
// wrapper that is the *only* place elevated privileges are allowed to enter
// this pipeline. Kept separate from doctor.mjs's own private `run()`: that
// one buffers output for parsing a version string; a source build wants its
// output streamed to the terminal live, and setup also needs a sudo path
// doctor's checks never do.
import { spawn } from 'node:child_process';

/** Run a command, buffering stdout/stderr. For output setup needs to parse
 * or validate (e.g. `pacman -Qi`) rather than show the user directly. */
export function execCapture(command, args, { timeout = 30_000, cwd } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    } catch {
      resolvePromise({ code: null, stdout: '', stderr: '', missing: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = timeout ? setTimeout(() => child.kill('SIGKILL'), timeout) : null;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr, missing: true });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, missing: false });
    });
  });
}

/** Run a command with its stdio connected straight to this process — for a
 * build (`make`), a clone (`git`), or an extraction (`msiextract`) whose
 * live output the user should see, and whose exit code is the only thing
 * that matters afterward. Never treats stderr output alone as failure: the
 * brief is explicit that harmless compiler warnings are not a build error —
 * only a non-zero exit code (or, separately, a missing resulting binary) is. */
export function execInherit(command, args, { cwd } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'inherit', cwd });
    } catch {
      resolvePromise({ code: null, missing: true });
      return;
    }
    child.on('error', () => resolvePromise({ code: null, missing: true }));
    child.on('close', (code) => resolvePromise({ code, missing: false }));
  });
}

// The only three destinations `8bs setup mega65` is allowed to write to as
// root, per the brief's "be conservative around sudo" section.
export const SUDO_ALLOWED_ROOTS = Object.freeze(['/opt/xemu', '/opt/mega65', '/usr/local/bin']);

/** Last non-flag argument — for `mkdir -p <dir>`, `install -m755 <src>
 * <dst>`, and `ln -sf <target> <linkname>`, that's the one path each of
 * these commands actually *writes* to (a copy/link source, like `install`'s
 * <src>, is only ever read — it isn't a privilege-escalation target and
 * legitimately lives outside the allowed roots, e.g. under the user's own
 * ~/.cache build tree). */
function writeTarget(args) {
  const positionals = args.filter((a) => !a.startsWith('-'));
  return positionals[positionals.length - 1];
}

/**
 * Enforce the brief's sudo allowlist at the one place every elevated call in
 * this pipeline goes through, rather than leaving it as a comment code
 * review has to keep true by hand: `pacman` (package installation) is always
 * allowed; `mkdir`/`install`/`ln` are allowed only when the path they write
 * to falls under SUDO_ALLOWED_ROOTS; anything else is refused outright.
 * Throws rather than silently skipping, since a caller reaching this with an
 * unexpected command/target is a bug worth surfacing immediately.
 */
export function assertSudoAllowed(command, args) {
  if (command === 'pacman') return;
  if (command === 'mkdir' || command === 'install' || command === 'ln') {
    const target = writeTarget(args);
    const allowed = target && SUDO_ALLOWED_ROOTS.some((root) => target === root || target.startsWith(`${root}/`));
    if (allowed) return;
    throw new Error(
      `refusing 'sudo ${command} ${args.join(' ')}' — '${target}' is outside the allowed `
      + `sudo write targets (${SUDO_ALLOWED_ROOTS.join(', ')})`,
    );
  }
  throw new Error(`refusing 'sudo ${command}' — not one of the sudo operations this setup pipeline allows`);
}

/** Run one command under sudo, as an explicit argv array — never a shell
 * string, so a path or filename containing spaces or shell metacharacters
 * can't be reinterpreted. `-n` (non-interactive) is deliberately not passed:
 * a real sudo password prompt should work normally; this only removes the
 * possibility of silently shelling out through an interpreter. */
export function sudoRun(command, args, opts) {
  assertSudoAllowed(command, args);
  return execInherit('sudo', [command, ...args], opts);
}
