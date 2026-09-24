---
title: atari800
nav_order: 22
---

# atari800

The Atari 8-bit family (400/800/XL/XE/XEGS) runs in `atari800`.

```
brew install atari800
sudo apt-get install -y atari800
```

Arch does not package `atari800` in the official repos. On Manjaro:

```
pamac build atari800
```

On Arch, `yay -S atari800` or `paru -S atari800`.

atari800 needs the Atari OS ROMs. Doctor reports the binary; it does not
vendor those ROMs. `--screenshot` on this target captures the real
window and needs macOS Screen Recording permission — there is no
scriptable still-frame flag.
