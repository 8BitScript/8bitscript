---
"@8bitscript/cli": patch
---

`8bs run pet` launches on the keyboard when a controller profile is recorded.

The PET has no control ports (`input.joysticks: 0`), and xpet's only joystick
flags are for a userport adapter the catalog does not fit. A mapped pad used
to fail the whole launch — which made every PET program unplayable once a
gamepad had been recorded for another machine. The adapter now matches web:
no flags, a note that the pad was not attached, and the keyboard still runs.

Where the line is drawn: a profile a machine cannot honour *as flags* is a
note when the machine has no control ports at all, because the point of
naming a refusal is that somebody reads it, and nobody reads a line that
scrolled past while an emulator was starting. A port that exists and is
fitted with nothing is still a refusal — that profile asked for hardware
the catalog does not fit, and `--hardware port1=joystick` is the fix.
