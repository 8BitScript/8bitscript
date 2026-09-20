---
title: Distribution and media
nav_order: 84
---

# From a build to a physical machine or an emulator

Research notes, not a spec — the same voice as
[`docs/project/machines/index.md`](machines/index.md): every claim below
is cited to a real file, and anything proposed rather than observed is
marked **PROPOSED**. Read the root `AGENTS.md` first;
its "expose constraints, don't abstract away a hardware limit" rule
governs everything below. Written against `trunk`.

This answers: how does an `8bs build` artifact actually reach a real
machine or an emulator, across every distribution medium a developer
might use — and where the existing hardware-catalog mechanism already
covers this vs. where it's a real gap.

## The three axes that already exist

`packages/cli/src/hardware.mjs`'s own header comment lays out the model:
a machine package declares a `"8bitscript".hardware` catalog of
*options* (RAM expansion, control ports, model) with *values*, each
value able to set four things — `tag` (source-file twin selection),
`build` (defsym/startup/output-extension for the native linker), `run`
(emulator flags), `facts` (what `#fact(...)` sees) — plus `detect` (a
runtime probe subpath, when one binary can find the hardware itself
rather than needing a build per value).

That's one of the three axes this problem actually has:

1. **Machine** — which CPU/chipset family (`RELEASE_MACHINES`: pet,
   vic20, c64, c128, cx16, mega65, atari8, nes, web — README.md's target
   table).
2. **Hardware fitted to the machine** — RAM expansion, model, ports.
   Already fully modeled by the catalog above. C64's `ram` option alone
   has 9 REU sizes (`packages/c64/package.json`, `none` through
   `reu16m`), each a `defsym`/fact pair, not a hardcoded table.
3. **Media / distribution carrier** — what physical or virtual container
   the built bytes end up in before they reach a CPU. This axis exists
   in the catalog mechanism already, but only one machine actually uses
   it.

## Media as a hardware option: the one real precedent (Atari 8-bit)

`packages/atari8/package.json` declares a `media` option:

- `xex` (default) — "Atari DOS executable (.xex), loaded from D: into
  $2000-$BFFF" — no build-shape change, just an output convention.
- `cart8` — 8 KiB cartridge at `$A000`: changes `startup` to `cart-std`,
  `output` to `rom`, and sets `__cart_rom_size`. This is a build change,
  not a packaging change — load address, start-up vector, and ROM size
  ceiling all differ.
- further values exist for larger cart sizes and `xegs256` (the `xegs`
  preset).

This is the whole answer to "different media changes the build vs.
doesn't" — and the repo has already drawn that line once, correctly,
for one machine. `docs/config.md`'s **Images** section states the rule
explicitly: *"A disk image is a container over built programs and data
files... It changes no program's bytes, which is what separates it from
a cartridge: a cartridge changes the build... so it is a hardware
`media` option in the machine's catalog."* That sentence is the
load-bearing distinction for everything below.

## The disk-image layer: specified, validated, not yet written

`docs/config.md` documents an `images` project-config block:

```ts
images: {
  'geos-tools': {
    target: 'c64',
    format: 'd64',          // d64 | d71 | d81 on the Commodores, atr on the Atari
    boot: 'main',           // written first: what LOAD "*",8,1 loads
    files: [
      { program: 'main', name: 'GEOS TOOLS' },
      { path: 'assets/font.bin', name: 'FONT', type: 'seq' },
    ],
  },
},
```

Sixteen-character on-disk names (CBM DOS truncation), a `boot` program,
a `target` every listed program must build for. **"This release
validates images and writes none. The writer (`c1541` for the Commodore
formats, which ships with VICE) is a later release's."** — i.e. the
schema/validation exists, the actual `.d64`/`.d71`/`.d81`/`.atr`
byte-writer does not. NES and web are explicitly out of scope for
images: "the cartridge and the bundle are the program."

## Persistence is already modeled as a capability, not a machine fact

`packages/nes/AGENTS.md` states the rule this whole area should follow:
*"NES cartridges are read-only, so persistence = password screens"* is
named as a wrong assumption to avoid — battery-backed SRAM and the
Famicom Disk System both existed, so persistence is a mapper/media
profile fact, not a per-machine boolean. Concretely, the NES's `nrom`
mapper value carries `storage.save: false` as a fact under that value,
not under the `nes` machine. This is the right model to generalize:
"can this build persist state" is a function of *(machine, media,
hardware option)*, never of machine name alone — the same discipline
root `AGENTS.md`'s "Persistence is a capability" rule already states
generally.

## Artifact formats today

| Machine family | Extension | Notes |
| --- | --- | --- |
| Commodore (PET, VIC-20, C64, C128), CX16, MEGA65 | `.prg` | one relocatable load format, no media option yet |
| Atari 8-bit | `.xex` (disk-loadable) or `.rom` (cartridge, via `media`) | only machine with a real media axis today |
| NES | `.nes` (iNES header) | mapper is the media-equivalent axis; only `nrom` shipped |
| Web | `.wasm` + bundle | `docs/web-embedding.md` covers embedding, not "physical" distribution — N/A here |

`<name>-<machine>[-<hardware>...][-<region>].<ext>` is the naming
scheme, already carrying hardware-option tags and locale into the
filename (`2048-pet-de.prg`).

