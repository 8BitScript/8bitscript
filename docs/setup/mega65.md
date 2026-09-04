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
directly from [lgblgblgb/xemu](https://github.com/lgblgblgb/xemu) instead —
tested on both Apple Silicon macOS and Arch/Manjaro Linux. On top of that,
actually *running* the MEGA65 core needs a MEGA65 ROM — copyrighted
Commodore/MEGA65 material this project cannot bundle, download on your
behalf, or commit to this repository (see
[MEGA65 ROM handling](#mega65-rom-handling) below).

## Automated setup

```bash
8bs setup mega65 --rom ~/Downloads/MEGA65.ROM
```

This does everything short of what only you can legally provide — a full
MEGA65 ROM:

1. Checks `mos-mega65-clang` is on `LLVM_MOS_HOME` (see [LLVM-MOS](llvm-mos.md) —
   `8bs setup` doesn't install the compiler toolchain itself).
2. **macOS:** checks the Apple Command Line Tools with `xcode-select -p` and
   offers `xcode-select --install` only if they're absent; then requires
   Homebrew (found via `PATH`, never a hardcoded `/opt/homebrew`) and
   installs the build dependencies `sdl2 wget git` with `brew install` if
   any are missing — asks first. If `brew` itself is missing it says so and
   points at <https://brew.sh>; it never runs the Homebrew bootstrap script
   for you.
   **Linux:** installs `base-devel git pkgconf sdl2-compat gtk3 readline`
   with `pacman` if missing (asks first).
3. Clones (or fast-forwards) [lgblgblgb/xemu](https://github.com/lgblgblgb/xemu)
   into a cache directory — `~/.cache/8bitscript/setup/` (or
   `$XDG_CACHE_HOME`), never `~/Development` — and builds only
   `targets/mega65`, as your normal user. Harmless compiler warnings
   (confirmed on both GCC/Arch and Apple clang/macOS — experimental
   pointer/sprite features, no `_mm_malloc()` on ARM, unused
   variables) are expected, not failures; only a non-zero `make` exit or a
   missing resulting binary is.
4. Installs the result as `/opt/xemu/xmega65` (never named `xmega65.native`)
   with `sudo` only for that `mkdir`/`install` step, then puts a
   `/usr/local/bin/xmega65` symlink on `PATH` — unlike Commander X16's
   x16emu, a plain symlink works correctly for xmega65 on macOS too
   (confirmed on a real install), so there's no wrapper script here.
5. Installs the ROM you provide with `--rom` (see
   [MEGA65 ROM handling](#mega65-rom-handling)) as
   `/opt/mega65/MEGA65.ROM`.
6. Sets up Xemu's own per-user data directory if it doesn't exist yet —
   `~/Library/Application Support/xemu-lgb/mega65/` on macOS,
   `~/.local/share/xemu-lgb/mega65/` on Linux — with the `~/.xemu-lgb`
   compatibility symlink Xemu itself would create on first launch, without
   ever running the emulator just to get that layout. An existing
   `~/.xemu-lgb` (Xemu's own, from a prior launch) is left completely
   alone.
7. Links `~/.xemu-lgb/MEGA65.ROM` to the canonical install so Xemu finds it,
   without ever overwriting an existing, unrelated file there.

It's safe to re-run: every step checks what's already in place first and
skips it, so a complete install goes straight through with no sudo, no
Homebrew/pacman, and no rebuild. `--repair` is accepted as an alias for a
plain run — it already repairs a broken launcher or a missing ROM link
without rebuilding anything:

```bash
8bs setup mega65 --repair
```

If you omit `--rom` and run interactively, setup asks for the path
directly (`Path to MEGA65.ROM:`) rather than looking for a C64 Forever
installer — see the next section for why, and for the separate
`--c64-forever`/`--rom-patch` flow that generates a ROM from scratch.

Once it finishes, confirm with:

```bash
8bs doctor
```

which reports `xmega65`, `MEGA65 ROM`, `Xemu ROM link`, and `MEGA65` as
four separate checks — see [Doctor](#doctor) below for why.

## MEGA65 ROM handling

The complete MEGA65 ROM is not freely redistributable — Xemu's own wiki
calls fetching it "a legal issue" and this project will not bundle it,
mirror it, or fetch it from anywhere on your behalf. `8bs setup mega65`
therefore always needs *you* to supply one, in one of two ways:

- **`--rom /path/to/MEGA65.ROM`** — you already have a generated
  `MEGA65.ROM` (from another machine, or from the manual process below) and
  just want it installed and linked. This is the primary path, and the one
  the interactive prompt asks for when `--rom` isn't given.
- **`--c64-forever <msi>`** (with optional `--rom-patch <zip>`) — generate
  one from Cloanto's free **C64 Forever Free Express Edition** installer
  plus the official MEGA65 920413 patch, entirely on this machine. This
  flow extracts the free Commodore 65 ROM from the MSI, downloads the
  official patch, builds the official `romdiff` patch tool, and patches the
  two together — validating every file's size and SHA-256 along the way,
  and stopping with a clear error rather than guessing if anything doesn't
  match. See [Generating the ROM from C64 Forever](#generating-the-rom-from-c64-forever)
  below for the manual equivalent and the exact files involved. This flow
  is only exercised when you pass `--c64-forever` explicitly — it needs
  `msiextract` (Arch: `msitools`), which is out of scope for the macOS
  milestone documented here.

Either way, the result is installed as `/opt/mega65/MEGA65.ROM` and linked
into Xemu's own per-user data directory at `~/.xemu-lgb/MEGA65.ROM`.

### The pinned release

8BitScript currently verifies ROMs against one specific release:

- **MEGA65 920413**, 131072 bytes, SHA-256
  `af3c447f791a2fdc48cb21e1bd3fab015e32641228d9d30d21259b9e878c6fa0`.

A ROM matching that hash is installed and reported `ready` everywhere. A
file that's the right size (131072 bytes) but a different hash — a future
release, an Open ROM saved with the wrong name, or anything else — is
**installed anyway, never silently rejected or deleted**, but reported as
an unverified version: `8bs setup mega65` won't print "MEGA65 is ready",
and `8bs doctor` will report `MEGA65 ROM` as not ready until a verified
920413 copy replaces it. A file of the wrong size is refused outright —
that's not a MEGA65 ROM at all. This mirrors the brief this feature was
built from: known-good releases are meant to be a small table setup can
grow, not a single hardcoded assumption.

### Xemu's per-user data directory

Xemu keeps its own MEGA65 state — configuration, SD card image, ROM — in a
per-platform directory, with `~/.xemu-lgb` as a compatibility symlink into
it (confirmed against real first launches on both platforms):

| Platform | Real data directory |
| --- | --- |
| macOS | `~/Library/Application Support/xemu-lgb/mega65/` |
| Linux | `~/.local/share/xemu-lgb/mega65/` |

`8bs setup mega65` reads and writes the ROM through the `~/.xemu-lgb`
compatibility path on both platforms, so the canonical system layout
(`/opt/mega65/MEGA65.ROM`, `/opt/xemu/xmega65`, `/usr/local/bin/xmega65`)
stays identical across platforms even though Xemu's own user data doesn't.
If Xemu has never run, `~/.xemu-lgb` doesn't exist yet — setup creates the
same layout Xemu's first launch would (the real directory, then the
symlink) rather than launching a GUI emulator during an automated setup.
Anything already there — Xemu's own symlink from a real prior launch, or a
plain directory — is left completely untouched.

### Xemu's built-in stub ROM is not a MEGA65 ROM

Without a real `MEGA65.ROM`, Xemu still runs: it reports
`FILE: @MEGA65.ROM cannot be open` and falls back to its own bundled
`Xemu-ROMs` (reported as version `920000`). That's Xemu working correctly,
not this project's target being ready — `xmega65` existing and even
launching successfully says nothing about whether the *MEGA65 environment*
it boots into is the real one. `8bs doctor` never looks at Xemu's internal
stub — it only ever checks the files this project manages
(`/opt/mega65/MEGA65.ROM` and `~/.xemu-lgb/MEGA65.ROM`), so a stub-only
install is correctly reported as ROM `not found`, not as ready.

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
ok   xmega65 (MEGA65, via Xemu)   /usr/local/bin/xmega65
ok   MEGA65 ROM                   920413
ok   Xemu ROM link                configured
ok   MEGA65                       ready
```

These are four separate checks, not one:

- **xmega65** — the launcher found on `PATH`, shown as its resolved path.
- **MEGA65 ROM** — a full, official 920413 ROM exists somewhere this
  project (or a manual install) would put it. `8bs doctor` checks
  `/opt/mega65/MEGA65.ROM` first, then `~/.xemu-lgb/MEGA65.ROM`, and
  validates whichever it finds against the known 920413 size/hash — a
  present-but-wrong file (an Open ROM, a different release, a corrupt
  download) is reported as a `FAIL`, not silently accepted.
- **Xemu ROM link** — separately: can *Xemu itself* actually see that ROM?
  A canonical install with no `~/.xemu-lgb/MEGA65.ROM` link passes `MEGA65
  ROM` but fails this check — a real, tested gap where `xmega65` would
  still boot into the stub ROM despite a perfectly good ROM sitting at
  `/opt/mega65`:

  ```
  FAIL  Xemu ROM link   MEGA65.ROM exists but Xemu is not configured to use it.
        run: 8bs setup mega65 --repair
  ```

  A ROM installed directly at the Xemu-local path (not linked to a
  canonical copy — say, a hand-placed file) is accepted and labelled as
  such rather than treated as a failure.
- **MEGA65** — ready only when the compiler (`mos-mega65-clang`), `xmega65`,
  the ROM, and the Xemu ROM link all pass.

## Manual reference — macOS

What `8bs setup mega65 --rom` automates, step by step, as verified on
Apple Silicon.

### Dependencies

```bash
xcode-select --install   # skip if `xcode-select -p` already succeeds
brew install sdl2 wget git
```

`sdl2` currently resolves to the `sdl2-compat` formula on current Homebrew
— confirmed working. Xemu's own build detected `SDL video=cocoa`,
`SDL renderer=metal` against this.

### Building xmega65

```bash
git clone https://github.com/lgblgblgb/xemu.git
cd xemu/targets/mega65
make
```

This builds only the MEGA65 core. The resulting binary is
`xemu/build/bin/xmega65.native`. A clean build succeeds with several
harmless compiler warnings (experimental pointer/sprite features, no
`_mm_malloc()` on ARM, unused variables/functions) — only a non-zero
`make` exit code or a missing resulting binary means the build actually
failed.

Install it system-wide (never as `xmega65.native` — always renamed on
install) and put it on `PATH`:

```bash
sudo mkdir -p /opt/xemu
sudo install -m755 build/bin/xmega65.native /opt/xemu/xmega65
sudo mkdir -p /usr/local/bin
sudo ln -sf /opt/xemu/xmega65 /usr/local/bin/xmega65
```

Unlike Commander X16's x16emu, this plain symlink layout works correctly
for xmega65 on macOS — confirmed by running `cd ~ && xmega65` through it
and getting the same result as running the real binary directly. No
wrapper script is needed here.

### Installing your MEGA65 ROM

```bash
sudo mkdir -p /opt/mega65
sudo install -m644 ~/Downloads/MEGA65.ROM /opt/mega65/MEGA65.ROM
```

On first launch without a real ROM, Xemu creates its own data directory —
on macOS, `~/Library/Application Support/xemu-lgb/mega65/` — along with a
`~/.xemu-lgb` compatibility symlink into it, `mega65-default.cfg`,
`i2c.bin`, `XEMU-STUB.ROM`, and other first-run files; that's normal, and
none of it needs to exist before installing the real ROM. If
`~/.xemu-lgb` doesn't exist yet (Xemu has never run), create the same
layout by hand rather than launching a GUI emulator just to get it:

```bash
mkdir -p ~/Library/Application\ Support/xemu-lgb/mega65
ln -s ~/Library/Application\ Support/xemu-lgb/mega65 ~/.xemu-lgb
```

Then link the canonical ROM into it — the exact path Xemu reads from is
`~/.xemu-lgb/MEGA65.ROM`:

```bash
ln -sf /opt/mega65/MEGA65.ROM ~/.xemu-lgb/MEGA65.ROM
```

If `~/.xemu-lgb/MEGA65.ROM` already exists as something else — a regular
file rather than a symlink — check what it is before overwriting it: if
it's already a valid copy of the same ROM, it's safe to replace with the
symlink above; if it's not, it may be a different setup you don't want to
lose, and it should be moved aside rather than deleted outright. And if
`~/.xemu-lgb` itself already points somewhere else, leave it as-is — it's
Xemu's own layout from a real prior launch, not something to replace.

### Verifying the ROM hash

```bash
shasum -a 256 /opt/mega65/MEGA65.ROM
```

should print `af3c447f791a2fdc48cb21e1bd3fab015e32641228d9d30d21259b9e878c6fa0`
for the current pinned 920413 release (131072 bytes).

## Generating the ROM from C64 Forever

This is the `--c64-forever`/`--rom-patch` flow — the one part of `8bs setup
mega65` this project cannot do without files only you can legally provide,
and (on the current Linux-only build of it) needs `msitools`
(`msiextract`).

What *is* legal, and what this flow automates, is generating your own
MEGA65.ROM from two things Cloanto and the MEGA65 project both distribute
freely:

- **The original Commodore 65 ROM** (version 910828), from Cloanto's free
  **C64 Forever Free Express Edition** for Windows —
  <https://www.c64forever.com/>. The file needed is
  `c-65-19910828.rom`, 131072 bytes,
  SHA-256 `0c4a00b45b65ca553b8a9f38cae83fe5f7dca7e809c24c0051ae40956640509d`,
  buried inside the MSI installer (no need to run it).
- **The official MEGA65 920413 ROM patch**, a `.rdf` "ROM diff" file (not
  ROM content) from the MEGA65 project itself:
  <https://files.mega65.org/files/other/920413_Sn7YEw.zip>. The URL
  carries what looks like a content hash or random token in its filename,
  which may not be stable if MEGA65's file host ever re-issues this
  release — if the automated download 404s, grab the zip from
  [files.mega65.org](https://files.mega65.org/) yourself and pass it with
  `--rom-patch`; the ROM's own SHA-256 (above) is what actually guarantees
  correctness, not the URL.

```bash
8bs setup mega65 --c64-forever ~/Downloads/c64-forever-11-setup.msi
8bs setup mega65 --rom-patch ~/Downloads/920413_Sn7YEw.zip
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

The result should be 131072 bytes with the SHA-256 given above — from
here, install it the same way [Installing your MEGA65 ROM](#installing-your-mega65-rom)
describes, or just pass it straight to `8bs setup mega65 --rom MEGA65.ROM`.

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
