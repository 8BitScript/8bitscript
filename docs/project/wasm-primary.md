---
title: WASM is the primary runtime
nav_order: 91
---

# WASM is the primary runtime

*Written 2026-10-04 from an audit of every example, Studio and the Vegas Nights
slot lab on the five release machines. Numbers marked **measured** were
produced by the commands named beside them; nothing here was run on real
hardware, in a real browser tab, or on PAL.*

## The policy

8BitScript compiles a program to a real machine's code **and** to WebAssembly,
and the WebAssembly build is how a program is developed, debugged, shared and,
if its author wants, distributed. The editor's **Editor** tab, the external
browser and a hosted web page all run it. A native emulator (VICE, `x16emu`)
is the second opinion: it says whether the wasm build is telling the truth.

Four rules follow, and the rest of this page is how each is kept.

1. **Every release machine has a wasm module that runs every example and every
   app.** The wasm module is this project's own implementation of the machine —
   the machine package's own `.8bs` sources, compiled by the wasm backend, painted
   by the page's scanline compositor — not a chip emulator in a box. (The one
   exception to "own implementation" is the X16's vendored `x16emu` compiled to
   WebAssembly, `8bs run cx16 --web --x16emu`: a fallback that runs anything,
   not the primary runtime.)
2. **A feature with no wasm path is a bug, or a documented limit.** A limit
   lives in the machine package's `emulator.wasm.limits`, comes out of
   `8bs targets --json` as `runtime.wasm.limits`, and is what the editor shows
   beside the Editor and Browser buttons. A build that succeeds and draws
   nothing is worse than one that fails, and is listed as a gap below.
3. **"It mirrors the device" is measured.** `8bs conform` builds a probe
   through the native emulator and through the wasm backend and compares one
   frame, cell by cell. Each machine's package pins how many cells are known
   to differ; the number can only go down.
4. **A web build is a static folder.** `8bs build --target <machine> --web`
   writes a directory any static host serves. It is a shareable URL, an embed
   (`docs/web-embedding.md`) or a distribution.

## What "the wasm build of a machine" is, exactly

Three things share the word and are easy to confuse:

| | What it is | How to get it |
|---|---|---|
| **The `web` target** | A synthetic machine that exists only as the runtime: 48×27 cells, the host font, 16 colours, `Video.*` facts decided in `packages/web`. 2048's four skins (`--hardware machine=c64`, `pet-2001`, `vic20`) are this target dressed up. | `8bs build --target web`, `8bs run web` |
| **A machine's wasm build** | The real machine package (`packages/pet`, `vic20`, `c64`, `cx16`) compiled through `@8bitscript/compiler/wasm`. Registers it pins with `@address` are bytes of linear memory; screen RAM and colour RAM are where the machine keeps them; the page paints that memory the way the machine's video chip would. **This is what the policy is about.** | `8bs build --target <m> --web`, `8bs run <m> --web` |
| **The vendored real emulator** | `x16emu` compiled to WebAssembly. X16 only. | `8bs run cx16 --web --x16emu` |

## How a frame gets to the page

```
.8bs sources ──► front end (machine: <m>) ──► @8bitscript/compiler/wasm ──► program.wasm
                                                         │ reserved memory range = the layout
packages/cli/src/web-layout.mjs  layoutForRealMachine()  ┘ (grid, charBase, colorBase, palette, offsets)
         │ written beside the wasm as program.json (the manifest)
         ▼
8bitscript.js (web-loader.mjs)   worker.js runs the wasm, SharedArrayBuffer + Atomics.wait = waitFrame()
         │ every frame: read screen RAM, colour RAM, the raster list, the glyph table
         ▼
web-scanline.mjs  renderFrame()  one scanline at a time, so a raster entry lands on the line it names
```

| Piece | Where |
|---|---|
| The wasm backend | `packages/compiler/src/wasm/` (`lower.ts`, `encode.ts`) |
| Each machine's layout: grid, `charBase`/`colorBase`, palette, character-ROM font, VIC register block | `packages/cli/src/web-layout.mjs` (`REAL_MACHINE_LAYOUT`) |
| Fonts: the ROM glyphs, captured and SHA-pinned | `packages/cli/src/font8x8.mjs` |
| The loader and the page | `packages/cli/src/web-loader.mjs`, `web-runtime.mjs` (`writeWebBundle`) |
| The compositor | `packages/cli/src/web-scanline.mjs` |
| The headless screenshot (same compositor, run in Node) | `packages/cli/src/screenshot.mjs` (`webScreenshot`) |
| The conformance command | `packages/cli/src/conform.mjs`, probes in `packages/cli/conform/` |
| Input and audio hosts | the manifest's `inputOffset`/`hostOffset` and `audioBase` (−1: no model) |

