// Privileged file installation into /opt/<tool> and /usr/local/bin — the
// only place `8bs setup` writes as root, and always through exec.mjs's
// sudoRun allowlist. Files are compared before they're copied, so a re-run
// against an already-complete install never asks for a password just to
// overwrite a byte-identical binary.
import { readFile } from 'node:fs/promises';

/** Byte-for-byte comparison of two files; `false` when either is unreadable
 * (missing, or a directory), which callers treat as "needs installing". */
export async function filesIdentical(a, b, read = readFile) {
  try {
    const [x, y] = await Promise.all([read(a), read(b)]);
    return x.equals(y);
  } catch {
    return false;
  }
}

/** `sudo mkdir -p <dir>` — idempotent, and refused by sudoRun's allowlist
 * for any directory outside the roots exec.mjs names. */
export async function ensureDirectory(dir, sudoExec) {
  const r = await sudoExec('mkdir', ['-p', dir]);
  if (r.code !== 0) return { ok: false, step: 'mkdir', code: r.code, path: dir };
  return { ok: true };
}

/**
 * `sudo install -m<mode> <src> <dst>` for each file that isn't already in
 * place with identical contents. Returns which paths were actually written
 * so the caller can report "installed" vs "already current" honestly.
 * Stops at the first failed step — a half-installed layout is reported, not
 * papered over by the steps after it.
 */
export async function installFiles(files, sudoExec, { identical = filesIdentical } = {}) {
  const installed = [];
  const unchanged = [];
  for (const { src, dst, mode } of files) {
    if (await identical(src, dst)) {
      unchanged.push(dst);
      continue;
    }
    const r = await sudoExec('install', [`-m${mode}`, src, dst]);
    if (r.code !== 0) return { ok: false, step: 'install', code: r.code, path: dst, installed, unchanged };
    installed.push(dst);
  }
  return { ok: true, installed, unchanged };
}
