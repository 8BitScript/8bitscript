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

There's no packaged build of Xemu for macOS or Linux yet, the same situation
as the [Commander X16](cx16.md) — it's built from source.

## Build from source

```bash
git clone https://github.com/lgblgblgb/xemu.git
cd xemu
make -C targets/mega65
```

This produces an `xmega65` binary (the exact path depends on the Xemu
version — check `targets/mega65/` after the build). Put it somewhere on
your `PATH` so `8bs run mega65` can find it. Xemu's own wiki has more detail
if the build fails: [Mega65 emulation how to
start](https://github.com/lgblgblgb/xemu/wiki/Mega65-emulation-how-to-start).

macOS support is explicitly less tested upstream than Linux's — the Xemu
project's own words are that it "should be fine" there, not that it's
verified.

## ROMs

Running (not building) needs a MEGA65 ROM image, which Xemu's own wiki does
not treat as a simple download: it calls fetching the official `MEGA65.ROM`
"a legal issue" and leaves getting it "at your own risk." The
[MEGA65/open-roms](https://github.com/MEGA65/open-roms) project is a
from-scratch, GPLv3 replacement built specifically to sidestep that — prefer
it unless you have a specific reason to want the original. Either way, Xemu's
[Mega65 emulation how to
start](https://github.com/lgblgblgb/xemu/wiki/Mega65-emulation-how-to-start)
covers the SD-card image setup this project has not automated.

## Verify

```bash
xmega65 -h
```

should print its usage. `8bs doctor` checks that `xmega65` exists on `PATH`;
unlike the packaged emulators, it doesn't check a version.

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