## What "modern ways of connecting things" actually covers — and is genuinely unbuilt

None of the following exist anywhere in the repo today (searched
`packages/`, `docs/`, `editors/` for cartridge/disk-image/tape/transfer
tooling; found only the `media`/`images` spec above and per-machine
research notes). This is the real gap this research is mapping,
machine by machine:

- **Cassette (tape).** PET, VIC-20, and C64 all support `.tap`-style
  cassette images; nothing in `images` currently names `tap` as a
  format (only `d64`/`d71`/`d81`/`atr` are listed). **PROPOSED**: treat
  as a low-priority `images` format addition, not a new axis — a
  cassette image is packaging, not a build change, the same
  "container, not build" test the `images` doc already applies to disk.
- **Commodore cartridges.** Only Atari 8-bit has a `media` cartridge
  value today. A C64/VIC-20 cartridge (plain 8K/16K ROM, or
  EasyFlash-style flashable) would need the same `media` option
  treatment Atari already has — a real `build.startup`/`output`/`defsym`
  change (cartridge load address and reset-vector shape differ from a
  `.prg`'s BASIC-stub-relative load), not an `images` entry.
  **PROPOSED**, following the Atari precedent exactly.
- **Modern hardware bridges — the "developer's real C64" case.** SD2IEC
  / Pi1541 / Ultimate64/1541-Ultimate-II+ all consume the *existing*
  `.prg`/`.d64` artifacts over an SD card or a drag-and-drop mount; a
  ZoomFloppy or xu1541 (OpenCBM) writes a `.d64` to a *real* 1541 over
  USB. None of these need a new build shape or even a new `media` value
  — they need a **transfer/deploy step** that consumes whatever
  `8bs build`/the image writer already produced. This is conceptually a
  fourth thing, distinct from machine/hardware/media: **PROPOSED** a
  `deploy`/`transfer` layer (`8bs deploy --system 'PET 2001 (8K)' --via
  sd2iec:/Volumes/SD2IEC`, or similar) that never touches the build,
  only moves the artifact — the same "container, not build" test again,
  one level further out.
- **NES flash carts (Everdrive, PowerPak) and Atari SIO2SD/SIO2PC.**
  Same shape as the Commodore bridges above — a deploy-time concern
  once the ROM/XEX already exists, not a build concern.
- **Emulators are the one distribution path already fully solved.**
  `8bs run <machine>` (`packages/cli/src/run.mjs`) already builds and
  launches the right emulator with the right flags per hardware option
  (`hardware.mjs`'s `run` field, keyed per emulator). This is
  functionally the "deploy to an emulator" case of the same deploy
  layer proposed above — worth noting `run.mjs` already *is* a working
  reference implementation for "take a build, hand it to a target,"
  which a real `deploy` command for physical media would want to mirror
  in shape (per-emulator `run` flags today ↔ per-bridge `deploy` flags
  tomorrow).

## Proposed model (for discussion, not yet designed in detail)

Four axes, not three, with a clean separation test for each — the same
test `docs/config.md` already uses for images vs. cartridges: **does it
change the built bytes?**

1. **Machine** — which package/CPU family. Fixed set,
   `RELEASE_MACHINES`.
2. **Hardware fitted** — `"8bitscript".hardware.options`, changes facts
   and sometimes the build (`defsym`). Fully built today.
3. **Media** — changes the build (load address, startup, output
   format). Built for Atari 8-bit only; **PROPOSED** to generalize to
   Commodore cartridges via the same `media` option shape, and possibly
   cassette via `images` formats (packaging only, no build change).
4. **Deploy/transfer** — moves an already-built artifact onto a real
   device or into an emulator. Emulators: solved (`run.mjs`). Physical
   media: entirely unbuilt — this is the actual "connect it to my real
   C64" gap, and it is a separate concern from all three axes above by
   the same "changes no bytes" test `docs/config.md` uses for disk
   images.

## Which shapes each carrier can hold, and how many artifacts to ship

[`reach.md`](reach.md) takes the four axes above one step further: a
program's *delivery shape* (single, files, overlays, programs, banked)
against each carrier — disk, tape, plain cartridge, banked cartridge,
flash cart, web — and the release rule that falls out of it, one artifact
per distinct build outcome named by what it runs on, measured on 2048's
twelve PET builds.

## Open questions to resolve before any implementation

- Does `deploy` belong in `packages/cli`, or is it thin enough to be a
  documented recipe (a page per bridge tool) rather than compiler-owned
  code? The bridges (SD2IEC, ZoomFloppy, Everdrive) are third-party
  tools with their own CLIs/UIs — 8BitScript's job may only be "produce
  the file in the right format at the right path," not reimplement
  `c1541` or OpenCBM.
- Per the `images` doc's own admission, the `.d64`/`.d71`/`.d81`/`.atr`
  writer itself doesn't exist yet — that's the actual prerequisite for
  most of the physical-media story, since most bridges want a disk
  image, not a bare `.prg`.
- Which machines get a `media` option first — C64 cartridges are the
  highest-value target (EasyFlash is the de facto standard in the
  current scene) but need real research into EasyFlash's own
  load/bank-switch contract before writing a catalog entry, the same
  "verify against primary sources" discipline `docs/project/machines/
  *.md` already holds itself to for unbuilt machines.
