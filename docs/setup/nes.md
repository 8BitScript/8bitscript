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

## Next

[Commander X16](cx16.md).
