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
`package.json` carries an `8bitscript.app` field and an `8bs.config.ts` —
see [the package model](../../docs/packages.md#apps). The VS Code
extension lists apps in a section of their own, separate from the
workspace's projects and from the examples, and *Launch Studio*
builds and runs this package on a system of your choosing.

## What exists today

Do not describe more than this as working:

- `src/studio.8bs` draws the front door: a menu bar across the top row,
  then the title, version, the tier this machine gets, and which editors
  that tier opens — using `@8bitscript/screen`, `@8bitscript/text` and
  `@8bitscript/ui`, nothing else. It builds and runs on all nine targets;
  `8bs run <target> --screenshot` shows it.
- The menu bar is `@8bitscript/ui/menubar`, the first component Studio takes
  from the shared library rather than drawing itself (see
  [`packages/ui/AGENTS.md`](../ui/AGENTS.md)). It names the four editors,
  and `drawMenu()` picks the long names or three-letter ones from
  `text.COLUMNS`, a compile-time constant — the long set is 35 cells with
  its padding, so a 40-column machine and wider gets `CHARACTERS SPRITES
  MUSIC FILES` and the VIC-20's 22 and the NES's 28 get `CHR SPR MUS FIL`,
  with the other branch costing nothing on either. **Selecting an item
  still opens nothing**: the highlight moves under the keys, a stick and a
  mouse, and `menubar.item()` returns whether an item is highlighted, but
  no menu drops down, because there is nothing behind one yet. The bar
  costs Studio 423 bytes on a C64, 396 on a
  VIC-20 and 360 on an NES — against 446 bytes for a whole C64 program that
  just prints four labels and does none of what it does — measured for every machine, and
  tabulated with where they go in
  [`packages/ui/AGENTS.md`](../ui/AGENTS.md#what-it-costs). Note the
  ordering in `start()`: the bar is drawn *before* `text.setColor`, because
  drawing a bar leaves the text colour set to the bar's own.
- `src/main.8bs` is the one entry for every machine. It reads the
  machine's facts from `@8bitscript/system` — `Input.KEYBOARD`,
  `Memory.RAM`, `Video.GLYPHS`, `Video.SPRITES`, `Audio.VOICES`, each a
  `#fact(...)` the compiler folds from the build's hardware — and hands
  `studio.start()` the tier. Two questions, in that order: can this build
  edit at all (a keyboard, and `EDIT_BYTES` of RAM to hold an editor), and
  then how much of it has anything to edit. The other tiers' branches fold
  away on any one build — `test/studio.test.mjs` reads the tier off the
  linked IR for each target, and the generated C for a PET is literally
  `if ((1 && (31743 >= 8192))) { if ((((0 > 0) && (0 > 0)) && (1 > 1)))
  ... }`, which clang folds to `tier = 0`. There used to be a
  `main.<target>.8bs` per lower tier; the filename rule is still the right
  tool for a machine that needs *different code*, but a machine that only
  needs a different *number* gets it from one file now.
- `src/studio.8bs` prints each editor's row from the tier *and* the fact
  behind that editor, so a viewer is read-only rather than featureless: it
  still views a character set and a sprite, plays a tune where there is a
  voice, and loads a file where there is storage.
- **The menu bar responds to input**; nothing else does. `@8bitscript/input`
  landed, so left and right step the highlight between the icon and FILE on
  every machine that can answer, and the screen says which — `INPUT KEYS`
  on the computers (the X16 included: it has a keyboard, even though the
  layer does not read keys yet), `INPUT PAD` on the NES, `INPUT NONE` on
  the web, whose runtime does not deliver input yet and says so. On the
  X16 the bar moves under the KERNAL mouse. Nothing plays a note or reads
  or writes a file: there is still no sound or storage capability.
- **The pointer is visible**, on a build that has one to draw:
  `@8bitscript/pointer` arrived alongside this, and on a C64 or C128
  fitted with a 1351 Studio draws a real arrow with one of the VIC's
  sprites, moving a pixel at a time; on the X16 the KERNAL draws its own
  arrow (VERA sprite 0), parked at the centre until it is moved.
  `pointer.begin()` goes after `input.begin()` and `pointer.update()`
  right after `input.poll()`, once each a frame — that ordering is the
  contract between the two packages, and a program that polls without
  updating gets an arrow that never moves. On the other six machines
  `pointer.DRAWS` is false, the calls are empty, and the whole thing is
  deleted; see [`packages/pointer/AGENTS.md`](../pointer/AGENTS.md) for
  why each of them draws nothing yet, and `examples/pointer` for the
  same program without the rest of Studio around it.
- **A click on the bar selects the item under the pointer**, on the builds
  fitted with a mouse. `menubar` hit-tests during a *run* of the bar and
  answers `pointed()` from that run, so `start()`'s loop calls
  `menubar.point()` and redraws whenever the pointer changes cell — a
  click can only land on the right item if the bar has run since the
  pointer last moved. Clicking the bar's padding, or anywhere off it,
  deselects: the same thing RUN/STOP means. `input.pointer()` is a
  constant false on a build without a mouse, so the whole block is proved
  dead and deleted — a C64 Studio with `--hardware port1=none` is 1523
  bytes, byte for byte what it was before any of this was written.
- **Studio fits its own mouse**, which is why `8bs run c64`,
  `8bs run c128` and `8bs run cx16` start it with one and no flags.
  `8bs.config.ts` uses the object form of `targets` and asks for
  `port1: mouse1351` on the C64 and the C128 — the two Commodores whose
  input layer has a pointer — and lists the X16 with no hardware of its
  own, because `input.mouse` is already true on the stock sheet.
  `#fact(input.mouse)` is true for those builds and the pointer half of
  the layer is compiled in at all. It is the project's *stock* for the
  machine: it sits under any profile and under `--hardware`, so taking
  the 1351 out on the command line still works. The editor's Launch
  Studio picker offers each Commodore as a mouse arrangement and a
  joystick one. Cost on a C64: 1523 bytes stock, 2038 with the mouse and
  the click handling (1824 of that is the driver the input layer compiles
  in; 214 is Studio using it). Cost on a C128: 1436 bytes stock, 2195
  with the mouse and the arrow — **759 bytes of program and 12 of RAM**,
  measured 2026-09-07. Cost on the X16: 1253 bytes without the pointer
  layer, 1571 with it — **318 bytes of program and 5 of RAM**, measured
  2026-09-07 by building Studio with the layer taken out.

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
| Viewer | pet, vic20 stock and 3K, nes, web | view | view | play¹ | load² |

¹ where the machine has a voice at all: the PET's one square wave and the
NES's APU play, the web (no sound yet) only views. ² where the machine has
storage: every PET and every VIC-20 loads, the NES on a plain cartridge
and the web have nowhere to load from.

The rule that produces the table, in `src/main.8bs`, is two questions.

**Can this build edit at all?** It needs `Input.KEYBOARD` — the NES has
none, and the web's runtime does not read one yet — and `Memory.RAM >=
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
  in a project's `8bs.config.ts` — and the fact sheet the tier is read
  from follows it. This is the one place where fitting hardware changes
  what Studio *is*, and it is worth keeping true as more expandable
  machines arrive.
- **Viewer** is read-only: view, play, load, never edit or save. Four
  machines land there for three different reasons, and the reasons matter
  because only one of them can be bought away:
  - the **NES** and the **web** have no keyboard to edit with. The NES's
    is the stock console; on the cartridge profile this repository builds
    there is also nowhere to save, though battery-backed SRAM boards exist
    ([`packages/nes/AGENTS.md`](../nes/AGENTS.md)). The web's is today's
    runtime, not the browser.
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
  its mouse and not yet its keyboard or pads (KERNAL `$FFE4` GETIN and
  `$FF56` joystick_get), the **web** answers nothing (the runtime does
  not listen), the **VIC-20** has a joystick but no verified key matrix,
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
  playfield) over `@8bitscript/c64/video` (the screen, colour RAM, the
  bank's layout) — C64-only, the layer the capability sits on, not the
  capability.
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
