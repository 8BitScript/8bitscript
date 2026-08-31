---
title: Host toolchain
nav_order: 2
---

# Host toolchain

This page installs the general-purpose tooling every contributor needs before
touching anything 6502-specific: Node.js, pnpm, git, and an editor. The
retro-side toolchain — the compiler and linker that produce a `.prg` — is
covered on the next page, [LLVM-MOS SDK](llvm-mos.md).

Everything here is a one-time setup. Nothing on this page builds or runs
8BitScript code; there is nothing in the repository to build yet.

## Node.js 26

Node.js 26 runs the compiler, the CLI, and the web build, so it is the one hard
requirement for working on this project.

It is the **Current** line rather than an LTS one until 28 October 2026, when it
becomes the active LTS and is then supported into April 2029. This project
tracks it now rather than waiting: nothing here is in production, and moving to
the line that will carry the project for the next two and a half years is
cheaper today than after the compiler exists. Node 24 is the LTS line as of this
writing, and it is **not** what this repository is set up for — `engines` in
`package.json` refuses it.

A version manager is the recommended installation route on both macOS and Linux.
It keeps the project's Node version independent of anything the system package
manager installs, and it avoids the permission problems described in
[Troubleshooting](#troubleshooting) below.

### macOS

Recommended — install Node 26 through `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
```

Open a new shell so `nvm` is on the path, then:

```bash
nvm install 26
nvm use 26
nvm alias default 26
```

Alternative — Homebrew, if you would rather not manage versions:

```bash
brew install node@26
```

Homebrew keeps `node@26` keg-only on some setups; follow the `brew info node@26`
instructions to put it on your `PATH` if `node --version` does not pick it up.

### Linux

Recommended — the same `nvm` flow works on Linux:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
```

Open a new shell, then:

```bash
nvm install 26
nvm use 26
nvm alias default 26
```

`fnm` is a faster drop-in alternative if you prefer it; either is fine, as long
as exactly one of them is managing Node.

Alternative — the NodeSource setup script, which adds a Node 26 repository to
your system package manager:

```bash
curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Your distribution's own package is unlikely to be new enough while 26 is still
the Current line — most ship the LTS. Check what it offers before installing; a
distro package on Node 24 or older is not usable here.

### Verify

```bash
node --version
```

Expected output is `v26.x.x`. If it reports an older major version, the shell is
still resolving an older install — see [Troubleshooting](#troubleshooting).

## pnpm 12

pnpm 12 is the package manager and workspace runner for this repository. npm and
yarn are not supported; the workspace layout and lockfile assume pnpm.

Install it globally — **the version is not optional here**. pnpm 12 is published
but npm's `latest` tag still points at the 11 line, so a bare
`npm install --global pnpm` gets you 11:

```bash
npm install --global pnpm@12
```

Alternative — Corepack, which ships with Node and manages the package manager
version for you:

```bash
corepack enable
corepack prepare pnpm@12 --activate
```

pnpm 12 requires only Node 18 or newer, so Node 26 satisfies it with room to
spare; if the Node step above succeeded there is nothing else to arrange.

### Verify

```bash
pnpm --version
```

Expected output is `12.x.x`.

If it reports `11.x.x`, you have the `latest` build. Re-run the install with the
explicit `@12`.

## Version pinning

`package.json` pins both the Node line and the package manager, so every
contributor and every CI run uses the same versions:

```json
{
  "engines": { "node": ">=26", "pnpm": ">=12" },
  "packageManager": "pnpm@12.1.0"
}
```

`engines` fails the install when the wrong major is active. `packageManager`
pins the exact pnpm build: pnpm reads that field and downloads the matching
version itself, so a contributor whose global pnpm is on a different line still
resolves the lockfile identically. Corepack uses the same field.

Those two fields pin the tools. The repository's pnpm lockfile,
`pnpm-lock.yaml`, pins the third piece: the dependency graph. It records the
exact resolved version of every direct and transitive dependency, so an install
produces the same package tree on every contributor's machine and in CI rather
than whatever the version ranges in `package.json` happen to resolve to on the
day. The lockfile is committed alongside `package.json`, is updated by pnpm as a
side effect of adding or upgrading a dependency, and is never edited by hand.

Both files are in the repository. `pnpm install` from the root is what applies
them, and it is the first command to run after cloning.

## git

git 2.30 or newer is expected. Any version shipped with a currently supported
macOS or Linux distribution is fine.

```bash
git --version
```

All work lands directly on `trunk`. There are no long-lived feature branches and
no release branches, so keep changes small enough to merge straight into it.

## Editor

Use [Visual Studio Code](https://code.visualstudio.com/) or
[Cursor](https://cursor.com/). Cursor is built on the VS Code extension
ecosystem, so anything written for VS Code works there too.

### Syntax highlighting for `.8bs`

The repository carries its own editor extension at `editors/vscode/`. It gives
`.8bs` files syntax highlighting, `//` and `/* */` comment toggling, bracket
matching, and auto-closing pairs. Link it into your editor and reload the
window:

```bash
ln -s "$PWD/editors/vscode" ~/.cursor/extensions/8bitscript.8bitscript-lang-0.0.0
```

Use `~/.vscode/extensions/` instead for VS Code, and run the command from the
repository root either way. Then run **Developer: Reload Window** from the
command palette and open a `.8bs` file — the status bar should report the
language as *8BitScript*.

It is a symlink rather than a copy so that editing the grammar and reloading the
window is the whole loop. Remove it with `rm` on the link.

It also connects the editor to `8bs lsp`, so errors appear as you type — the
same errors `8bs check` prints, from the same compiler. See
[Editor support](../language-server.md) for how that fits together and how to
use other editors.

Third-party extensions for other retro languages are not recommended as a
stopgap — they key off different file extensions and different syntax, and will
highlight 8BitScript incorrectly.

## Why TypeScript is the implementation language

Context, not a setup step — nothing below needs installing today.

The 8BitScript compiler is an ordinary Node program written in TypeScript, which
is why the host toolchain is a Node toolchain and not, say, a Rust or C++ one.

The project itself is authored in TypeScript 7, but it will bootstrap on the
TypeScript 6 programmatic parser API via `@typescript/typescript6`, because
TypeScript 7.0 does not yet expose a stable compiler API. That split is
temporary and lives entirely inside the compiler's own dependencies; it does not
change anything about how you set up your machine.

## Troubleshooting

**`EACCES` errors on a global install.** If `npm install --global pnpm@12` fails
with a permissions error, npm is trying to write into a system-owned Node
installation. Do not fix this with `sudo` — it leaves root-owned files in your
npm cache that cause further failures. Install Node through `nvm` or `fnm`
instead, as described above, so the global directory lives under your home
directory and needs no elevated permissions.

**Multiple Node versions on `PATH`.** If `node --version` disagrees with what
you just installed, something earlier on `PATH` is winning. Check which binary
is actually being resolved:

```bash
which node
which -a node
```

A path under `/usr/bin` or `/usr/local/bin` means the system Node is shadowing
your version manager. Version managers prepend their shim directory to `PATH`
from your shell rc file (`~/.zshrc`, `~/.bashrc`), so make sure that
initialization runs *after* anything else that modifies `PATH`, then open a new
shell.

**`pnpm: command not found` after `corepack enable`.** Corepack installs shims
rather than a binary, and the change only takes effect in a new shell session.
Open a new terminal and try again. If it still fails, confirm Corepack's shim
directory is on your `PATH`:

```bash
which corepack
echo "$PATH"
```

The shim directory sits alongside the `node` binary, so if `which node` resolves
correctly and `pnpm` still does not, re-run `corepack prepare pnpm@12
--activate` and check its output for errors.

## Next

With Node, pnpm, git, and an editor in place, continue to the
[LLVM-MOS SDK](llvm-mos.md).
