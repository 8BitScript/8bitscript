---
title: "Step 1: The main file"
nav_order: 1
---

# Step 1: The main file

The program for this step paints the border blue and the background black,
then stays on the screen. That is all it does, and it is enough to meet
every part of a project: the files and what they are called, the function
the machine starts in, how a value reaches the hardware, and the loop that
every later step will put its work inside.

The project is
[`examples/step1-main-loop`](https://github.com/8BitScript/8bitscript/tree/trunk/examples/step1-main-loop).
It builds for the VIC-20 and the C64 from the same source.

## The files

```
examples/step1-main-loop/
  src/
    main.8bs
  8bs.config.ts
  package.json
  README.md
```

### `package.json`

The project is an ordinary pnpm package. Two things in it matter to the
compiler:

```json
{
  "devDependencies": {
    "@8bitscript/cli": "workspace:*"
  },
  "dependencies": {
    "@8bitscript/screen": "workspace:*"
  }
}
```

`@8bitscript/cli` provides the `8bs` command the scripts call.
`@8bitscript/screen` is the package the program imports the screen from; it
has to be listed here, because an import resolves out of
`node_modules` the same way it would in any npm project, and an import of a
package that is not installed is an error (`8BS2001`), not a guess.
`workspace:*` is only because the packages are not published yet — pnpm
links them out of `packages/` in this repository. Once they are on npm the
version goes there instead, and nothing else changes.

The `scripts` block is the same in every step, and
[the series index](index.md#running-a-step) lists what each one does.

### `8bs.config.ts`

```
export default {
  entry: 'src/main.8bs',
  targets: ['vic20', 'c64'],
};
```

`entry` is the file the program starts from. `8bs build` links that file and
everything it imports into one program. `src/main.8bs` is also what the CLI
assumes when there is no config file at all, so this line only makes the
default explicit; a project that starts somewhere else names that file here.
(If one machine ever needs its own version of a file, it goes beside the
shared one as `main.nes.8bs`, say, and that machine's build uses it without
the config changing — see [the package model](../packages.md#system-specific-files).
This step has no such file.)

`targets` is the list of machines the project is allowed to build for.
`8bs build --target web` in this directory is refused, because `web` is not
in the list — and it is left out on purpose, for a reason the last section of
this page explains. NTSC and PAL are not targets: they are a `--pal` flag on
`8bs build` and `8bs run`, and both regions build the same code today.

### `src/main.8bs`

The program. The file can have any name, since `entry` in the config decides
where the program starts; `main.8bs` is the convention, and the CLI's default.
What has to be called `main` is the function inside it, which the next section
gets to.

## Run it

```bash
cd examples/step1-main-loop
pnpm start
```

VICE opens as a VIC-20, boots to BASIC, types `run`, and the screen turns
blue-bordered and black:

```
+------------------------------------------+   blue border
|  **** cbm basic v2 ****                  |
|  3583 bytes free                         |   black background
|  ready.                                  |
|  run                                     |
|                                          |
|                                          |
+------------------------------------------+
```

The BASIC banner is still there because nothing cleared the screen — clearing
it is a later step. The `run` under `ready.` was typed by VICE's autostart.
The banner is in lower case because the runtime LLVM-MOS ships switches the
character set when it starts up.

`pnpm run start:c64` does the same on a C64. Same colours, same source file,
a different video chip underneath.

## The program

`src/main.8bs`, with its comments stripped:

```
import { screen } from "@8bitscript/screen";

export function main(): void {
    screen.setColors(6, 0);

    while (true) {
    }
}
```

Four parts. In order:

### The import

```
import { screen } from "@8bitscript/screen";
```

Nothing in 8BitScript is in scope until it is declared or imported, and the
compiler itself knows nothing about colours or video chips. `screen` comes
from a package, and the package is what makes this file build for two
machines.

`@8bitscript/screen` has no code of its own. Its `package.json` names a
different entry for each machine — `@8bitscript/vic20/screen` when you build
for the VIC-20, `@8bitscript/c64/screen` for the C64 — and the compiler
follows that at build time. Each of those is a file inside the machine's own
package (`packages/vic20/src/screen.8bs`), built on the registers that
package exports, and both export the same `screen` namespace, so this import
line means the right thing on either machine without a single `if` in the
program. The package is named for what it is — the screen — rather than for
the machine, because a program imports the parts of a machine it uses, one
package each; `@8bitscript/text`, the character grid, is the next one a
program reaches for. [The package model](../packages.md#target-conditional-entries)
describes the mechanism.

### `export function main(): void`

```
export function main(): void {
```

`main` is where the program starts. The 6502 backend turns it into the C
`main` that the LLVM-MOS runtime calls once the machine has been set up, so
the name is not a convention here — a program without a function called
`main` has no entry point.

`export` is what makes the function visible outside its own file. The entry
point is called from outside the program, so it has to be exported. Every
other function in a file is private to that file unless you export it.

`: void` is the return type: `main` returns nothing, because there is nothing
useful to return a value *to* — the section on the loop below says what is
actually waiting when `main` returns.

### Colours go to the screen in one call

```
    screen.setColors(6, 0);
```

`screen` is a namespace exported by the machine's screen module: a name with
functions under it and no storage of its own — `screen.setColors` compiles
to an ordinary function call, nothing more. Border first, then background,
and this is the line where the screen changes.

One call for both colours, because the two machines store them differently
and neither should show through. The VIC-20 packs border and background
into one register (`$900F`: border in the low three bits, background in the
high four), so on it the two arrive together or not at all; the C64 gives
each its own (`$D020` and `$D021`). Calling one function with two values is
the same on both machines; the register-level difference lives inside each
machine's `setColors`, and this program never sees it. (Other machines go
further: the NES has no border register at all and *draws* one, and there
the two colours genuinely are one operation — which is why the portable
surface is a call and not two variables.)

Colours 0–7 have the same numbers on the VIC-20 and the C64: 0 black,
1 white, 2 red, 3 cyan, 4 purple, 5 green, 6 blue, 7 yellow. Both machines
have sixteen colours, but the VIC-20 only has room for eight in its border
field, so its `setColors` masks the border to 0–7; the C64 masks both to
0–15. A value past the mask wraps rather than failing. `@8bitscript/screen`
also exports the names — `BorderColor.Blue`, `BackgroundColor.Black` — and
the next example uses those instead of numbers; here the numbers are the
point, because the next section shows where they end up.

The two parameters are `u8`s: one byte, 0–255. The range check the compiler
has today is on declarations — `let c: utinyint = 300;` reports `8BS1021`
and does not build — but an argument like `screen.setColors(300, 0)` is not
checked yet, because that needs the binder, and the value silently wraps to
44 in the generated C. Keep the literals in range until the checker catches
up.

### `while (true)` — the loop that never ends

```
    while (true) {
    }
}
```

The body is empty, so the processor does nothing but come back around the
loop, forever. The screen is left exactly as the three lines above set it.

This is the shape every program in this series has, and it is the answer to
what a program *is* on one of these machines. There is no operating system
underneath: no window system to hand the screen back to, no scheduler that
runs other programs while this one waits. The program has the whole machine,
and it keeps the machine as long as it keeps running. A game reads the
joystick, moves something, redraws, and does that again sixty times a second
until the power goes off — every one of those is a `while (true)` with the
work inside it. Step 1 is the loop with the work not yet written.

What happens if `main` returns instead? Today, with the runtime LLVM-MOS
ships for these machines, `main` returns into the runtime's `exit`, and
`exit` is a jump to itself:

```
0000102a <exit>:
    102a: 20 20 10     	jsr	$1020 <_fini>
    102d: 4c 2d 10     	jmp	$102d <exit+0x3>
```

So the program stops, the screen stays as it was, and the machine sits in a
loop that is not yours until it is reset. For this step the picture is the
same with or without the `while`; the difference is that with it, the loop
that holds the machine is one you wrote and can put work into. That is worth
being explicit about, for the same reason everything else in the language is:
what happens after `main` is a runtime decision, not a language one (the same
SDK can be linked to return to BASIC instead), and a program that depends on
it depends on something it did not write down.

## What the compiler made of it

`pnpm run build` leaves the generated C next to the `.prg` in `dist/`. The
program's part of `dist/main-vic20-ntsc.c` is:

```
static void __8bs_main(void) {
    screen_setColors(6, 0);
    while (1) {
    }
}
static void screen_setColors(uint8_t border, uint8_t background) {
    vicColor = ((8 | (border & 7)) | (background << 4));
}
int main(void) {
    __8bs_main();
    return 0;
}
```

Line for line the same as the source. `screen.setColors` became the plain
function `screen_setColors` — the namespace is a naming convention the
compiler erases, not a thing that exists at run time. `vicColor` is the
machine package's `@address(0x900F)` register, which became a `#define`
over a `volatile` pointer. The `int main` and its `return 0;` are the C
signature's, not yours: your `main` is called from it.

LLVM-MOS then compiles that C. Disassembling `dist/main-vic20-ntsc.prg.elf`
shows what the VIC-20 actually runs for `main`:

```
00001021 <main>:
    1021: a2 0e        	ldx	#$e
    1023: 8e 0f 90     	stx	$900f
    1026: 4c 26 10     	jmp	$1026 <main+0x5>
```

Three instructions. The call and its two arguments folded into one store of
`$0E` — `8 | (6 & 7) | (0 << 4)` — to the colour register, and the `while`
became a `jmp` to its own address. The C64 build stores `6` to `$D020` and
`0` to `$D021` and ends in the same `jmp`. This is the "generated code is
predictable" principle in the [project overview](../about.md): what you wrote
is what the machine got, and you can always look.

To see the disassembly yourself, with the SDK installed as in
[the setup guide](../setup/llvm-mos.md):

```bash
"$LLVM_MOS_HOME/bin/llvm-objdump" -d dist/main-vic20-ntsc.prg.elf
```

## Try it

Each of these is an edit to `src/main.8bs` followed by `pnpm start` (or
`pnpm run start:c64`).

**Change the colours.** Give `screen.setColors` other values from the 0–7
table above. Then try `screen.setColors(6, 14)`: light blue on the C64, and
light blue on the VIC-20 too, since its background field is four bits wide.
Then try `screen.setColors(14, 0)`: light blue on the C64, but blue on the
VIC-20 — the three-bit border field keeps only `14 & 7`, which is `6`.

**Delete the loop.** Remove the `while (true) { }` and rebuild. The screen
looks exactly the same, for the reason above: `main` returned into the
runtime's own loop. Nothing on the screen tells you the program is over.

**Put work in the loop.** Restore the loop and give it a body:

```
    while (true) {
        color = color + 1;
        screen.setColors(color, 0);
    }
```

with `let color: u8 = 0;` above `main` (there are no local variables yet, so
the counter lives at module scope). The border stops being a colour and
becomes stripes. The loop changes the
border colour several times per scan line — thousands of times per frame —
and the video chip paints whichever colour is current as the beam passes.
That is how fast an empty-looking loop runs, and it is why every later step
that draws something has to decide *when* to draw, not only what.
`examples/borders` is exactly this loop with a delay inside it, so the border
changes twice a second instead; the next step takes that up.

## Why this step does not build for the web

Nothing stops it building — `8bs run web` runs any program, and this
step's `8bs.config.ts` simply lists `vic20` and `c64` and not `web`, so a
web build is refused by the `targets` check, not by anything the compiler
knows about the program. The reason it's left out is what the page would
show: nothing.

On the web the program runs in a worker, exactly as it would run on a real
machine — it owns its thread and can loop forever — and the page plays the
video chip, painting the program's screen memory every display refresh.
That painting is paced by frames: a program tells the page it has finished a
frame's work by calling `waitFrame()`, which blocks until the next logical
frame, the way an 8-bit program waits for vertical blank (cc65 calls it
`waitvsync()`). This step's loop never does — `while (true) {}` neither waits
for a frame nor returns — so the page never gets a first picture to paint,
and the tab stays black while the worker spins. On the VIC-20 and C64 that
same loop is harmless: the video chip paints from screen memory regardless
of what the CPU is doing, which is the whole point of step 1.

`examples/borders` shows the shape that works everywhere — the same loop,
with one line added:

```
    while (true) {
        waitFrame();
        // ...one frame's worth of work...
    }
```

`waitFrame()` runs at the project's configured `frameRate` (default 60) on
every target — on the 6502 machines it waits on the video chip's own raster
(real vertical blank, 60Hz NTSC / 50Hz PAL by construction, drained through
an exact accumulator so the logical rate never drifts — see
`packages/backend-6502`), on the web on the page's frame clock
(`packages/cli/src/web-runtime.mjs`). There is still no PAL/NTSC split for
`web`: nothing about it is tied to a machine's real refresh rate to begin
with, so one build is enough. The next step takes that up.

## Next

Step 2 is not written yet. In the meantime,
[`examples/borders`](https://github.com/8BitScript/8bitscript/tree/trunk/examples/borders)
is this program plus a delay loop and a `volatile` counter, and
[Getting started](../tutorial.md#what-the-program-does) walks through it.
