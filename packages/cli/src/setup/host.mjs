// Host-platform prerequisites for `8bs setup` that aren't packages: the
// Apple Command Line Tools on macOS, and PATH inspection every launcher
// install needs. Process boundaries are injected (an `exec` matching
// exec.mjs's execCapture/execInherit) so unit tests never run them.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Is `name` an executable on PATH? Same logic as doctor.mjs's private
 * onPath(); exported here so setup shares it rather than re-deriving it. */
export function hasBinaryOnPath(name, env = process.env, platform = process.platform) {
  const binary = platform === 'win32' ? `${name}.exe` : name;
  return (env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, binary)));
}

/** Is `dir` one of PATH's entries? `/usr/local/bin` is the tested launcher
 * location on both macOS and Linux, but a minimal PATH (some CI images,
 * some shells' non-login profiles) can omit it — in which case a launcher
 * installed there is real but invisible, and setup should say so. */
export function isDirOnPath(dir, env = process.env) {
  return (env.PATH ?? '').split(delimiter).some((entry) => entry && entry.replace(/\/+$/, '') === dir);
}

/**
 * `xcode-select -p` exits 0 (printing the active developer directory) only
 * when the Command Line Tools — or a full Xcode — are installed; it exits
 * non-zero with "unable to get active developer directory" otherwise.
 * Checked before ever offering `xcode-select --install`, so a machine that
 * already has them is never asked again (the install command is a GUI
 * dialog, not something to re-trigger on every run).
 */
export async function hasXcodeCommandLineTools(exec) {
  const r = await exec('xcode-select', ['-p']);
  return !r.missing && r.code === 0;
}

/** Trigger Apple's Command Line Tools installer. This opens a macOS dialog
 * and returns immediately — the download runs outside our process — so the
 * caller has to tell the user to re-run setup once it finishes, rather than
 * waiting on the exit code. */
export function installXcodeCommandLineTools(exec) {
  return exec('xcode-select', ['--install']);
}

/** Full path of the first `name` on PATH, or null — what `command -v`
 * answers. The doctor reports this for x16emu so a reader sees *which*
 * launcher is in play (`/usr/local/bin/x16emu`), and inspects that exact
 * file for the macOS symlink trap. */
export function resolveOnPath(name, env = process.env, platform = process.platform) {
  const binary = platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