**Wiring a feature in:** (1) find the machine's wasm-hostile code: an `asm6502`
block fails the build with its function's name; (2) give the machine package a
`*.web.8bs` twin, or a plain-loop version of the same interface, as
`packages/c64/src` and Vegas Nights' `glyphs.c64.web.8bs` do; (3) if the page
must show something the memory map cannot say, extend the manifest
(`sidecarJson` in `web-layout.mjs`) and the compositor; (4) add a probe to
`packages/cli/conform/` so `8bs conform` can see the difference; (5) delete the
limit line from the machine's `emulator.wasm.limits` in the same commit, and
tighten its `conform.test.mjs`.

## The audit

**Measured**, 2026-10-04, `8bs run <m> --web --screenshot` for every example,
Studio and Vegas Nights (the toolchain is this branch; Vegas Nights `trunk`):

| Builds for wasm | pet | vic20 | c64 | cx16 | web |
|---|---|---|---|---|---|
| `hello-world`, `hello-8bx` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `fancy` (raster, sprites) | ✔ | ✘ `raster_probeRegion` | ✘ `sprites_update` | ✘ `raster_commit` | ✔ |
| `joystick` (input, sprites) | ✔ | ✔ | ✘ `sprites_update` | ✘ `input_poll` | ✔ |
| `media-walk`, `swarm` (graphics, audio) | ✔ | ✔ | ✘ `sprites_update` | ✔ | ✔ |
| Studio | ✔ | ✔ | ✘ `sprites_update` | ✔ | ✔ |
| Vegas Nights lobby, `hello-reels`, `sound-test` | ✔ | ✔ | ✔ | ✘ `input_poll` | ✔ |
| Vegas Nights `tile-test` | ✔ | ✔ | ✔ | ✔ | not for web |
| Vegas Nights `slot3x3` | ✘ `move_down` | ✘ `move_down` | ✔ | ✘ `play` | ✔ |
| Vegas Nights `slot5x5`, `slot5x5-bonus` | ✔ | ✔ | ✔ | ✘ `play` | ✔ |

Every ✘ is an `asm6502` block, which the wasm backend never lowers: *"'x': 'asm'
blocks are 6502-specific machine code and are never lowered on the web target"*.
Of 35 example builds, 27 pass; of the 34 Vegas Nights builds that apply (`tile-test`
does not target the web), 26 pass. The Vegas Nights `move_down` and `play` ones are the
game's own machine code (the quadrant machines' block-copy hop; the X16 reel
code) and need wasm twins in that repo.

**Building is not rendering.** Three builds that pass were looked at against the
real machine (`media-walk`, 200 frames):

