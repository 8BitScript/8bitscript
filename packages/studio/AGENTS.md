# Writing 8BitScript Studio

This file is for anyone — human or agent — touching `packages/studio`, the
`8bitscript.app` field in a package manifest, or the editor's Launch Studio
command. Read the root [`AGENTS.md`](../../AGENTS.md) first; its rules apply
here without exception, and one of them matters more than usual: **verify
hardware facts before writing them down.** Studio is a program *about*
hardware, so this file marks every hardware claim it has not checked as
*to verify*.

## What Studio is

Studio is the asset editor that ships with the toolchain and runs on the
machines themselves: a character editor, a sprite editor, a music tracker,
and the file handling that lets what you make there come back to the
project you are writing. It is an ordinary 8BitScript program, written in
`.8bs`, built by the same compiler and run by the same `8bs run <target>`
as anything else. It is not a separate product: `@8bitscript/cli` depends
on `@8bitscript/studio`, so installing the toolchain installs Studio, and
**Studio's version is the library's version** — the workspace has one
version and Studio's `package.json` carries it, checked by
`test/studio.test.mjs` against the literal `src/studio.8bs` prints.

Studio is the first of the **apps**: programs that ship with the toolchain
rather than being written against it. An app is any package whose
`package.json` carries an `8bitscript.app` field and an `8bitscript.config.ts` —
see [the package model](../../docs/packages.md#apps). The VS Code
extension lists apps in a section of their own, separate from the
workspace's projects and from the examples, and *Launch Studio*
builds and runs this package on a system of your choosing.

## What exists today

Do not describe more than this as working:

- **The desk.** `src/studio.8bs` draws a menu bar across the top row and
  a screen under it, and reads the machine's input to work them. The
  bar is `@8bitscript/ui/menubar` — the mark, FILE, and the three
  editors, each its own item where the row has room (long names from 40
  columns, `CHR SPR MUS` on the NES's 28) and one EDIT item on the
  VIC-20's 22 that lists the three. The menus are
  `@8bitscript/ui/menu`, the drop-down that arrived with this: the mark
  opens ABOUT; FILE opens LOAD and SAVE where the machine has storage
  and the tier edits, and QUIT everywhere; each editor's menu opens VIEW
  (PLAY, for music on a machine with a voice) and, where the tier and
  the hardware allow, EDIT. Every entry is conditional on a fact, which
  is why an entry's action is found by asking `menu.item()` whether it
  is the lit one while the user confirms (`pick()`), never by counting.
- **The policy is in one place**, `start()`'s loop, the way
  `packages/ui/AGENTS.md` asks: neither component reads input. Left and
  right walk the bar; confirm opens the lit item's menu (the first
  item's, from nothing) with its first entry lit; up and down walk the
  menu; left and right with a menu open close it and open the
  neighbour's; confirm takes the entry; cancel closes the menu and
  leaves the bar lit, or lets the bar go when no menu is open. A mouse
  does the same by pointing and clicking — a click on the bar opens
  that item's menu or closes it if it was the open one, a click on an
  entry takes it, a click anywhere else closes and lets go — and
  hovering an open menu lights the entry under the arrow. Every control
  is edge-triggered, so the loop polls once a frame and never twice.
- **Five screens, each honest about what is behind it.** The front door
  is what it was: title, version, tier, one line per editor, what is
  driving the bar (`INPUT KEYS MOUSE` on a build fitted with one). The
  characters screen draws the portable character set — the one thing a
  viewer can already show on the machine it is for — and says `GLYPHS
  256` or `FONT IN ROM` from `Video.GLYPHS`. Sprites prints how many,
  how many per line, and the size, from the facts; music the voices and
  whether the chip has noise, envelopes and a filter; files the storage
  in KiB. A screen opened by EDIT ends `EDIT: NOT BUILT YET`; music ends
  `PLAY: NOT BUILT YET`; files `LOAD: NOT BUILT YET` — because nothing
  edits, plays or loads, and a screen that implied otherwise would be
  the wrong screen.
- **Every screen prints through `line()`**, one global cursor and one
  string per call, because a `text.print(cell, ...)` with its own
  16-bit cell and a `cell = cell + ROW` after it cost ~30 bytes a line:
  the five screens were 1539 bytes of a 32K PET's Studio written that
  way and 864 written this way (2026-09-20). See the root `AGENTS.md`'s
  second rule.
- **Taking an entry closes the menu, lets the bar go, and redraws the
  screen**; `drawView()` blanks everything under the bar first, which is
  also how a closed menu comes off the screen. On the NES that blank is
  a few frames of the vertical-blank queue; nowhere else does it show.
  On the C64 and C128 the bar is redrawn after raster line 58, as
  before (Studio, 2026-09-07), so the rewrite never lands while VIC-II is
  scanning it.
- **The pointer is visible**, on a build that has one to draw: a VIC
  sprite on a C64 or C128 fitted with a 1351, the KERNAL's own arrow on
  the X16, parked at the center until it is moved. `pointer.begin()`
  goes after `input.begin()` and `pointer.update()` right after
  `input.poll()`, once each a frame — the contract between the two
  packages. On the other six `pointer.DRAWS` is false and the calls are
  deleted; see [`packages/pointer/AGENTS.md`](../pointer/AGENTS.md).
- **Studio fits its own mouse** — `port1: mouse1351` on the C64 and the
  C128 in `8bs.config.ts`, and the X16 needs no flag because
  `input.mouse` is on its stock sheet — and names the X16 as its
  `baseline` and a mouse as its `input.primary`, so `8bs run` alone
  starts it on the X16, `8bs build --release` measures every other
  machine's Studio against it, and `8bs targets --reach` says where a
  mouse is standard, optional or absent.
- **Nothing plays a note or reads or writes a file.** There is still no
  sound or storage capability, and the screens say so.

### Measured, 2026-09-20, native backend, `8bs build --release`

| build | program | RAM |
| --- | --- | --- |
| X16 (the baseline) | 5987 | 184 |
| C64 with a 1351 | 6536 | 115 |
| C64 with a joystick | 5407 | 98 |
| C128 with a 1351 | 6036 | 113 |
| C128 with a joystick | 5121 | 101 |
| MEGA65 | 4947 | 101 |
| Atari 8-bit (800XL) | 4975 | 105 |
| VIC-20 with 8K | 4598 | 101 |
| PET 4032, 32K | 4489 | 99 |
| NES (NROM, fixed) | 40976 | 121 |

The mouse and the click handling cost the C64 **1129 bytes of program
and 17 of RAM**, the C128 **915 and 12**. The biggest single pieces on
the X16 are `drawView` (812, the five screens), the loop `studio_start`
(727), `menubar_item` (425), `menu_item` (296) and `drawMenu` (222). A
stock VIC-20 (3583 bytes) and a 4K PET (3071) cannot hold the desk —
`8bs build` says by how many bytes, and `test/studio.test.mjs` holds it
to saying so — which is why Studio's defaults for those two machines are
the 8K VIC-20 and the 32K 4032. Not a `requires` floor: `memory.ram`
would refuse the NES, whose code is in ROM and whose 1536 bytes of RAM
hold the desk's variables with room to spare.

`test/studio.test.mjs` builds Studio for every machine from its own
directory, and drives the web build headlessly — key edges written into
the host's input byte a frame at a time, the screen read back from
character and color RAM — through opening a menu, taking CHARACTERS ›
VIEW, cancelling, walking from one open menu to the next, and QUIT
returning from the program. Linking IR had let every 6502 build fail
unnoticed since the native backend landed (a 2-byte array store it
refused until #223); building is the test now.

## Tiers

The reference machine is the **Commander X16**. It has the most room —
2 MB of banked RAM, VERA's 128 sprites, three sound engines
([roadmap](../../docs/roadmap.md#phase-4-the-super-6502-machines)) — and a
keyboard and storage out of the box, so the full editor is designed there
and everything else is a subset of it. Every other machine runs *the same
program* at the tier its hardware supports:

| Tier | Machines | Characters | Sprites | Music | Files |
| --- | --- | --- | --- | --- | --- |
| Full | cx16, mega65, c128, c64, atari8 | edit | edit | edit | load, save |
| Basic | vic20 with 8K or more | edit | view | edit | load, save |
| Viewer | pet (8K and up), vic20 with 3K, nes, web | view | view | play¹ | load² |

¹ where the machine has a voice at all: the PET's one square wave and the
NES's APU play, the web (no sound yet) only views. ² where the machine has
storage: every PET and every VIC-20 loads, the NES on a plain cartridge
and the web have nowhere to load from.

A stock VIC-20 and a 4K PET are below the table: the tier rule would make
them viewers, and the desk does not fit in 3583 or 3071 bytes (measured
above). Their row returns when the desk is smaller or a string table
exists; until then `8bs build` refuses them with the byte count.

The rule that produces the table, in `src/main.8bs`, is two questions.

**Can this build edit at all?** It needs `Input.KEYBOARD` — the NES has
none; the web now reads keys but still has nothing to edit — and `Memory.RAM >=
EDIT_BYTES`, the RAM an editor, its buffers and a playback routine that
keeps running while you edit have to share. `EDIT_BYTES` is 8192 today.
**It is a budget, not a measurement** — nothing behind the front door is
built — and it is one named const so that measuring it later is one edit.
The line it draws: an unexpanded VIC-20 (3583 bytes) and one with the 3K
expansion (6655) are read-only; 8K (11775) and up edit. Studio is an audio
program as much as an editor, and that does not fit in 3.5K.

**Then how much has anything to edit?** One fact per editor: a character
set the program can redefine (`Video.GLYPHS`), hardware sprites
(`Video.SPRITES`), and more than one voice (`Audio.VOICES`) — one
fixed-volume voice plays a tune but does not compose one. All three is
**full**; some of them is **basic**; none of them is a **viewer with a
keyboard**, which is every PET.

What each row means, and what it still has to prove:

- **Full** is every machine with hardware sprites, a redefinable character
  set and a real sound chip: VIC-II + SID, ANTIC/GTIA + POKEY, VERA + its
  engines. "Sized to the machine" is the part to design: a C64 editor and
  an X16 editor share code, not screen layouts.
- **Basic** is the expanded VIC-20: 256 redefinable glyphs and the VIC's
  four voices, and no hardware sprites, so the sprite editor stays a
  viewer while the other two edit. Which VIC-20 a build is for is chosen
  at build time — `8bs build vic20 --profile 8k`, or `targets.vic20.hardware`
  in a project's `8bitscript.config.ts` — and the fact sheet the tier is read
  from follows it. This is the one place where fitting hardware changes
  what Studio *is*, and it is worth keeping true as more expandable
  machines arrive.
- **Viewer** is read-only: view, play, load, never edit or save. Four
  machines land there for three different reasons, and the reasons matter
  because only one of them can be bought away:
  - the **NES** has no keyboard to edit with. On the cartridge profile
    this repository builds there is also nowhere to save, though
    battery-backed SRAM boards exist
    ([`packages/nes/AGENTS.md`](../nes/AGENTS.md)). The **web** now reads
    keys, and is a viewer because it has no glyphs, sprites or voices to
    edit, not because of the keyboard.
  - the **stock VIC-20** has the keyboard and not the room. **A RAM
    expansion lifts it**, and that is the whole of what an expansion can do
    for Studio today.
  - the **PET** has the keyboard and, on a 3032 or 8032, 31743 bytes —
    more than the 8K VIC-20 that edits. It is a viewer because of what the
    machine *is*: its 128 glyphs are in a character ROM the program cannot
    redefine (`video.glyphs` 0 — see [`packages/pet/AGENTS.md`](../pet/AGENTS.md)),
    it has no sprites, and its one voice is the 6522 VIA's shift register
    free-running onto the CB2 line (`$E84B`, `$E84A`, `$E848`) — a square
    wave with a pitch and a duty cycle, no volume, heard through the
    built-in piezo on the CRTC boards only. So **no expansion lifts the
    PET**: RAM is not its gate. A hi-res board (`petdww`, `pethre`) or a
    SID cartridge would be, and neither is in the catalog or has a driver;
    a machine that grew either would want new facts, not a new tier rule.

  Viewing is still worth having, and it is most of what Studio is for on
  these machines: it is how you check an asset on the hardware it is for,
  and a PET or VIC-20 loading and playing what an X16 saved is the round
  trip working.

One limit on "an expansion lifts the machine", and it is the fact sheet's
own rule: **only hardware settled at build time can move a tier.** The
VIC-20's `ram` option is, so it does. A REU, an MMU bank, VERA's banks are
`run` facts — the const means "this build may use it", and whether it is
really plugged in is the capability's answer at run time (see
[`docs/systems.md`](../../docs/systems.md#facts-what-a-build-knows-about-itself))
— so they can never pick the tier, which is one compile-time constant by
rule 2 below. A machine that wanted its editors to appear only when a
detected expansion is found would be asking for something else: an editor
built in that refuses to open, not a different tier. Nothing needs that
today, and the machines it would apply to (the C64, the C128, the X16) are
already full.

Two rules follow from the table and must survive any redesign:

1. **The tier gates the editors, not the formats.** A file is never tied
   to the tier that made it. Whatever an X16 saves, a PET at least views,
   if the asset is one the PET can show at all — and since the viewer tier
   still loads wherever there is storage, that round trip is the point of
   the tier, not a consolation. This is what "higher-tier systems edit
   files from lower-tier systems" means in practice, and it is what makes
   one format per asset kind the right number.
2. **A tier is a property of the build, chosen once, in `main.8bs`.**
   Studio never probes the machine at runtime to decide what it can do;
   the build already knows which machine it is for, and `main.8bs` picks
   the tier from the machine's facts (`Input.KEYBOARD`, `Memory.RAM`,
   `Video.GLYPHS`, `Video.SPRITES`, `Audio.VOICES`
   — see [`docs/systems.md`](../../docs/systems.md#facts-what-a-build-knows-about-itself)),
   never from its name, so a new machine with a keyboard, room and
   something to edit gets the full tier without anyone editing Studio,
   and a machine fitted with more RAM gets what that RAM buys it. Keep the tier a
   compile-time constant (`Tier.FULL` and the others are namespace
   consts, inlined by the compiler; so is every fact).

## What Studio needs from the language

Each editor waits on a capability the language does not have. They are
listed here so the order of work is visible, and so nobody builds an
editor on a hack that the capability would replace:

- **Input** — **done**, as `@8bitscript/input`: four directions, confirm,
  cancel and a pointer, all edge-triggered, resolving per target to that
  machine's own layer the way `@8bitscript/screen` does. Studio's menu bar
  moves under it. What is still missing is per-machine rather than
  structural, and `packages/input/AGENTS.md` lists it: the **X16** reads
  its mouse, keyboard joystick and SNES pads (KERNAL `$FF56` joystick_get;
  GETIN as characters is still unread), the **web** reads arrows, Enter and Escape (no
  pointer yet), the **VIC-20** has a joystick but no verified key matrix,
  and the three machines with an **ALT** key — C128, MEGA65, X16 — do
  not read it, which is what `ALT`+letter menu accelerators wait on. A
  text *editor* will also want more than this surface offers: typed
  characters, not directions.
- **Character and sprite access** — reading and writing the character
  set and, where the machine has them, sprite definitions and positions,
  through the intent-level API the root `AGENTS.md` insists on
  (`sprites.place(...)`, not a VIC-II register). The C64 has its hardware
  layer for this too: `@8bitscript/c64/sprites` (eight sprites, shapes in
  blocks the package owns), `@8bitscript/c64/charset` (glyphs redefined
  in the character set's RAM copy), `@8bitscript/c64/bitmap` (320×200 or
  160×200 pixels), `@8bitscript/c64/scroll` and `@8bitscript/c64/raster`
  (register writes at raster lines: a status bar under a scrolling
  playfield), with `@8bitscript/c64/multiplex` (more than eight sprites
  through that list), `@8bitscript/c64/border` (the vertical border
  opened for sprites) and `@8bitscript/c64/idle` (the idle-graphics
  byte) on top of it, over `@8bitscript/c64/video` (the screen, color
  RAM, the bank's layout) — C64-only, the layer the capability sits on,
  not the capability.
- **Sound** — a note-level API for the machines with a chip, and the
  PET's one voice behind the same API. `@8bitscript/c64/sid` is the C64's
  hardware layer for it: three voices, waveforms, envelopes, the filter,
  and a note table per region, chosen at run time by `sid.detectRegion()`
  (see `packages/c64/AGENTS.md`).
- **Storage** — loading and saving a file from Studio, and getting it
  from the emulator back into the repository. This is the piece that
  makes "Launch in Studio" possible and it is the least designed: each
  emulator has its own route to the host filesystem (checked against each
  emulator's own help: VICE mounts a host directory as drive 8 with
  `-fs8 <dir>` and attaches images with `-8`; atari800 mounts one as `H1:`
  with `-H1 <dir>`; x16emu has `-fsroot <dir>` and `-sdcard <image>`;
  xemu mounts a `.d81` with `-8` and redirects the hypervisor's DOS to a
  directory with `-hdosdir`; the NES has only the emulator's `.sav`; the
  web runtime can hand the browser a file — see
  [`docs/systems.md`](../../docs/systems.md#storage)), and the CLI would
  have to drive each. Persistence is a capability of a machine's media profile,
  never assumed from its name.

## Files: a proposal

Studio's assets should be **8BitScript source**: a saved sprite is a
`.8bs` module exporting a `const` array, which the project imports like
any other module and the compiler places as read-only data. That gives
"embed the files in the repo" for free — they are source files, diffed and
reviewed like source — and it gives every target the same format, since
the compiler already knows how to place a `const` array on all of them.
Nothing about this is implemented; it is written down so the storage
capability is designed toward it.

## Launching

- `8bs run <target>` in this directory, or `pnpm start` (the X16) and
  `pnpm run start:<target>`. Studio does not depend on `@8bitscript/cli`
  itself — the CLI depends on Studio, and a dependency both ways is a cycle
  pnpm refuses — so the `8bs` those scripts run is the workspace root's.
  Output lands in this package's `dist/`; for
  an installed copy that is inside `node_modules`, which is acceptable
  for now and should move to the launching project's `dist/` once the
  CLI can be told where to build. An installed copy also has no
  `node_modules` of its own (pnpm keeps its dependencies in the store),
  so the extension's *not installed* check will flag it and offer an
  Install that would run inside `node_modules` — unverified until a
  package is published to test against, and to be fixed then by treating
  an app as installed when its toolchain is.
- The VS Code extension's **Launch Studio** (command palette, or the
  rocket in the Projects view's title) asks which system, then runs the
  same command. **Launch App…** and **Launch Example…** do the
  same for any app and for the repository's examples.
- **Launch in Studio** — opening a project's asset file in the editor — is
  not implemented and cannot be until storage exists; see above.

## Changing Studio

Studio is a program, so the root `AGENTS.md`'s checklist for core changes
does not apply to it — but its own rules do:

- Keep `src/studio.8bs` buildable on all nine targets; the test links
  every one. A tier that a machine cannot build is a bug, not a
  limitation.
- Keep every string on the portable character set the checker enforces,
  and every line under 22 columns — the VIC-20's grid — or lay it out per
  `text.COLUMNS`.
- Keep the version literal in step with `package.json`; the test fails
  otherwise.
- When a capability arrives, update the table above from "proposal" to
  what was measured on each machine, in the same commit.
