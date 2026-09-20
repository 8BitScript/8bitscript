---
title: Reach — which machines a program is for
nav_order: 87
---

# Reach: which machines a program is for, and how it gets there

*Research note and design, 2026-09-20. In the voice of
[`baseline.md`](baseline.md) and [`distribution.md`](distribution.md):
every figure is cited to a page that was fetched, anything proposed rather
than observed is marked **PROPOSED**, and nothing here describes the
toolchain doing something it does not do today. The numbers live in
`packages/cli/data/reach.json`, one object per machine with `source` and
`asOf` on every figure, read by `8bs targets --reach`. Written against
`trunk` at `e325f5e`; the sections marked **built** landed in the pull
request that followed the note.*

## The question

`baseline` says which machine a program is designed on and `requires`
says the least a build may have ([`baseline.md`](baseline.md)). The hardware
catalog says what each machine can be fitted with, and `#fact(...)`
folds a program for it. Together they answer *can this program build for
that machine, and what is the build short of.* They do not answer the
question that comes before it:

> **Which machines should this program be for at all — and once it is
> built, how does it get to the people who have one?**

That question has two halves that the toolchain has no data for today:

1. **Who is out there.** How many of each machine were sold, how many
   people are still writing for and playing on it in 2026, and by what
   route — the original hardware with an SD bridge, an emulator, an FPGA
   core, a mini-console, a browser.
2. **What the program asks of them.** Whether it needs a joystick or
   only prefers one; whether it needs 512K of banked RAM or can do
   without; whether it is one file, a disk of files, a tape that loads
   in order, or a cartridge — and which of those each route can carry.

Join the two and a project can say, in numbers rather than by feel,
that a 512K-REU title is a C64 title that also builds for the X16 and
the C128 and is not an NES title in any useful sense; that a joystick
game reaches every VIC-20 and C64 but only the Spectrum owners who
bought a Kempston interface; that a three-file disk program has no tape build and no
cartridge build without a loader it does not have yet. This note is the
data for the first half, the vocabulary for the second, and the shape of
the analysis that joins them — plus the one thing the join makes
concrete: **how many artifacts a release should actually ship.**

## What already exists, so it is not proposed twice

