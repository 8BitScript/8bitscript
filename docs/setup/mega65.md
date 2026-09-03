---
title: MEGA65
nav_order: 8
---

# MEGA65

[Xemu](https://github.com/lgblgblgb/xemu) is the emulator suite this project
targets for the MEGA65, via its `xmega65` core — `8bs build --target mega65`
links against llvm-mos's `mega65` platform (see [LLVM-MOS](llvm-mos.md)),
which reaches the machine through its VIC-II-compatible register view: same
registers, same colours, same numbers as the C64, on more capable silicon.

There's no packaged build to install `xmega65` from, on any platform —
upstream doesn't tag releases, and this project doesn't depend on the AUR
`xmega65-git` package (it's unreliable/outdated). `xmega65` is built
directly from [lgblgblgb/xemu](https://github.com/lgblgblgb/xemu) instead.
On top of that, actually *running* the MEGA65 core needs a MEGA65 ROM —
copyrighted Commodore/MEGA65 material this project cannot bundle, download
on your behalf, or commit to this repository (see
[MEGA65 ROM handling](#mega65-rom-handling) below).

## Automated setup

```bash
8bs setup mega65
```

On Arch/Manjaro, this does everything short of what only you can legally
provide:

1. Checks `mos-mega65-clang` is on `LLVM_MOS_HOME` (see [LLVM-MOS](llvm-mos.md) —
   `8bs setup` doesn't install the compiler toolchain itself).
2. Installs Xemu's build dependencies with `pacman` if any are missing
   (`base-devel git pkgconf sdl2-compat gtk3 readline`) — asks first.
3. Clones/updates [lgblgblgb/xemu](https://github.com/lgblgblgb/xemu) into a
   cache directory (not `~/Development`), builds only `targets/mega65`, and
   installs the result as `/opt/xemu/xmega65` with a
   `/usr/local/bin/xmega65` symlink — all under `sudo` only for the
   `install`/`mkdir`/`ln` steps into `/opt` and `/usr/local/bin`; the clone
   and build run as your normal user.
4. Walks you through the ROM: asks for the path to a **C64 Forever** MSI
   installer, extracts the free Commodore 65 ROM from it, downloads the
   official MEGA65 ROM patch, builds the official `romdiff` patch tool, and
   patches the two together into `/opt/mega65/MEGA65.ROM` — validating
   every file's size and SHA-256 along the way, and stopping with a clear
   error rather than guessing if anything doesn't match.
5. Links `~/.xemu-lgb/MEGA65.ROM` to the canonical install so Xemu finds it,
   without ever overwriting an existing, unrelated file there.

It's interactive where it needs your input (the C64 Forever MSI path, a
`pacman` install, migrating an existing ROM) and safe to re-run — every step
checks what's already in place first and skips it.

Two flags skip the interactive prompts, for scripting or when you've already
downloaded the files by hand:

```bash
8bs setup mega65 --c64-forever ~/Downloads/c64-forever-11-setup.msi
8bs setup mega65 --rom-patch ~/Downloads/920413_Sn7YEw.zip
```

`--rom-patch` matters for a specific reason: the official patch's download
URL (below) carries what looks like a content hash or random token in its
filename, which may not be stable if MEGA65's file host ever re-issues this
release. If the automated download ever 404s, grab the zip from
[files.mega65.org](https://files.mega65.org/) yourself and pass it with
`--rom-patch` — the ROM's own SHA-256 (also below) is what actually
guarantees correctness, not the URL.

Once it finishes, confirm with:

```bash
8bs doctor
```

which reports `xmega65`, `MEGA65 ROM`, and `MEGA65 boot` as three separate
checks — see [Doctor](#doctor) below for why.

## MEGA65 ROM handling

The complete MEGA65 ROM is not freely redistributable — Xemu's own wiki
calls fetching it "a legal issue" and this project will not bundle it,
mirror it, or fetch it from anywhere on your behalf. What *is* legal, and
what `8bs setup mega65` automates, is generating your own copy from two
things Cloanto and the MEGA65 project both distribute freely:

- **The original Commodore 65 ROM** (version 910828), from Cloanto's free
  **C64 Forever Free Express Edition** for Windows —
  <https://www.c64forever.com/>. The file needed is
  `c-65-19910828.rom`, 131072 bytes,
  SHA-256 `0c4a00b45b65ca553b8a9f38cae83fe5f7dca7e809c24c0051ae40956640509d`,
  buried inside the MSI installer (no need to run it — see
  [Extracting the C64 Forever MSI on Linux](#extracting-the-c64-forever-msi-on-linux)
  below).
- **The official MEGA65 920413 ROM patch**, a `.rdf` "ROM diff" file (not
  ROM content) from the MEGA65 project itself:
  <https://files.mega65.org/files/other/920413_Sn7YEw.zip> (see the caveat
  about this URL above). The resulting `MEGA65.ROM`, once patched, is 131072
  bytes with SHA-256
  `af3c447f791a2fdc48cb21e1bd3fab015e32641228d9d30d21259b9e878c6fa0`.

`8bs setup mega65` installs the result as `/opt/mega65/MEGA65.ROM` and links
it into Xemu's own per-user data directory at `~/.xemu-lgb/MEGA65.ROM`.

### Open ROM

The [MEGA65/open-roms](https://github.com/MEGA65/open-roms) project is a
from-scratch, GPLv3, freely redistributable replacement ROM. It's a
reasonable thing to run Xemu against by hand, but `8bs doctor`/`8bs setup`
do not treat it as equivalent to the full MEGA65 ROM for target readiness —
it doesn't implement the complete MEGA65 ROM/BASIC environment, and this
project would rather report "not ready" accurately than claim a target
works when only a subset does. A limited fallback mode built around it may
come later.

## Doctor

```
ok   xmega65 (MEGA65, via Xemu)   found
ok   MEGA65 ROM                   920413
ok   MEGA65 boot                  emulator configuration ready
```

These are three separate checks, not one — `xmega65` existing on `PATH`
does not mean MEGA65 is ready to run, since a fresh Xemu install has no ROM
until `8bs setup mega65` (or the manual steps below) produces one. `8bs
doctor` checks `/opt/mega65/MEGA65.ROM` first, then
`~/.xemu-lgb/MEGA65.ROM`, and validates whichever it finds against the known
920413 size/hash — a present-but-wrong file (an Open ROM, a different
release, a corrupt download) is reported as a `FAIL`, not silently accepted.
`MEGA65 boot` is a configuration check, not an actual emulator launch —
Xemu is a GUI application with no confirmed headless boot-verification flag,
unlike the [VICE](vice.md) integration's real boot check.

## Manual reference (Arch/Manjaro)

Everything below is what `8bs setup mega65` automates. Useful if the
automated command fails partway and you want to see exactly what it was
doing, or if you'd rather run each step yourself.

### Dependencies

```bash
sudo pacman -S --needed \
  base-devel \
  git \
  pkgconf \
  sdl2-compat \
  gtk3 \
  readline
```

Current Arch/Manjaro uses `sdl2-compat` (an SDL 1.2-compatible shim over
SDL2), not a separate `sdl2` package, for this build.

### Building xmega65

```bash
git clone https://github.com/lgblgblgb/xemu.git
cd xemu/targets/mega65
make
```

This builds only the MEGA65 core — Xemu has cores for several other
Commodore/MEGA machines this project doesn't need. The resulting binary is
`xemu/build/bin/xmega65.native`. On a current Arch/Manjaro system (GCC 16,
SDL2 compatibility layer 2.32.70, GTK3) this build succeeds with several
harmless compiler warnings — only a non-zero `make` exit code or a missing
resulting binary means the build actually failed.

Install it system-wide (never as `xmega65.native` — always renamed on
install):

```bash
sudo mkdir -p /opt/xemu
sudo install -m755 build/bin/xmega65.native /opt/xemu/xmega65
sudo ln -sf /opt/xemu/xmega65 /usr/local/bin/xmega65
```

### Extracting the C64 Forever MSI on Linux

```bash
sudo pacman -S --needed msitools   # provides msiextract
msiextract -C ./c64forever c64-forever-11-setup.msi
find ./c64forever -name c-65-19910828.rom
```

The path inside the MSI has been observed at `Program Files/Cloanto/C64
Forever/Shared/rom/c-65-19910828.rom`, but search for the basename rather
than relying on that exact path — Cloanto's own installer layout is not a
contract. Verify size (131072 bytes) and SHA-256 (above) before using it;
if it doesn't match, this is not the expected base ROM and the rest of the
process should not proceed.

### Building romdiff

The official patch tool comes from
[MEGA65/mega65-tools](https://github.com/MEGA65/mega65-tools). **Do not run
`make all`** on current Arch — it fails building the bundled `cbmconvert`
project under GCC 16, because `cbmconvert` declares `false` as an enum
identifier and GCC 16 treats `false` as a C23 keyword
(`util.h:78:3: error: cannot use keyword 'false' as enumeration constant`).
This project only needs `romdiff`, so build only that:

```bash
git clone https://github.com/MEGA65/mega65-tools.git
cd mega65-tools
make bin/romdiff
```

`which: no acme` warnings during this build are harmless upstream noise
unrelated to `romdiff` and can be ignored.

### Patching the ROM

```bash
cp c-65-19910828.rom 910828.BIN
/path/to/mega65-tools/bin/romdiff 920413.rdf MEGA65.ROM
```

`romdiff` reads the reference ROM's filename (`910828.BIN` for this
release) out of the `.rdf` file's own header rather than it being an
argument — the copy above has to land in the same directory `romdiff` runs
from, under that exact name. Successful output looks like:

```
Diff file is 69743 bytes long. Reffile is '910828.BIN'
Read reference ROM '910828.BIN'
Successfully wrote 'MEGA65.ROM'
```

The result should be 131072 bytes with the SHA-256 given above.

### Installing the ROM

```bash
sudo mkdir -p /opt/mega65
sudo install -m644 MEGA65.ROM /opt/mega65/MEGA65.ROM
```

Xemu reads its ROM from its own per-user data directory,
`~/.xemu-lgb/MEGA65.ROM` on Linux (it may not exist yet if Xemu has never
run — that's fine, it gets created either by Xemu's own first launch or by
this symlink step). Link the canonical install into it rather than copying,
so there's one file to keep up to date:

```bash
mkdir -p ~/.xemu-lgb
ln -sf /opt/mega65/MEGA65.ROM ~/.xemu-lgb/MEGA65.ROM
```

If `~/.xemu-lgb/MEGA65.ROM` already exists as something else — a regular
file rather than a symlink — check what it is before overwriting it: if
it's already a valid copy of the same ROM, it's safe to replace with the
symlink above; if it's not, it may be a different setup you don't want to
lose, and it should be moved aside rather than deleted outright.

## Verify

```bash
xmega65 -h
```

should print its usage. First-run dialogs about creating a data directory,
a missing system ROM, or SD card/system files are normal on a fresh
`~/.xemu-lgb` before the ROM is linked in — once `MEGA65.ROM` is installed
correctly, `xmega65` boots the real MEGA65 environment instead of Xemu's
stub/open ROM one.

## Run

```bash
8bs run mega65
```

**This one is best-effort.** `8bs run` passes the built `.prg` as `-prg
<file>`, the same flag other Xemu cores accept — but this project has not
independently confirmed the MEGA65 core accepts it the same way, because
Xemu's own MEGA65 documentation covers SD-card-image setup, not command-line
autoloading. If `8bs run mega65` doesn't load the program, run `xmega65 -h`
to see what your build actually supports, and load the `.prg` from
`dist/` by hand.

## Next

With every target's emulator installed, confirm the whole toolchain
responds: [Verify your setup](verify.md).
