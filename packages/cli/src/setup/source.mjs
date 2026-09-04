// Source checkout and build steps shared by every source-built target
// (`8bs setup mega65` builds Xemu, `8bs setup cx16` builds x16-emulator
// and x16-rom). Every process/filesystem boundary is injected — an `exec`
// matching exec.mjs's execInherit, plus `exists`/`mkdirFn` — so the
// per-target modules stay thin and unit tests never clone or compile.
import { access, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { execInherit } from './exec.mjs';

export async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone `repo` into `sourceDir` the first time; fast-forward it on every
 * later run. Never re-clones an existing checkout — a build directory that
 * already exists there is exactly what makes a re-run cheap (an incremental
 * `make` instead of a from-scratch build). Runs as the normal user; there is
 * no sudo anywhere in this module.
 */
export async function syncRepository({
  sourceDir, repo, exec = execInherit, exists = pathExists, mkdirFn = mkdir,
}) {
  if (await exists(join(sourceDir, '.git'))) {
    const pull = await exec('git', ['-C', sourceDir, 'pull', '--ff-only']);
    if (pull.code !== 0) return { ok: false, step: 'git pull', code: pull.code };
    return { ok: true, action: 'updated' };
  }
  await mkdirFn(dirname(sourceDir), { recursive: true });
  const clone = await exec('git', ['clone', repo, sourceDir]);
  if (clone.code !== 0) return { ok: false, step: 'git clone', code: clone.code };
  return { ok: true, action: 'cloned' };
}

/**
 * Run one build command in `cwd` and confirm every path in `artifacts` came
 * out of it. Warnings on stderr are never a failure — every source build
 * this project does (Xemu under GCC, x16-emulator under AppleClang with its
 * "reducing alignment of section" linker warnings, x16-rom's pages of
 * ca65/ld65 notices) emits some on a perfectly good build. Only a non-zero
 * exit, or a missing artifact afterward, is.
 */
export async function runBuild({
  cwd, command = 'make', args = [], artifacts = [], exec = execInherit, exists = pathExists,
}) {
  const build = await exec(command, args, { cwd });
  if (build.code !== 0) return { ok: false, step: command, code: build.code };
  for (const artifact of artifacts) {
    if (!(await exists(artifact))) {
      return { ok: false, step: command, code: build.code, missingArtifact: artifact };
    }
  }
  return { ok: true };
}
