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
workspace's projects and from the proofs of concept, and *Launch Studio*
builds and runs this package on a system of your choosing.

## What exists today

Do not describe more than this as working:

- `src/studio.8bs` draws the front door: title, version, the tier this
  machine gets, and which editors that tier opens — using `@8bitscript/
  screen` and `@8bitscript/text`, nothing else. It builds and runs on all
  nine targets; `8bs run <target> --screenshot` shows it.
- `src/main.8bs` is the one entry for every machine. It reads the
  machine's facts from `@8bitscript/system` — `Input.KEYBOARD`,
  `Video.SPRITES`, each a `#fact(...)` the compiler folds from the
  build's hardware — and hands `studio.start()` the tier: the viewer tier
  where there is no keyboard (the NES, and the web until its runtime
  reads keys), the basic tier where there are no hardware sprites (the
  VIC-20, the PET), the full tier everywhere else. The other tiers'
  branches fold away on any one build (`test/studio.test.mjs` reads the
  tier off the linked IR for each target, linking with each machine's
  stock facts). There used to be a `main.<target>.8bs` per lower
  tier; the filename rule is still the right tool for a machine that
  needs *different code*, but a machine that only needs a different
  *number* gets it from one file now.
- Nothing responds to a key, plays a note, or reads or writes a file. The
  language has no capability for any of those yet. The screen says
  `NO INPUT YET` for that reason.

## Tiers

The reference machine is the **Commander X16**. It has the most room —
2 MB of banked RAM, VERA's 128 sprites, three sound engines
([roadmap](../../docs/roadmap.md#phase-4-the-super-6502-machines)) — and a
keyboard and storage out of the box, so the full editor is designed there
and everything else is a subset of it. Every other machine runs *the same
program* at the tier its hardware supports:

| Tier | Machines | Characters | Sprites | Music | Files |
| --- | --- | --- | --- | --- | --- |
| Full | cx16, mega65, c128, c64, atari8, web | edit | edit | edit | load, save |
| Basic | vic20, pet | edit | view | play | load, save |
| Viewer | nes | view | view | view | none |

This table is a proposal, not a measurement. The reasoning, and what each
row still has to prove:

- **Full** is every machine with hardware sprites and a programmable
  sound chip: VIC-II + SID, ANTIC/GTIA + POKEY, VERA + its engines, and
  the browser, which is the *host* of Studio's fancier version and can do
  anything. "Sized to the machine" is the part to design: a C64 editor
  and an X16 editor share code, not screen layouts.
- **Basic** is the two machines without hardware sprites. The VIC-20's
  constraint is RAM (a little over 5K unexpanded — the profile chosen at
  build time decides how much Studio may use). The PET's constraint is
  sound: it has no sound chip. Its one voice is the 6522 VIA's shift
  register free-running onto the CB2 line (`$E84B`, `$E84A`, `$E848`) — a
  square wave with a pitch and a duty cycle, no volume, heard through the
  built-in piezo on the CRTC boards only (see
  [`packages/pet/AGENTS.md`](../pet/AGENTS.md)); enough for "rudimentary
  playback" and no more.
  Character editing is native to both: their character cells are the
  whole display.
- **Viewer** is the NES: no keyboard on the stock console, and on the
  cartridge profile this repository builds today, nowhere to save. That is
  a property of the profile, not the machine — battery-backed SRAM boards
  exist ([`packages/nes/AGENTS.md`](../nes/AGENTS.md)) — so a later
  profile may lift the NES to Basic. Viewing is still worth having: it is
  how you check an asset on the hardware it is for.

Two rules follow from the table and must survive any redesign:

1. **The tier gates the editors, not the formats.** A file is never tied
   to the tier that made it. Whatever a PET saves, an X16 opens and edits;
   whatever an X16 saves, a PET at least views, if the asset is one the
   PET can show at all. This is what "higher-tier systems edit files from
   lower-tier systems" means in practice, and it is what makes one format
   per asset kind the right number.
2. **A tier is a property of the build, chosen once, in `main.8bs`.**
   Studio never probes the machine at runtime to decide what it can do;
   the build already knows which machine it is for, and `main.8bs` picks
   the tier from the machine's facts (`Input.KEYBOARD`, `Video.SPRITES`
   — see [`docs/systems.md`](../../docs/systems.md#facts-what-a-build-knows-about-itself)),
   never from its name, so a new machine with a keyboard and sprites
   gets the full tier without anyone editing Studio. Keep the tier a
   compile-time constant (`Tier.FULL` and the others are namespace
   consts, inlined by the compiler; so is every fact).

## What Studio needs from the language

Each editor waits on a capability the language does not have. They are
listed here so the order of work is visible, and so nobody builds an
editor on a hack that the capability would replace:

- **Input** — a keyboard on the computers, a joypad on the NES, the
  browser's keyboard on the web — as a capability package like
  `@8bitscript/screen`: one API, each machine's implementation behind it.
  Nothing in Studio can be interactive before this exists. The PET has
  the hardware layer such a package would sit on (`@8bitscript/pet/keyboard`
  scans the matrix once a frame, `@8bitscript/pet/keys` names the keys per
  profile; see `packages/pet/AGENTS.md`), and so does the C64
  (`@8bitscript/c64/keyboard` + `/keys` for the matrix, `/joystick` for
  the two control ports; see `packages/c64/AGENTS.md`); importing either
  directly makes a program that machine's only, which Studio's shared
  code must not be.
- **Character and sprite access** — reading and writing the character
  set and, where the machine has them, sprite definitions and positions,
  through the intent-level API the root `AGENTS.md` insists on
  (`sprites.place(...)`, not a VIC-II register). The C64 has its hardware
  layer for this too: `@8bitscript/c64/sprites` (eight sprites, shapes in
  blocks the package owns) and `@8bitscript/c64/video` (the character
  set's RAM copy, the screen, colour RAM) — C64-only, the layer the
  capability sits on, not the capability.
- **Sound** — a note-level API for the machines with a chip, and the
  PET's one voice behind the same API. `@8bitscript/c64/sid` is the C64's
  hardware layer for it: three voices, waveforms, envelopes, the filter,
  and a PAL note table (see `packages/c64/AGENTS.md` for the NTSC caveat).
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
  same command. **Launch App…** and **Launch Proof of Concept…** do the
  same for any app and for the repository's proofs of concept.
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
