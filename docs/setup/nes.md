---
title: NES
nav_order: 6
---

# NES

[FCEUX](https://fceux.com) is the emulator 8BitScript targets for the NES —
`8bs build --target nes` links against llvm-mos's `nes-nrom` platform (see
[LLVM-MOS](llvm-mos.md)), the plainest NES cartridge shape: 32K of program
ROM, 8K of character ROM, no bank switching.

## macOS

```bash
brew install fceux
```

## Linux

On Debian and Ubuntu:

```bash
sudo apt update
sudo apt install fceux
```

On Arch and Manjaro:

```bash
sudo pacman -S fceux
```

Or, on any Linux with Linuxbrew:

```bash
brew install fceux
```

## Verify

```bash
fceux --version
```

`8bs doctor` checks that `fceux` exists on `PATH`.

## Run

```bash
8bs run nes
```

FCEUX takes the built `.nes` as a plain positional argument — there is no
NTSC/PAL split to pick, the way there is for the Commodore and Atari
targets: this project's NES support only targets NTSC timing so far (see the
comment on `FRAME_SYNC.nes` in `packages/backend-6502`).

Two things about the picture are the NES, not a bug. There is no border
register on this machine — the PPU's 256×240 picture fills the frame edge
to edge — so the coloured frame `examples/borders` shows is *drawn*: a ring
of solid tiles that `@8bitscript/nes` lays around the screen, coloured by
`border`. And FCEUX's default NTSC view hides the top and bottom 8 lines,
the way a television's overscan does, which is why that ring is two tiles
thick: the outer row is off screen, the inner one is what you see. The
text is the package's own CHR-ROM character set
(`packages/nes/native/6502/font.s`) — the NES has no character ROM of its
own to fall back on.

## Next

[Commander X16](cx16.md).
