// Arch/Manjaro package dependencies for building Xemu's MEGA65 core, and for
// extracting the C64 Forever MSI. `pacman -S --needed` is already idempotent
// (it only touches packages that aren't at the requested state), so rather
// than hand-rolling per-package "is this installed" detection this checks
// with `pacman -T` — pacman's own "which of these are NOT already
// satisfied" query, confirmed on a real Manjaro box to handle both ordinary
// packages and Manjaro's `base-devel` meta-package correctly — and only
// prompts for a sudo install when something is actually missing.
export const XEMU_BUILD_PACKAGES = Object.freeze([
  'base-devel', 'git', 'pkgconf', 'sdl2-compat', 'gtk3', 'readline',
]);

export const MSITOOLS_PACKAGE = 'msitools';

/** Parse `pacman -T`'s stdout: one not-yet-satisfied package name per line,
 * nothing at all when every package is already installed. */
export function parseMissingPackages(stdout) {
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** Which of `packages` still needs installing on this machine. Returns the
 * full list back (rather than throwing) if `pacman` itself isn't found —
 * callers on a non-Arch box, or one with a broken PATH, get a clear "needs
 * install" signal instead of a crash. */
export async function missingPacmanPackages(packages, exec) {
  const r = await exec('pacman', ['-T', ...packages]);
  if (r.missing) return [...packages];
  return parseMissingPackages(r.stdout);
}

/** `sudo pacman -S --needed <packages>` — no `--noconfirm`: pacman's own
 * confirmation prompt reaches the user naturally, since setup runs it with
 * stdio inherited, matching the brief's own example command exactly. */
export function installPacmanPackages(packages, sudoExec) {
  return sudoExec('pacman', ['-S', '--needed', ...packages]);
}