- **The designed-for system, with its specs and accessories, is
  `baseline`.** `baseline: { target: 'c64', hardware: { ram: 'reu512',
  port2: 'joystick' } }` is accepted today
  ([`../config.md`](../config.md#the-baseline)); `8bs run` with no target
  runs it and `8bs build --release` measures every other build against
  it. Nothing below replaces it.
- **"Needs a keyboard, so not the NES" is `requires`.** `requires: {
  'input.keyboard': true }` refuses a build that has none; `'memory.ram':
  8192` is a RAM floor; every `program: true` fact in
  `packages/compiler/src/fold/facts.mjs` can be a floor.
- **What is fitted is the catalog.** `"8bitscript".hardware` in each
  machine package: options, values, presets, what each changes, and
  `detect` for hardware one binary can find at run time
  (`@8bitscript/c64/reu`).
- **Media and deploy are `distribution.md`'s four axes** — machine,
  hardware fitted, media (changes the build: Atari `media=cart8`),
  deploy (moves an artifact: emulators solved by `run.mjs`, physical
  bridges unbuilt). The `images` config block is specified and
  validated; no `.d64`/`.atr` writer exists yet.

What is missing is (a) the per-machine *reach* data, (b) three demands a
program cannot spell today — a preferred rather than required input, a
required peripheral that is not a fact, and a delivery shape — and (c)
the command that joins them and the release rule that follows.

## The word

**Reach**: how many people can run a build, and by which routes. A
number per machine with a date on it, never a property of the program.

The alternatives were turned down for reasons the project already holds:

- **Popularity, market, audience.** Each says the number is about *the
  machine*. Reach is about *the build*: a `.d64` reaches C64 owners with
  an SD2IEC, a `.crt` reaches the ones with a Kung Fu Flash, a `.prg`
  reaches everyone with an emulator, and the same machine has a different
  reach for each. The route is part of the number.
- **Tier / grade / viability score.** Buckets hide facts, the same
  objection `baseline.md` records. A single "portability score" for a
  machine would fold "no joystick shipped in the box" and "no hardware
  sprites" and "sold 219,000 units" into one digit that answers nothing.
  The analysis below prints the facts and the number and leaves the
  ranking to whoever is reading, or to a filter they wrote.
- **Port.** Already rejected; there is no second source.

So a project has a **floor**, a **baseline**, its **builds**, and each
build has a **reach**.

## What a reach sheet is not: a fact

The line the compiler will insist on: **a reach figure never enters
`FACTS`, never folds, and never changes a byte of a build.** Units sold is
not a property of the machine a program runs on the way `video.columns` is;
it is a property of the world in 2026, it changes on a calendar, and a
program that branched on it would be a wrong program. This is the same
`program: false` discipline `video.frameRate` already has, one step further
out: not even the CLI's build path reads it. Only `8bs targets` and the
editor's panel do.

That also settles where it lives. Not in a machine's `package.json` —
the catalog is *hardware*, and seventeen of the twenty-five machines on this
sheet have no package. **Built:** one file, `packages/cli/data/reach.json`,
keyed by machine id (the eight targets' ids, and the roadmap ids the
[machines pages](machines/index.md) will become), each row with a
`status` (`builds`, `roadmap` with its `phase`, `unplanned`) and the
file with a top-level `refreshed` date. A figure without a source and a
date is refused by the CLI's data test (`packages/cli/test/reach.test.mjs`,
`reachProblems`) the way a catalog without a fact is — the test found
nineteen the first time it ran. A figure two sources disagree on is a
range — `low`, `high`, `cited` — with `contested: true`, because the
alternative is picking a side in the C64 dispute in a JSON file.

## The numbers

Twenty-five machines: the eight that build and have hardware to reach
(the web is a URL, not a fleet), the sixteen the roadmap names
([`machines/index.md`](machines/index.md), counting the Z80 page's six),
and the Atari 7800, which the same research turned up between the 2600
and the Lynx. All fetched 2026-09-20 unless a cell says otherwise. `†`
marks a units figure whose sources disagree — read `unitsSold.sources[]`
in the JSON before quoting one.

### Who is out there

| id | units sold (low–high) | cited | Wikipedia views 2025 | itch.io games | subreddit (2023) | MiSTer | Pocket | web emu | new hardware on sale, 2026 |
|---|---|---|---|---|---|---|---|---|---|
| pet | 219K † | 219K | 81K | 46 | 106 | yes | no | yes | — |
| vic20 | 1M–2.5M † | 2.5M | 99K | 193 | 725 | yes | no | yes | THEVIC20 |
| c64 | 12.5M–30M † | 17M | 452K | 1,745 | 18K | yes | yes | yes | Commodore 64 Ultimate; THEC64 / Mini |
| c128 | 1.76M–5.7M † | 4M | 64K | 9 | 641 | yes | no | generic | — |
| plus4 | 1M † | 1M | 22K | 35 | 50 | yes | no | generic | — |
| mega65 | 1,600 shipped | 1,600 | 13K ‡ | 25 | 236 | no | no | yes | MEGA65 (Trenz) |
| cx16 | ~1,100 sold | 1,100 | 16K ‡ | 7 | 394 | community | no | yes | X16 kits (TexElec) |
| atari8 | 2M–4M † | 4M | 97K | 1 § | 2,785 | yes | no | yes | Atari 400 Mini; THE400 |
| atari2600 | 24M–30M † | 30M | 363K | 127 | 7,957 | yes | yes | yes | Atari 2600+; 7800+ |
| atari5200 | ≥1M † | 1M | 108K | 0 | 902 | yes | no | generic | (400 Mini emulates it) |
| atari7800 | 1M–3.77M † | 3.77M | 126K | 3 | 1,069 | yes | yes | yes | Atari 7800+; 2600+ |
| lynx | 2M–3M † | 3M | 91K | 19 | 1,370 | yes | yes | generic | Evercade Lynx collections; Pocket |
| apple2 | 5M–6.5M † | 6M | 287K | 17 | 5,376 | yes | no | yes | — |
| bbc | 1.5M–1.75M † | 1.5M | 116K | 30 | 1,054 | yes | no | yes | — |
| oric | 210K–350K † | 210K | 13K | 28 | 31 | yes | no | yes | — |
| nes | 61.91M | 61.91M | 753K | 2,085 | 95,758 | yes | yes | yes | Pocket; Evercade (NES Classic ended 2018) |
| gameboy | 118.69M | 118.69M | 608K | 7,836 | 190,311 | yes | yes | yes | ModRetro Chromatic; Analogue Pocket |
| pcengine | 5.84M–10M † | 10M | 222K | 22 | 6,378 | yes | yes | yes | Analogue Duo (TG16 Mini ended) |
| supervision | no figure exists | — | 17K | 0 | 63 | yes | yes | yes | — |
| coleco | 2M–6M † | 2M | 130K | 25 | 1,418 | yes | yes | yes | CollectorVision Phoenix |
| sms | 11.2M–21M † | 13M | 292K | 70 | 4,375 | yes | yes | yes | — |
| gamegear | 10.62M–14M † | 10.62M | 184K | 8 | 275 | yes | yes | generic | Game Gear Micro (Japan) |
| zxspectrum | 5M † | 5M | 259K | 1,704 | 5,547 | yes | yes | yes | The Spectrum; Spectrum Next issue 3 |
| msx | 4M–9M † | 5M | 165K | 305 | 1,974 | yes | yes | yes | — |
| cpc | 3M | 3M | 82K | 407 | 1,432 | yes | yes | yes | — |

- **Units** are lifetime hardware sales, the least reliable column on the
  sheet and the one everyone quotes. The C64's 12.5M is Michael Steil's
  serial-number analysis ([pagetable.com/?p=547](https://www.pagetable.com/?p=547));
  17M is Commodore's 1993 annual report as he cites it; Guinness's live
  page now says 12,500,000. NES and Game Boy are Nintendo's own investor
  figures (as of 2026-06-30) and the only uncontested large numbers. The
  PC Engine's "10M" is folklore — the fetched primary (Ogawa, 2010) has
  5.84M for Japan and nothing for the rest. MSX has no primary total at
  all. Read the column as an order of magnitude.
- **Wikipedia views 2025** is the sum of twelve monthly user pageviews of
  the English article (`wikimedia.org/api/rest_v1/metrics/pageviews`).
  It is the one column measured identically for all twenty-five, so it
  is the one to *rank* by. ‡ MEGA65 and X16 have no article of their own
  (proxied by *Commodore 65* and *The 8-Bit Guy*): not comparable.
- **itch.io games** is the count on the machine's tag page — a proxy
  for *who ships homebrew today*, not who plays. § itch.io has no
  canonical Atari 8-bit tag (the generic `atari` tag holds 1,892), so
  the 1 is an artefact of tagging, not of the scene. The Game Boy at
  7,836 is the largest tag in this set by a factor of three, which is
  the single most surprising row on the sheet.
- **Subreddit (2023)** is subredditstats.com's Oct–Dec 2023 count.
  Reddit itself returned 403 on every path from the research
  environment and the mirrors are bot-walled, so no row has a first-party
  2026 number; the JSON carries a 2026 mirror figure for eight machines
  (r/c64 32,585; r/nes 132,763; r/Gameboy 282,004; r/zxspectrum
  14,329 …) marked `verify: true`. Rank order only.
- **MiSTer / Pocket / web emu** say whether a route exists at all.
  Every machine but the MEGA65 has a MiSTer core (the MEGA65 *is* an
  FPGA machine); the X16's is a community core outside `MiSTer-devel`.
  "generic" means reachable in a browser only through RetroArch Web
  Player / EmulatorJS, not a dedicated page.
- **New hardware on sale** is the mini-console / FPGA / new-build route,
  checked against the vendor's own store page. Sales figures for these
  are unpublished for every product except the MEGA65 (1,600 across four
  batches to June 2024, from the project's own digest) and the X16
  ("about 1,100" from a 2024 community recap — secondary).

### What each scene produces in a year, and how software gets in

| id | homebrew database, entries in 2025 | controller shape | normal media | cart only | RAM a real user may have | save routes |
|---|---|---|---|---|---|---|
| pet | — | none (keyboard) | tape, IEEE-488 disk | no | 4K, 8K, 16K, 32K (96K/128K on 8296) | disk, tape, none |
| vic20 | — | atari-stick | tape, cartridge, disk | no | 5K stock, +3K, +8K, +16K, +24K, +32K | disk, tape, none |
| c64 | CSDb 2,464 (2,859 in 2024; 2,238 in 2026 to date) | atari-stick | disk, tape, cartridge | no | 64K; +REU 128K–16M; +GeoRAM | disk, tape, flash cart, none |
| c128 | — | atari-stick | disk, tape, cartridge | no | 128K; +REU 128K/512K | disk |
| plus4 | Plus/4 World: 8 in one week of Sept 2026, no yearly total | atari-stick | tape, disk, cartridge | no | 16K (C16/C116), 64K (Plus/4) | disk, tape |
| mega65 | — | atari-stick | SD card, disk | no | 384K; +8MB attic | SD card, disk |
| cx16 | — | snes-pad | SD card, cartridge | no | 40K + 512K banked; +2MB | SD card |
| atari8 | Fandal: 5,148 games / 3,897 demos total | atari-stick | disk, cartridge, tape | no | 8K–64K; 128K (130XE); 320K+ upgrades | disk, none |
| atari2600 | AtariAge store: 146 homebrews listed | atari-stick + paddles | cartridge | yes | 128 bytes | none (cart EEPROM rare) |
| atari5200 | — | analog stick + keypad | cartridge | yes | 16K | none |
| atari7800 | — | atari-stick (2 buttons) | cartridge | yes | 4K | high-score cart, none |
| lynx | LynxJam 2025: 7 entries | handheld pad | cartridge | yes | 64K | cart EEPROM, none |
| apple2 | Internet Archive: 42,374 items | paddles / keyboard | disk, cassette | no | 48K, 64K, 128K; IIgs 256K–1MB+ | disk, none |
| bbc | bbcmicro.co.uk ≈ 4,570 titles | keyboard (analogue port) | tape, disk, ROM | no | 16K/32K; 64K; 128K | disk, tape, SD bridge |
| oric | — | none (keyboard) | tape, disk | no | 16K, 48K | tape, disk, SD bridge |
| nes | NESdev Compo dormant since 2023 (24 entries) | nes-pad | cartridge | yes | 2K; +8K PRG-RAM on MMC boards | battery SRAM, none |
| gameboy | GB Compo 2025: 113 entries; Homebrew Hub 1,629 | nes-pad | cartridge | yes | 8K WRAM (32K CGB) + cart RAM | battery SRAM |
| pcengine | — | 2-button pad | HuCard, CD | no | 8K | backup RAM (Ten no Koe / CD), none |
| supervision | — | nes-pad | cartridge | yes | 8K | none |
| coleco | Team Pixelboy closed at ~91 titles | keypad + 2 side buttons | cartridge | yes | 1K; 32K with SGM | none |
| sms | SMS Power! 72 (70 in 2026 to date) | 2-button pad | cartridge | yes | 8K | battery SRAM, none |
| gamegear | SMS Power! 10 | 2-button pad | cartridge | yes | 8K | battery SRAM, none |
| zxspectrum | ZXDB 310 (352 in 2023); CSSCGC 2025: 42 | keyboard; Kempston/Sinclair stick optional | tape, disk | no | 16K, 48K, 128K; Next 1–2MB | tape, disk, none |
| msx | Generation MSX 93; MSXdev25: 50 entries | keyboard + 2-button MSX stick | cartridge, disk, tape | no | 8K–64K; MSX2 128K+ | disk, battery SRAM, none |
| cpc | CPC-Power 137 (212 in 2023) | keyboard; stick optional | tape (464), disk (6128) | no | 64K, 128K, 512K | disk, tape, none |

A homebrew database counts *entries* — demos, tools, re-releases,
games alike — and each database counts differently, so the column
compares a scene with itself across years, not one scene with another.
CSDb's 2,400–2,900 a year is the outlier by an order of magnitude and
is the number behind "the machine everyone measures 8-bit software
against" in the root `AGENTS.md`.

### What the sheet says, read plainly

Three findings survive the uncertainty in the columns:

1. **The console route is the biggest by every measure, and it is the
   one 8BitScript is least ready for.** NES and Game Boy together are
   180M units, the two largest Wikipedia audiences, the two largest
   subreddits, and the two largest itch.io tags — and both are cartridge
   only, mapper-banked, pad-input, no keyboard, tiny RAM. The NES package
   exists with one mapper (`nrom`); the Game Boy is an SM83 and Phase 8.
   A program designed on the C64 with a keyboard and 64K reaches this
   audience only if it was *also* designed to fit an NROM cartridge and
   a pad, which is a decision made at the start, not at release.
2. **Among the machines that build today, the C64 is not merely first —
   it is the only one with a scene that ships thousands of releases a
   year.** The next computer scenes by yearly output are the Spectrum,
   CPC, MSX and Master System — all on the roadmap, none built.
   Everything else that builds today (PET, VIC-20, C128, Atari 8-bit)
   has an audience in the tens-of-thousands-of-pageviews range and no
   database that reports a yearly count. The MEGA65 and X16 are
   1,000–2,000-unit machines with disproportionately active developer
   communities (Discords of ~2,200 each) — a *developer* audience, not a
   player one.
3. **The route decides the format, and the format decides the artifact.**
   Twenty-four of twenty-five have a MiSTer core; every one has an
   emulator; the ones with a mini-console (C64, VIC-20, Atari 8-bit,
   2600, 7800, Spectrum, PC Engine) take a file from a USB stick in the
   same formats the emulator takes. On the computers that means `.prg`
   / `.d64` / `.tap` / `.xex` / `.atr` / `.tzx` / `.dsk` — containers
   the toolchain either writes (`.prg`, `.xex`) or has specified
   (`images`). On the consoles it means a ROM with a header the flash
   cart understands, which the toolchain writes for the NES only. The
   physical-media bridges (SD2IEC, FujiNet, EverDrive, DivMMC) consume
   the same files. So "which route" almost never adds a new format — it
   picks one from the list the machine already has, which is why the
   delivery matrix below is per carrier, not per route.

## The demands a program cannot spell today

`requires` is a floor on facts. Three things a program needs are not
facts, and the analysis cannot run without them.

### Input: preferred versus required

Today a program can require `input.keyboard: true` or `input.joysticks:
1`. It cannot say "designed for a joystick, plays on a keyboard" — which
is what 2048 actually is, and what nearly every action game on a
Commodore is. And it cannot require a *shape*: `input.controls` is a list
and `program: false`, so "needs two buttons" is not expressible, though
it is the fact that separates the 7800 and NES from the 2600 and the
C64.

Two additions to the config, no change to facts — the first **built**,
the second **PROPOSED**:

```ts
input: {
  primary: 'stick',                 // stick | pad | keyboard | mouse | paddles | touch
  also: ['keyboard', 'pad'],        // what it also plays on, in order of preference
},
requires: {
  'input.controls': ['up', 'down', 'left', 'right', 'a', 'b'],   // PROPOSED: a subset the machine's controller must carry
},
```

`input.primary` is the device the baseline is played with — it is the
`port2=joystick` of the baseline's hardware, said in the program's terms
so that a machine without control ports (PET) is not the same answer as
a machine with them and nothing plugged in (Atari 8-bit, whose stick was
sold separately). The reach sheet knows the difference: `input.standard`
is what every unit has, `input.optional` what was an accessory. The
report then gives one of three standings per machine — **standard**
(every owner has it), **optional** (some do), **absent** — and the same
for each entry in `also`. For a machine that builds the standing is the
catalog's answer (`packages/cli/src/reach.mjs`, `standingFromFacts`: a
control port or a pad port is standard, a `run` fact like a mouse is
optional at most); for one with no package it is the sheet's, and the
report marks it `(sheet)`.

`requires['input.controls']` is a list requirement, the one kind
`requiresProblems()` refuses today; it would pass when the machine's
`input.controls` contains every named control. Not a fact the program
reads — a program asks its input layer at run time, as now — a floor
the CLI checks. A machine whose controller shape matches nothing
(`controllerKind()` → `null`) fails the requirement with the reason.

### Peripherals: required, or found

`memory.banked`, `memory.bankedKib`, `input.mouse` and `input.paddles`
are `when: 'run'` facts: a build may use them, and the capability finds
out. `requires` refuses them by design — whether a REU is plugged in is
not a build fact. But a program that *cannot work without* 512K of
banked RAM (an image viewer) has nowhere to say so, and one that merely
*uses* it when found (a slide-animation buffer) is indistinguishable from
it.

**PROPOSED** — no new key. Lift the `when: 'run'` refusal in `requires`
for a fact a catalog value can supply, and let the CLI resolve it per
machine:

```ts
requires: { 'memory.bankedKib': 512 },
```

Spelled as a fact, not as a catalog value, because a catalog value is
one machine's name for a thing — `ram=reu512` on the C64,
`expansion=reu512` on the C128, `ram=512` on the X16 — and only the fact
means the same on every sheet. Per machine, the CLI picks the smallest
value that satisfies it and fits it for the build:

- the value has a `detect` (`@8bitscript/c64/reu`): **one artifact**,
  and the probe's failure branch is where the program refuses to start;
- no value with a `detect` satisfies it: a **build per value**, as any
  `affectsBuild` option is today;
- no value satisfies it: the machine is **refused**, with the sheet's
  number — `memory.bankedKib 320 of 512` — the way an unmet floor is
  refused now.

"Uses when found" needs nothing new: it is the per-target `hardware:` a
project already writes, which compiles the detection code in
(`hardware.mjs`). The analysis reports the machine's standing on each
required fact — **stock**, **an option** (naming the value, and, from
the reach sheet, whether a modern route makes it universal), or
**impossible**.

### Delivery shape

What the program *is* as files, before anyone picks a medium:

```ts
delivery: 'single',       // single | files | overlays | programs | banked
```

- `single` — one resident binary; everything the program needs is in it
  when it starts. Every 8BitScript program today.
- `files` — one binary plus data it loads while running (levels, a
  font, a save). The `images` block's `files:` with `type: 'seq'` is
  this shape's disk half; nothing reads them at run time yet.
- `overlays` — a resident core plus code that is loaded over itself
  in stages (a title, then the game; part 1, then part 2). The classic
  tape-multiload shape and the way a 4K machine runs a 12K program.
  No language support exists.
- `programs` — several independent programs on one medium
  (`programs:` in the config, GEOS-style; a menu that `LOAD`s the
  next). Exists as a build shape; the image writer would put them on
  one disk.
- `banked` — one cartridge whose code lives in switched banks. The
  NES's mappers, the Atari's `xegs*`/`mega*` media values, an
  EasyFlash. Resident, so nothing is "loaded"; the bank switch is the
  overlay. Only `nrom` (unbanked) is shipped on the NES.

Not before a second shape builds: today every program is `single`, and a
key with one legal value and four that name unbuilt behaviour is not a
key. Until then a report hard-codes `single` and says so.

This is a statement about the program, not the medium: the matrix
below says which carriers can hold each shape. It is also the key that
the `programs`/`images`/`media` mechanisms lack today — none of them
knows whether a program *expects* to load anything after it starts.

## The analysis: `8bs targets --reach`

**Built** in its first form: the floor, the input standings, the file
and its routes, and the reach figures. Not yet: a required run-time
peripheral (the design above is open) and any filter. One command, one
JSON, no new build path. `8bs targets` already resolves
every machine's catalog, the project's `requires`, `baseline` and
`systems`, and prints per machine what is fitted; `--json` carries the
facts. `--reach` joins that with the reach sheet and the demands above and
prints, per machine — the eight that build and the seventeen that do
not, marked so. Four of the twenty-five rows, for a project with
`requires: { 'input.keyboard': true }` and `input: { primary: 'stick',
also: ['keyboard', 'pad'] }`, as printed on 2026-09-20:

```
This program is designed for: stick, and also plays on keyboard, pad

c64         builds
            input    stick: standard · keyboard: standard · pad: absent
            single   .prg reaches original-hardware+sd-bridge, original-hardware+flash-cart, emulator, fpga, mini-console, web; original-hardware+tape wants tap
            reach    12.5M–30M sold † · 452K views/yr · 2,464 CSDb entries/yr · 1,745 on itch.io · 18K on reddit (2023) · new hardware: Commodore 64 Ultimate (Commodore Corp); THEC64 / THEC64 Mini (Retro Games Ltd); …

cx16        builds
            input    stick: absent · keyboard: standard · pad: standard
            single   .prg reaches real-hardware+sd-card, real-hardware+iec, emulator, web, fpga; real-hardware+cartridge wants bin
            reach    1,100 sold · 16K views/yr ‡ · 7 on itch.io · 394 on reddit (2023) · new hardware: Commander X16 Developer Edition / Build Kit (TexElec)

nes         refused: input.keyboard needs it, has false
            input    stick: absent · keyboard: absent · pad: standard
            single   .nes reaches original-hardware+sd-bridge, emulator, fpga, web; original-hardware+cartridge wants rom
            reach    61.91M sold · 753K views/yr · 2,085 on itch.io · 96K on reddit (2023) · new hardware: Analogue Pocket (openFPGA NES core); Evercade (NES-era licensed collections)

zxspectrum  no package — phase 8 (docs/project/machines/)
            input    stick: optional (sheet) · keyboard: standard (sheet) · pad: absent (sheet)
            single   nothing written yet; routes take tap, tzx, wav, z80, sna, trd, scr, szx, scl, dsk, rom, csw, pzx, img, mgt
            reach    5M sold † · 259K views/yr · 310 Spectrum Computing / ZXDB entries/yr, 42 CSSCGC (comp.sys.sinclair Crap Games Competition) entries/yr · 1,704 on itch.io · 5,547 on reddit (2023) · new hardware: The Spectrum (Retro Games Ltd)
```

The line under a machine's name is the catalog's verdict on the
project's floor (`builds`, `refused: …` with the fact, or `no package`
with the phase); `input` the standings; `single` the file `8bs build`
writes for that machine and which of the sheet's routes take it, with
what the others want instead (a `.tap` no writer makes yet; a raw ROM a
cartridge publisher would need); `reach` the figures, each with its
marker. A required run-time peripheral has no line yet.

What it must and must not do:

- **It never adds a target.** Adding a machine to `targets` is a
  commitment to test on it; the command says what adding would reach and
  what it would be short of, and stops. "Automatically determine" in
  the sense of a filter is fine and cheap — `--json` and `jq`, or a
  `--where 'reach.units >= 1000000 && input.stick == standard'` if it
  earns its keep — but the answer is a list to read, not a config
  change.
- **It never grades.** The lines are the facts: builds / short of /
  refused / no package, then input standings, peripheral standings,
  shape → carriers → routes, then the reach numbers with their dates.
  The reader ranks.
- **It reads the sheet through the same code path the catalog test
  uses**, so a figure without a source or a date fails CI, not a user.
- **`--json` is the editor's.** The side bar can sort machines by any
  column and show the sixteen unbuilt ones greyed, with the phase.

`--reach --json` carries the same rows — `{ id, status, phase, floor,
input, delivery, reach }` — for an editor's panel; the ordinary `targets
--json` the editor reads today is unchanged.

## Delivery: which shapes each carrier can hold

The carrier is the thing the bytes sit in on their way to a CPU. The
question `distribution.md` asks of each — *does it change the built
bytes?* — sorts them into two kinds, and then each kind can hold some
shapes and not others. This is the matrix the release rule needs.

| carrier | changes the build | random access | resident | `single` | `files` | `overlays` | `programs` | `banked` |
|---|---|---|---|---|---|---|---|---|
| **`.prg` / `.xex` alone** (a file on an SD card, a USB stick, an emulator's command line) | no | — | no | yes | no — nothing to load from | no | no — one file is one program | no |
| **disk image** (`.d64`/`.d71`/`.d81`, `.atr`, `.dsk`, `.ssd`, `.woz`) | no | yes | no | yes | yes | yes, any order | yes | no |
| **tape image** (`.tap`/`.t64`, `.cas`, `.tzx`, `.cdt`, `.uef`) | no | **no — forward only** | no | yes | only in load order, never again | only in order: part 2 cannot go back to part 1 | yes, in order | no |
| **cartridge, plain** (Atari `cart8`/`cart16` in the catalog; VIC-20 and C64 8K/16K, 2600, 7800, Coleco and SMS unbanked boards — sizes *to verify* against each machine's page) | **yes** — load address, reset vector, ROM ceiling | n/a | yes, all of it | yes, if it fits | no — no file system | no — nothing to load | no | no |
| **cartridge, banked** (NES mapper, Atari `xegs*`/`mega*`, EasyFlash, GB MBC, SMS Sega mapper, MSX MegaROM) | **yes** — the mapper is the build | n/a | yes, one bank at a time | yes | as banks of data | as banks of code — the switch *is* the overlay | as banks each with an entry | yes |
| **flash / SD cartridge** (Kung Fu Flash, EasyFlash 3, EverDrive, Harmony, DivMMC, M4, FujiNet) | no — it *serves* the row above it | it mounts images | no | serves any of the above | via a mounted image | via a mounted image | via a mounted image | serves a banked image |
| **web bundle** (`.wasm` + host) | no | fetch anything | no | yes | yes | yes | yes | n/a |

Three cells carry the whole delivery question:

- **Tape is a sequence.** A `files` program on tape is valid only if
  every file it will ever load is written after the program in the order
  it will ask for them, and it never asks twice. An `overlays` program on
  tape is the multi-load: parts in order, no going back. The `images`
  writer, when it exists, would need a `tap` format that refuses a file
  list it cannot order — and the program would need a way to *say* the
  order, which is `delivery: 'files'` plus the `files:` list as the
  order. That makes a tape build a *validation*, not a different build.
- **A plain cartridge holds `single` only.** There is no loading, so
  `files`, `overlays` and `programs` are not "unsupported on
  cartridge" — they are shapes with no meaning there. A program of one
  of those shapes has no cartridge build, full stop, unless it is
  *re-shaped* as `banked`, which changes its source (bank-aware data
  access), not its packaging. That is the design rule for the C64
  cartridge `media` value `distribution.md` proposes: it is the Atari
  precedent, and it is a `single`-shape build.
- **A banked cartridge is the only carrier where `overlays` costs
  nothing at run time**, because the bank switch is the load. That is
  why the NES, with 2K of RAM, runs games larger than the C64's memory,
  and why a program designed for it is designed as `banked` from the
  first line. `packages/nes/AGENTS.md` says the same from the machine's
  side.

The **routes** — how a user gets the carrier — add no cells. A THEC64
mounts `.d64` and loads `.prg`; an SD2IEC does the same on a real 1541
bus; a MiSTer core mounts the same images; an emulator takes any of
them. A route is a *filter* on carriers (the 2600+ takes physical
cartridges only — no image route at all; the Atari 400 Mini takes
`.xex`, `.atr`, `.car`, `.cas` from USB), and the reach sheet lists
each route's formats so the analysis can say "this shape reaches these
routes."

## The release rule

Which files should `8bs build --release` produce, and what should they be
called? Today `release: [...]` per target is a hand-written list, and the
2048 README counts fifteen builds and eleven downloads. The user's
question was whether that is too many — "a pet-2001-4k version" when
"a single PET version" might do — and the answer was measurable, so it
was measured.

### Measured: 2048 on every PET

Twelve catalog combinations (`model` × `ram`), built 2026-09-20 from
`trunk` with the checkout's own `8bs`:

| model | ram 4 | ram 8 | ram 32 |
|---|---|---|---|
| 2001 | **A** 2876 + 65 | **B** 2906 + 75 | **B** |
| 3032 | **C** 2856 + 65 | **D** 2886 + 75 | **D** |
| 4032 | **C** | **D** | **D** |
| 8032 | **E** 2875 + 65 | **F** 2905 + 75 | **F** |

Letters are distinct MD5s; numbers are program bytes + variable bytes.
Twelve combinations, **six binaries**:

- **RAM collapses to two.** 8K and 32K are byte-identical: the PET's
  `ram` value sets `__ram_size`, which the linker uses only as the
  ceiling it *measures against* (`mos/index.ts`, `ramCeiling`) — not a
  layout. The 4K build differs because 2048's own source branches on
  `Memory.RAM < ANIM_MIN_RAM` (4096) to drop the slide animation. And
  the animated build is 2906 + 75 = 2981 bytes, **under the 4K PET's
  3071-byte ceiling**: it would fit and run on the 4K machine. The
  separate 4K download exists because the program's author chose the
  threshold, not because the machine forced it.
- **Model collapses to three.** 3032 and 4032 are byte-identical. The
  2001 differs by two facts the *package* folds on and the program never
  tests — `memory.chrget` ($C2 on BASIC 1) and
  `video.characterSetSwapped` — so a 2001 binary prints the wrong case
  on a 3032 and a 3032 binary clobbers the 2001's CHRGET. The 8032
  differs by `video.columns`. One binary for every PET would need the
  text package to read the ROM at run time — a `detect` on `model` —
  and would cost the bytes of both mappings.

So the honest PET line for 2048 is **three artifacts** (a 2001 build,
a 3000/4000-series build, an 8000-series build), or five with the RAM
threshold kept. Today's release ships two English PETs, and names the
second `2048-pet-4032-32.prg` — a file that runs on every 3008, 3016,
3032, 4016 and 4032 at any RAM from 4K up, and says so to nobody.

### The rule

**PROPOSED:** *One artifact per distinct build outcome, named by what it
runs on — never one per catalog value.*

- **A build outcome** is the bytes. Two hardware combinations that
  produce the same file are one artifact, and the CLI can know that
  without a hash: the outcome is a function of the values that
  `affectsBuild` and of the facts the program and its packages fold on.
  A `ram` value that only moves the ceiling is not an outcome; a
  `model` value that changes a package twin is.
- **"Runs on"** is computed, not declared. An artifact runs on every
  catalog combination whose `build`-settled facts equal the ones it was
  folded for and whose ceiling its footprint fits under — `program +
  variables ≤ memory.ram`. That is exactly the check that says the 8K
  PET build runs on the 4K PET, and it is the check that says a build
  fitted for `reu512` needs the REU (or, with `detect`, needs nothing).
- **The name says the smallest thing it runs on.** `2048-pet-3000.prg`,
  not `2048-pet-4032-32.prg`; `2048-pet-2001.prg`; `2048-pet-8032.prg`.
  For a hardware axis with a `detect`, no tag at all: `2048-c64.prg`
  runs with and without the REU and finds out.
- **`release: [...]` becomes the override, and the derived matrix the
  default.** A project that lists nothing gets one artifact per
  outcome; a project that wants the 4K PET build as its own download
  because the threshold is a feature says so, as 2048 does today.
- **`--release --json` carries `{ artifact, runsOn, shortOf, shape,
  carriers }` per build** — `baseline.md`'s open item — and the GitHub
  Release workflow writes the table into the release body. That is how
  GitHub "spits out the correct files": `compile.yml` already runs
  `8bs build --release` and attaches what it produces; the change is in
  what `--release` decides to produce and what it says about each file.

### The scenarios, enumerated

Every way a release can be more than one file, and what the rule says
about each. **Built** means the toolchain does it now.

| scenario | example | one artifact or several | status |
|---|---|---|---|
| a fact the program tests differs by model | PET 40 vs 80 columns | several — one per fold outcome | built (the baseline report names the fact) |
| a fact a package folds on differs by model | PET 2001 vs 3032 ROM | several, unless the package gains a `detect` | built; `detect` on `model` is not |
| RAM size, program branches on it | 2048's 4K / animated split | several by the program's choice; the rule reports that the larger fits the smaller | measured above; the "fits" report is PROPOSED |
| RAM size, program does not branch | most programs | **one** — the catalog value moves only the ceiling | built (the bytes are identical today); the naming is not |
| banked RAM, `detect` exists | C64 REU, C128 256K, X16 banks | one — the probe decides at run time | built (`detect` in `hardware.mjs`) |
| banked RAM, no `detect` | VIC-20 expansion (the screen moves) | several — one per `tag` twin | built |
| a media value | Atari `xex` vs `cart8` | several — a cartridge is a different build | built (Atari only); C64/VIC-20 `crt` is PROPOSED in `distribution.md` |
| a locale | `2048-pet-de.prg` | several — one per locale the release lists | built |
| a web skin | `2048-c64.wasm` | several — the `machine` value `affectsBuild` | built |
| region (NTSC/PAL) | `2048-c64-ntsc.prg` | one — detected at run time (`FRAME_SYNC`); measured 2026-09-20: `--pal` and the default produce byte-identical C64 files | built; the `-ntsc` in the name is a run flag leaking into a file name, worth removing |
| several programs on one disk | GEOS desk + copier | one image, several programs | `programs` built; the image writer is not |
| a program that loads data files | `files` shape | one image per carrier that can hold it (disk yes, cart no, tape in order) | not built — no run-time loading exists |
| overlays | `overlays` shape | one image per carrier; a tape one is a validation of order | not built |
| a banked cartridge | NES MMC1, EasyFlash | one image; the source is bank-aware | `nrom` only |

The table is the "ALL of those scenarios" list. Nine of the thirteen
rows are built today and need only the rule applied to their *naming
and counting*; the RAM-split row needs the "fits" report; the three that
are not built are run-time loading, overlays and non-NROM cartridges —
plus the `images` writer under the `programs` row — each already an open
item in [`distribution.md`](distribution.md).

## The user's cases, answered on this sheet

- **"A program that needs 512K banking — the NES the way the C64 or the
  X16?"** `requires: { 'memory.bankedKib': 512 }`, read against the
  sheets `8bs targets --json` prints today: a C64 program (an option,
  `ram=reu512`, one artifact because the REU has a `detect`), an X16
  program (stock: its default `ram=512`), a C128 program (an option,
  `expansion=reu512`; stock is 64), and *refused* on the NES (0; the one
  mapper has 2K of work RAM) — and, less obviously, refused on the
  MEGA65 too: its sheet says 320 KiB banked and its catalog has no
  option for more (the 8MB attic RAM the reach sheet lists is not on the
  fact sheet). Whether a THEC64 or an Ultimate 64 counts as having the
  REU is a reach-sheet question the JSON marks *to verify*. The report
  says all of this without anyone reading a spec sheet.
- **"Designed for a joystick — reach the most users."** `input.primary:
  'stick', also: ['keyboard', 'pad']`. Read off the sheet's
  `input.standard` / `input.optional`: a stick is **standard** on the
  VIC-20, C64, C128, Plus/4, MEGA65, Atari 8-bit, 2600, 5200 and 7800;
  **optional** on the PET (user port), Oric, Spectrum (Kempston /
  Interface 2), MSX, CPC, Apple II and BBC (analogue port); **absent** on
  the X16, Lynx, NES, Game Boy, PC Engine, Supervision, ColecoVision,
  Master System and Game Gear — which fall to `also`, and every one of
  those but the Lynx comes back as `pad: standard` (the Lynx and
  Supervision are their own pad). The largest reach for a stick-or-pad
  game is the console route, and it requires the cartridge shape.
- **"One PET version regardless of RAM."** Three, by ROM, as measured; and
  the 8K/32K one *is* the "regardless of RAM" build — the rule would name
  it so. One for the whole line needs a `detect` on the ROM in
  `packages/pet`, and the byte cost of that is a measurement to take
  before deciding.
- **"Feature parity across twenty machines."** Not the goal, and the
  vocabulary already says why: a build is *short of* the baseline by a
  list of facts, and reach says how many people are on the far side of
  each fact. A 2600 build of 2048 would be short of `video.columns`,
  `input.keyboard`, `memory.ram` (128 bytes) and `storage.save` — that is
  a different program, and the sheet lets a project say "we stop at
  machines short of the baseline by at most N facts" as a filter rather
  than a feeling.

## Open questions

- **Lifting the `when: 'run'` refusal changes what `requires` means.**
  Today a floor is a promise about the build; a required `run` fact is a
  promise about the build *plus* a probe at start-up, and the program
  has to be told which branch of the probe is "refuse". Whether that is
  the capability's existing failure path or a new `#requires` the
  program can test is the design to settle before the refusal is
  lifted.
- **Whether `runsOn` is a hash or a derivation.** Hashing every catalog
  combination is exact and slow (twelve PET builds is seconds; the C128's
  ten options are thousands). Deriving it from `affectsBuild`, `tag`, the
  facts tested and the footprint is fast and needs to be trusted; the
  twelve-build measurement above is the first test case for it.
- **The reach sheet's refresh.** Once a year by hand, with the date
  bumped, is probably right; a scheduled fetch of the Wikipedia and
  itch.io columns is cheap and would keep the two comparable columns
  current. Reddit is not fetchable without a logged-in client and should
  be dropped rather than mirrored.
- **Seventeen machines with no package.** The sheet has them so that
  "what would a Spectrum build reach" has an answer, and so that the
  phase order in [`machines/index.md`](machines/index.md) can be argued
  from numbers: by reach among the unbuilt, Game Boy, then Spectrum,
  then Master System / MSX / CPC, then the Atari consoles. The roadmap's
  current order puts the Apple II and Plus/4 first (Phase 5). That is a
  decision for the roadmap, and this note only supplies the columns.

## Method and caveats

Four research passes on 2026-09-20 — three by machine family, one
cross-cutting snapshot that measured the same columns for all
twenty-five the same way — merged into
`packages/cli/data/reach.json`. Every figure carries
`source` and `asOf`; a figure no fetched page confirmed carries `verify:
true` and a note — 184 such flags and 192 `toVerify` items in the shipped
file, most of them subreddit counts (Reddit returned 403 on every route, including its
API, and the mirrors are bot-walled) and forum totals behind
Cloudflare (Lemon64, Forum64, AtariAge direct — AtariAge's counts came
through a text proxy). Units figures are the least reliable column and
are ranges where any two sources disagree. The Wikipedia pageview
column is the only one measured by the same instrument for all
twenty-five and is the one to sort by; the itch.io column is the best
proxy for who ships homebrew; nothing on the sheet says who *plays*.
Physical-publisher and flash-cart format lists came partly from memory
and are marked in the family caveats inside the JSON. Before any number
here is quoted on a README, read its `sources[]`.
