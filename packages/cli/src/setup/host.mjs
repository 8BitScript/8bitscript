// Host-platform prerequisites for `8bs setup` that aren't packages: the
// Apple Command Line Tools on macOS, and PATH inspection every launcher
// install needs. Process boundaries are injected (an `exec` matching
// exec.mjs's execCapture/execInherit) so unit tests never run them.
//
// extraHostBinDirs / hostPath are the other half of that: a GUI-launched
// editor never reads `.zshrc`, so pnpm's installer, nvm, and Apple Silicon
// Homebrew are invisible unless we add the directories they actually use.
// The VS Code extension's extraBinDirs() must stay in sync with this list
// (editors/vscode/src/projects.cjs).
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Is `name` an executable on PATH? Same logic as doctor.mjs's private
 * onPath(); exported here so setup shares it rather than re-deriving it. */
export function hasBinaryOnPath(name, env = process.env, platform = process.platform) {
  const binary = platform === 'win32' ? `${name}.exe` : name;
  return (env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, binary)));
}

/** Strip every trailing `ch` from `s`. */
function withoutTrailingChar(s, ch) {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end -= 1;
  return s.slice(0, end);
}

/** Is `dir` one of PATH's entries? `/usr/local/bin` is the tested launcher
 * location on both macOS and Linux, but a minimal PATH (some CI images,
 * some shells' non-login profiles) can omit it — in which case a launcher
 * installed there is real but invisible, and setup should say so. */
export function isDirOnPath(dir, env = process.env) {
  return (env.PATH ?? '').split(delimiter).some((entry) => entry && withoutTrailingChar(entry, '/') === dir);
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

/**
 * Homebrew casks that install a .app rather than a PATH binary. Doctor
 * and `8bs run` look here after PATH so `sameboy` / `fuse` still resolve
 * after `brew install --cask sameboy` / `fredm-fuse`. The cask named
 * `fuse` is the filesystem — never that one.
 */
export const DARWIN_APP_BINARIES = {
  sameboy: ['/Applications/SameBoy.app/Contents/MacOS/SameBoy'],
  fuse: [
    '/Applications/Fuse.app/Contents/MacOS/Fuse',
    '/Applications/Fuse for macOS/Fuse.app/Contents/MacOS/Fuse',
  ],
};

/** Full path of the first `name` on PATH, or null — what `command -v`
 * answers. The doctor reports this for x16emu so a reader sees *which*
 * launcher is in play (`/usr/local/bin/x16emu`), and inspects that exact
 * file for the macOS symlink trap. On macOS, Homebrew casks for SameBoy
 * and Fuse are checked after PATH. */
export function resolveOnPath(name, env = process.env, platform = process.platform) {
  const binary = platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  if (platform === 'darwin') {
    for (const candidate of DARWIN_APP_BINARIES[name] ?? []) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Highest installed nvm node `bin/`, or null. */
function nvmNodeBin(home) {
  const base = join(home, '.nvm', 'versions', 'node');
  let names;
  try {
    names = readdirSync(base).filter((name) => name.startsWith('v'));
  } catch {
    return null;
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const last = names.at(-1);
  return last ? join(base, last, 'bin') : null;
}

function pnpmHomeDirs(home, env, platform) {
  const homes = [];
  if (env.PNPM_HOME) homes.push(env.PNPM_HOME);
  if (platform === 'darwin') homes.push(join(home, 'Library', 'pnpm'));
  if (platform === 'win32') {
    homes.push(join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'pnpm'));
  }
  homes.push(join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'pnpm'));
  return homes;
}

/**
 * Directories a GUI-launched editor or a non-login shell often lacks on
 * PATH. pnpm 12's installer writes `PNPM_HOME` into `.zshrc` (macOS:
 * `~/Library/pnpm`; Linux: `~/.local/share/pnpm`); nvm and Homebrew do
 * the same. Each pnpm home is listed both as itself and as `bin/` —
 * older installs put the executable in the home, current ones in `bin/`.
 *
 * @param {string} [home]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function extraHostBinDirs(home = homedir(), env = process.env, platform = process.platform) {
  const pnpmBins = pnpmHomeDirs(home, env, platform).flatMap((dir) => [join(dir, 'bin'), dir]);
  return [...new Set([
    ...pnpmBins,
    join(home, '.local', 'bin'),
    env.NVM_BIN,
    nvmNodeBin(home),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.fnm', 'aliases', 'default', 'bin'),
    join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ].filter(Boolean))];
}

/**
 * PATH with well-known bins appended, so a Dock-launched editor's
 * `8bs doctor` can still see pnpm, npx, and brew.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @param {NodeJS.Platform} [platform]
 */
export function hostPath(env = process.env, home = homedir(), platform = process.platform) {
  const current = (env.PATH || '').split(delimiter).filter(Boolean);
  return [...new Set([...current, ...extraHostBinDirs(home, env, platform)])].join(delimiter);
}
