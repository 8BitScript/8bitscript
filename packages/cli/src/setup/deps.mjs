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

// Tested Apple Silicon macOS build: `brew install sdl2 wget git` was
// sufficient. `sdl2` currently resolves to the `sdl2-compat` formula on
// current Homebrew — confirmed working, same shim Arch's `sdl2-compat`
// package provides. No msitools equivalent here: the C64-Forever-MSI ROM
// generation flow (see setup/mega65-rom.mjs) is gated behind the explicit
// `--c64-forever` flag and isn't part of the macOS milestone — `--rom`
// (installing an already-generated MEGA65.ROM) is.
export const MEGA65_BREW_PACKAGES = Object.freeze(['sdl2', 'wget', 'git']);

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

// ---- Homebrew (macOS) ------------------------------------------------------
//
// The tested Commander X16 build on Apple Silicon macOS uses these Homebrew
// formulae. `pkgconf` isn't strictly needed — without it CMake only says
// "pkg-config missing. Skipping FluidSynth auto-detection." and the emulator
// still builds — but installing it lets dependency detection work normally.
// FluidSynth itself is optional and not installed: basic X16 emulation
// doesn't need it.
export const CX16_BREW_PACKAGES = Object.freeze([
  'git', 'cmake', 'python', 'pkgconf', 'sdl2', 'cc65', 'lzsa',
]);

// Arch/Manjaro equivalents for the same build. cc65 and lzsa are AUR-only
// there (confirmed against `pacman -Si` — "package not found"), so they're
// checked as binaries on PATH rather than as pacman packages; see
// missingPathTools() and docs/setup/cx16.md's `pamac build cc65 lzsa`.
export const CX16_PACMAN_PACKAGES = Object.freeze([
  'base-devel', 'cmake', 'git', 'python', 'zlib', 'sdl2-compat',
]);
export const CX16_AUR_TOOLS = Object.freeze(['cc65', 'lzsa']);

/**
 * Which of `packages` Homebrew doesn't have installed. One `brew list
 * --versions <all>` call first: it exits 0 only when every formula is
 * installed, which is the common (complete-install) case and costs ~0.2s.
 * Only when that fails does this ask per package — necessary because brew
 * resolves aliases in its output (`python` prints as `python@3.14`, `sdl2`
 * as `sdl2-compat`, both confirmed on a real macOS box), so the names in
 * the combined output can't be matched back to what was asked for. Returns
 * every package when `brew` itself isn't found, mirroring
 * missingPacmanPackages().
 */
export async function missingBrewPackages(packages, exec) {
  const all = await exec('brew', ['list', '--versions', ...packages]);
  if (all.missing) return [...packages];
  if (all.code === 0) return [];
  const missing = [];
  for (const pkg of packages) {
    const r = await exec('brew', ['list', '--versions', pkg]);
    if (r.missing || r.code !== 0) missing.push(pkg);
  }
  return missing;
}

/** `brew install <packages>` — as the normal user, never under sudo (brew
 * refuses to run as root), with stdio inherited so brew's own progress and
 * any prompts reach the terminal. */
export function installBrewPackages(packages, exec) {
  return exec('brew', ['install', ...packages]);
}

/** Which of `tools` (bare command names) aren't on PATH — for dependencies
 * that only exist outside the platform's package manager (AUR builds of
 * cc65/lzsa on Arch). `hasBinary` is injected so tests never touch PATH. */
export function missingPathTools(tools, hasBinary) {
  return tools.filter((tool) => !hasBinary(tool));
}