| | native | wasm |
|---|---|---|
| PET | two objects (a cross and a bar) | the same two (since item 1: they were text only) |
| VIC-20 | objects | the same two, in square pixels (since item 1: they were text only) |
| X16 | a yellow VERA sprite | one white 8×8 glyph, in about the right place (since #317; it was text only) |

**`@8bitscript/graphics` draws its objects on the PET and VIC-20 wasm builds (item
1), and one flat glyph on the X16's.** The PET and VIC-20 objects are quadrant
blocks written as screen codes of 128 and up; until the page drew reverse video
(codes ≥ 128 were blank) they never appeared. The X16's are VERA sprites, which the
page has no renderer for, so a picture is drawn as a glyph in a single ink. The
C64's do not build (`sprites_update`). Only the `web` target draws them as designed.

## Conformance: the first measurements

`8bs conform` over the `grid` probe (four solid corner cells, the printable
ASCII ramp in normal and reverse video, one cell per text colour):

| | cells | differ in structure | differ in colour only | what |
|---|---|---|---|---|
| **C64** | 1000 | **0** | 7 | The text, the character ROM and reverse video match x64sc cell for cell. The ink colours do not: the page paints the Pepto palette (`136,57,50` for red); x64sc's default is another (`169,71,100`). |
| **PET** (4032) | 1000 | **0** (was 114) | 0 | Reverse video is the screen code's bit 7 inverting the glyph, as the video circuit does; the page also reads the VIA control register (`$E84C` bit 1) each frame for the live ROM set. Fixed by backlog item 1: the PET and VIC-20 fonts had only codes 0–127, so the corner cells, the reverse ramp and the colour row differed. |
| **VIC-20** (8K) | 506 | **0** (was 166) | 6 | The same, and the page now boots in the upper case and graphics ROM set (`vic20-upper-screencode`) and follows the low nybble of `$9005` to the lower/upper set. The six colour-only cells are the colour row: the page paints a C64-flavoured palette where xvic has its own (backlog item 5). |
| **X16** | 4256 | **186** | 0 | Reverse video works; the page draws the ASCII ramp in the host font, not the ISO character ROM x16emu uses. (The first run, before #317, also found the colours were the C64's palette, not VERA's default — 8 cells; that is fixed.) |
| web | — | — | — | no native emulator to compare against |

The numbers are pinned: `packages/{pet,vic20,c64,cx16}/test/conform.test.mjs`
fail if more cells differ than listed, and print a note when fewer do. Run one
with `8bs conform pet`; it writes `<out>/grid-pet.{native,wasm,diff}.png` — the
diff image is the native capture, the wasm capture and a third panel with the
differing cells in red (structure) and amber (colour only).

How it compares, so a result can be trusted: the probe's four corner cells are
solid, so the bounding box of the lit pixels in each capture **is** the picture,
and the scale falls out of the grid size — no table of where each emulator keeps
its border. A wasm capture whose corner cells did not draw is read where the
page puts the picture (centred), and says so. Each 8×8 cell becomes an ink
bitmap and an ink colour. *Structure* is the bitmaps; the tolerance is none.
*Colour* is the ink's RGB, tolerance 48 a channel (`--colour-tolerance`); a
colour difference warns, and fails under `--strict-colour`.

What it cannot see yet: anything that moves, sprites, bitmap or multicolour
modes, raster timing. Those are items 4 and 6 below.

## The parity matrix

✔ works · ◐ partial · ✘ missing. Evidence is in the audit and conformance tables above.

| Feature | pet | vic20 | c64 | cx16 | web |
|---|---|---|---|---|---|
| Builds the shared examples | ✔ 7/7 | ◐ 6/7 | ✘ 2/7 | ◐ 5/7 | ✔ 7/7 |
| Text grid and character ROM (codes 0–127) | ✔ both sets, switched by `$E84C` | ✔ both sets, switched by `$9005` | ✔ | ◐ host font | ✔ |
| Reverse video (codes 128–255) | ✔ | ✔ | ✔ | ✔ | ✔ |
| Text colours and palette | ✔ (mono) | ◐ 6 colour-row cells: page palette vs xvic | ◐ Pepto vs VICE | ✔ VERA's default (#317) | ✔ |
| Portable input | ✔ builds | ✔ builds | ✔ arrows/Enter/Esc | ✘ `input_poll` | ✔ |
| Portable raster (`@8bitscript/raster`) | ◐ 3032/4032 only; untested | ✘ `raster_probeRegion` | ◐ lands one picture line early | ✘ `raster_commit` | ✔ |
| Graphics objects (`@8bitscript/graphics`) | ◐ draws (`media-walk`); other ops untested on wasm | ◐ draws (`media-walk`); other ops untested on wasm | ✘ does not build | ◐ one flat glyph, not a sprite (#317) | ✔ |
| Hardware sprites / bitmap / multicolour | n/a | n/a | ✘ not drawn | ✘ not drawn | n/a |
| Sound (`audio.tone`, `.8ba`) | ✘ silent | ✘ silent | ✘ silent | ✘ silent | ✔ (Web Audio; not heard in a tab) |
| PAL / 50 Hz | ✘ NTSC | ✘ NTSC | ✘ NTSC | n/a | n/a |
| Save / storage | ✘ | ✘ | ✘ | ✘ | ✘ (`localStorage` bridge unbuilt) |
| Cycle-accurate timing | ✘ | ✘ | ✘ | ✘ | n/a |
| Runs from a static host | ✔ | ✔ | ✔ | ✔ | ✔ |

## The backlog

Ordered by value over cost. Effort: **S** about a day, **M** a few days,
**L** a week or more. Each of the first six is written as a brief a fork can run.

| # | Item | Effort | Depends on |
|---|---|---|---|
| 1 | ~~Reverse video, and the boot character set, on PET and VIC-20~~ **done**: PET 114 → 0, VIC-20 166 → 0 differing cells | S | — |
| 2 | X16: portable input and raster in the wasm backend | M | — |
| 3 | VIC-20: portable raster in the wasm backend | M | 1 |
| 4 | C64 sprites (`sprites_update`) and a VIC-II sprite renderer | L | — |
| 5 | Palettes and ROM fonts that match the real machines | S–M | — |
| 6 | Graphics objects on PET, VIC-20 and X16 | M | 1 (PET, VIC-20); a VERA sprite renderer (X16) |
| 7 | Sound models and a Web Audio host for the four machines | L | — |
| 8 | Conformance for moving things: raster timing, sprites, scroll; frame-locked captures | M | 4, `raster.frame()` |
| 9 | A build refuses, or warns, where it cannot draw (graphics objects on a wasm machine that cannot draw them) | S | 6 |
| 10 | Distribution: a single-file export and a mode that runs without `SharedArrayBuffer` | M | — |
| 11 | PAL and 50 Hz; cycles per frame | M | — |

**1. Reverse video and the boot character set (PET, VIC-20) — S.** `font8x8.mjs`
returns `null` for codes ≥ 128 on `pet-2001-screencode`, `pet-text-screencode`
and `vic20-text-screencode`; `web-layout.mjs` (`REAL_MACHINE_LAYOUT.pet`,
the comment at "Reverse video (bit 7 …)") masks the bit off. On a real PET and
VIC-20 a screen code with bit 7 set is the same glyph with every pixel inverted.
Return the inverted copy of `code − 128` (or let `renderFrame` invert when bit 7
is set, as it already does for the C64's colour-RAM bit 7), and capture the
VIC-20's upper-case/graphics set from the ROM (pinned by SHA-256 as the C64's is;
`vic20-text-screencode` is the lower-case set) and select it by default.
*Acceptance:* `packages/pet/test/conform.test.mjs` `knownStructure` 114 → 0 and
`packages/vic20/test/conform.test.mjs` 166 → 0 (the colour row then measures the
VIC-20 palette: report it); `media-walk` draws its two objects on the PET and
VIC-20 wasm (item 6 follows); the PET and VIC-20 `limits` lines about reverse
video and the character set come out.

*Done.* `font8x8.mjs` widens every PET and VIC-20 font to 256 codes (bit 7 = the
glyph inverted: the PET's video circuit does it, and the VIC-20 ROM's reversed
copies are exactly that, which the generator checks), and
`packages/cli/scripts/font-roms.mjs` adds the graphics half of each ROM from VICE's
images, pinned by SHA-256 (`font-roms.mjs`). The layout names the pair of sets and
the register that picks between them (`charsetSwitch`: the PET's `$E84C` bit 1, the
VIC-20's `$9005` low nybble); the page and the rasterizer read it each frame, so a
program that selects a set is drawn in that set. Two new probes, `charset` and
`charset-text` (`packages/cli/conform/src/`), write every screen code 0–255 raw in
each set and match xpet and xvic with **0** differing cells, structure and colour.

**2. X16 input and raster in the wasm backend — M.** `input_poll` (keyboard, pad,
mouse via the KERNAL) and `raster_commit` (the VERA line-IRQ driver) are
`asm6502`. Write wasm twins in `packages/cx16/src` that read the portable input
offsets the page already writes (`inputOffset`/`hostOffset`; see how the C64
wasm port did it in #311) and apply the portable raster list through
`rasterBase`. *Acceptance:* `examples/joystick` and `examples/fancy` build and run
on cx16 wasm; Vegas Nights `main`, `hello-reels`, `sound-test` build for cx16
wasm; the two X16 `limits` lines go; a new `bands` probe in `packages/cli/conform/`
(border colour changing at named picture lines) shows the same rows native and
wasm within the documented offset.

**3. VIC-20 raster in the wasm backend — M.** `raster_probeRegion` and the frame
hook's writers are machine code. Port the portable raster to a wasm twin (the VIC-20
has no interrupt: the native driver busy-waits down the frame; the wasm page already
composes per scanline). *Acceptance:* `examples/fancy` builds and shows its two
colour bands on vic20 wasm at the same picture lines as xvic (`bands` probe).

**4. C64 sprites — L.** `sprites_update` and the 24-sprite multiplexer are machine
code; `fancy`, `joystick`, `media-walk`, `swarm` and Studio all stop there. Add a
wasm twin of the sprite layer (the portable interface, not the multiplexer's
cycles) and a VIC-II sprite renderer in `web-scanline.mjs` (8 sprites, shapes read
from VIC bank memory, X MSB, expand, multicolour, priority; reused down the frame
as the multiplexer does by plain object count). *Acceptance:* the five programs
build and run on c64 wasm; a `sprites` conformance probe agrees with x64sc to the
documented tolerance; the C64 `limits` sprite line goes.

**5. Palettes and ROM fonts — S–M.** The C64 page uses the Pepto palette where
x64sc defaults to another (`169,71,100` for red; the page paints `136,57,50`): read
VICE's real palette. The X16's colours were the C64's until #317 made them VERA's
default; what is left there is the font — capture the X16 ISO character ROM from
the pinned ROM image (the C64's character-ROM generator is the model: it takes no
path argument and checks the ROM's SHA-256). *Acceptance:*
`8bs conform c64 --strict-colour` passes with colour tolerance 0;
`packages/cx16/test/conform.test.mjs` 186 → 0.

**6. Graphics objects on PET, VIC-20 and X16 — M.** After item 1 the quadrant
objects should draw on PET and VIC-20 (verify, then fix what is left); the X16 draws
one flat glyph per picture today (#317) and needs a VERA sprite renderer (128
sprites, 8/16/32/64 px, 4/8 bpp, palette offset, flips, Z) reading sprite attribute
RAM from the wasm memory map. *Acceptance:*
`examples/media-walk` and `swarm` match the native picture on all three
(a `graphics` conformance probe); the `graphics objects` limit lines go.

The remaining items are scoped in the table. Items 7 (sound), 8 (moving
conformance), 9 (compile-time refusal), 10 (distribution) and 11 (PAL) are
independent of the first six and are where the rest of the audit's "✘" cells
go.

## Distribution

`8bs build --target <machine> --web` writes `dist/web/` (`dist/web/<program>/`
when the project has several programs):

```
index.html     the program, filling the tab
embed.html     the same inside an article — a worked example
8bitscript.js  the loader (<eightbit-screen> and EightBitScript.mount())
worker.js      the machine, as a file
coi.js         cross-origin isolation for hosts that cannot send headers
program.wasm   (or program-<tag>.wasm; see below)
program.json   the layout manifest the loader reads
_headers       COOP/COEP for Cloudflare Pages and Netlify
```

- **Hosting.** Any static host. `waitFrame()` blocks a worker on
  `Atomics.wait`, which needs `SharedArrayBuffer`, which needs the page
  *cross-origin isolated*: send `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (the `_headers` file, or
  `docs/web-embedding.md` for Apache, nginx and Vercel), or load `coi.js`, a
  service worker that adds them (GitHub Pages).
- **Opening the folder from disk does not work** (expected, **not tested in a
  browser here**): the loader `fetch()`es `program.wasm` and `program.json`, a
  browser refuses `fetch` of a `file:` URL, and the isolation service worker
  needs https or localhost. A single-file export and a mode that does not need
  `SharedArrayBuffer` are backlog item 10.
- **Several machines, one page.** 2048 builds four skins of the *web target*
  (`--hardware machine=c64`, `pet-2001`, `vic20`, default) into one `dist/web/`
  (`program-c64.wasm`, `program-pet-2001.wasm`, …) and copies its own
  `site/index.html` over the generated one to choose between them. A machine's
  *real* wasm build can be hosted the same way; nothing has been built that
  way yet.
- **Fixed in this change.** A hardware-tagged build writes its files under the
  tag so several models can sit side by side — the VIC-20 with 8K (the release
  hardware) is `program-expanded.wasm` — and `index.html` and `embed.html`
  still asked for `program.wasm`. On a clean directory
  `8bs build --target vic20 --web` produced a site whose only file the page
  needed was a 404. They now name the file the bundle wrote
  (`packages/cli/test/web-bundle-name.test.mjs`).

## What is not known

- Whether any of this behaves in a real browser tab: Chrome, Safari and Firefox
  have not been driven. Everything above is Node's WebAssembly and the same
  compositor, headless.
- PAL, 50 Hz, and cycles per frame: the page runs one logical frame per
  `waitFrame()` at the machine's nominal rate.
- The raster list's "one picture line early" figure on the C64
  (`packages/c64/package.json` limits) is the C64 wasm fork's measurement against
  the machine's handler; no probe yet checks it.
