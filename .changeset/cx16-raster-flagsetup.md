---
"@8bitscript/compiler": patch
---

`FLAG`-synced machines (today: the X16) get the same `keepsInterrupts` exception `RASTER`-synced ones already had for the Atari 8-bit: a machine whose own raster driver needs interrupts left on can now say so without its frame-pacing setup (`flagSetup`) turning them back off first. Nothing sets it yet — a VERA line-IRQ raster driver for the X16 was attempted and reverted (`packages/cx16/AGENTS.md` records the specific, unexplained crash it hit under x16emu); this is the one line a future attempt needs to flip, not a behavior change for any program today.
