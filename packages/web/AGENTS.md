# Writing web-target support for 8BitScript

This file is for anyone — human or agent — touching `packages/web`,
`packages/backend-web`, `packages/cli`'s web runtime (`src/web-runtime.mjs`,
`src/wasm-host.mjs`, `src/font8x8.mjs`, `src/png.mjs`, and the `web`
branches of `src/build.mjs`, `src/run.mjs` and `src/screenshot.mjs`), or the
web rows of `docs/setup/verify.md`, `docs/roadmap.md`, `docs/studio.md` and
`packages/studio/AGENTS.md`. Read the root [`AGENTS.md`](../../AGENTS.md)
first; the rules there apply to every target and are not repeated.
[`packages/pet/AGENTS.md`](../pet/AGENTS.md) and
[`packages/cx16/AGENTS.md`](../cx16/AGENTS.md) are the contrasts: the PET
has almost no hardware and the X16 has a great deal, but on both, every
number is a fact someone can read in a datasheet or an emulator's source.
The web target is a fourth case —

> **The web target has no hardware. Every fact about its screen, its
> memory, its clock and its palette is a decision someone wrote into the
> runtime, and the runtime *is* the emulator. Today it emulates a
> C64-shaped 40×25 character grid inside a 24-pixel border, the C64's
> sixteen colours, one flat 64 KB page, and a logical frame clock at the
> project's `frameRate` — and nothing else. Treat it as a machine whose
> specification lives in three files, never as "the target with no
> constraints".**

Because the web has no hardware to be faithful to, the web target has a
second job the 6502 targets do not: it is the one machine the portable
capability packages can be given their *reference* implementation on, and
the one Studio's full tier can be "much fancier" on
(`docs/roadmap.md`, Phase 1). The second half of this file is a proposal
for what it should emulate to do that job. The first half is what it
emulates now. Do not let the two blur.

## What exists today

Do not describe more than this as working:

- `packages/web/src/index.8bs` exports one namespace, `WebRegisters`: four
  byte offsets into the program's wasm linear memory — `BORDER_OFFSET` 0,
  `BACKGROUND_OFFSET` 1, `CHAR_BASE` 2, `COLOR_BASE` 1002. That is the
  whole "hardware surface": an agreement between the package and the host
  about where in the program's own memory the picture is, which the host
  reads once per painted frame. There is no register map because there is
  no chip.
- `src/screen.8bs` (behind `@8bitscript/screen`, as `@8bitscript/web/screen`)
  masks border and background to `& 15` and writes them to bytes 0 and 1.
  `screen.blank()` writes the space code (32) to the 1000 character cells;
  it does not touch the 1000 colour cells. `BorderColor` and
  `BackgroundColor` carry all sixteen C64 names plus `KEEP` (255).
- `src/text.8bs` (behind `@8bitscript/text`) is a 40-column, 1000-cell grid:
  `text.putChar(cell, code)` writes the ASCII code itself to `2 + cell`
  (no screen-code conversion — there is no character ROM to convert for),
  `text.putColor` writes `1002 + cell`, `text.print`/`printNumber` write
  both, in the colour `text.setColor()` last set (white until then).
  `printNumber` uses a real divide, since wasm has one. `TextColor` has the
  eight shared names only.
- `packages/backend-web` lowers the IR to AssemblyScript and drives `asc`
  (0.28.20) to a `.wasm`: one 64 KB page, static data (string literals,
  `const` *and* `let` arrays, `string<N>` variables) from `0xE000`, and a
  single host import, `env.waitFrame`, declared only when the program calls
  `waitFrame()`. Such a program is built with shared memory. An `@address`
  scalar is refused ("no such hardware on the web target"); an `asm6502`
  block is refused; native sources are ignored.
- `8bs run web` (`packages/cli/src/web-runtime.mjs`) serves the `.wasm`, a
  page and a worker on `127.0.0.1` and opens the OS browser (`--no-open`
  prints the URL only). The worker instantiates the program and calls its
  one exported function; the page paints the shared memory onto a 368×248
  canvas every `requestAnimationFrame` and releases logical frames on a
  fixed timestep of `1000 / frameRate` ms; the worker's `waitFrame()` is
  `Atomics.wait` on a shared counter. Double-click or `F` is fullscreen;
  an FPS readout shows logical frames consumed per real second. Ctrl+C in
  the terminal stops the server.
- `8bs run web --screenshot <file.png>` (`screenshot.mjs`, `wasm-host.mjs`)
  runs the same `.wasm` in Node's own WebAssembly with a counting
  `waitFrame()` that throws after `--frames` calls (default 3 seconds' worth
  at `frameRate`), rasterises the same memory layout with a public-domain
  8×8 bitmap font (`font8x8.mjs`, ASCII 32–95 only) and writes the PNG
  itself (`png.mjs`). No browser, no emulator, frame-exact.
- `8bs build --target web` names the output `dist/<stem>.wasm` — no
  `-web`, no region, no profile, unlike every 6502 target — and prints the
  memory line "as declared", not measured.

There is no input of any kind (the page's `F` key and double-click never
reach the worker), no sound, no sprites, no tiles, no bitmap, no
redefinable character set, no block graphics, no scrolling, no storage,
no palette beyond the borrowed sixteen, no `--profile`, no `--pal`
(ignored), and no way for the program to reach the canvas as pixels.
Studio has one `main.8bs` for every machine, and it reads the tier from
the build's facts rather than from `#system()`. The web's sheet says
`input.keyboard` false, so the web takes the read-only **viewer** tier —
and, with `audio.voices` 0 and `storage.save` false, it is the one viewer
that cannot even play or load: view only. The runtime growing a keyboard
is what lifts it (item 1 below), and its 57344 bytes and the browser's
capacity are why the full tier is designed to be hosted here eventually.
door renders correctly in the browser was not run while writing this
file (*to verify*). `docs/compiler.md`
names the web backend and the `0xE000` data segment but does not describe
the worker/`Atomics` pacing anywhere; the only description of it is the
header comment of `web-runtime.mjs` itself.

## Facts verified here

Every row below is a design decision, not a hardware fact: each was chosen
by whoever wrote the file in the *Where* column, and changing that file
changes the "machine". Rows marked **ran** were observed by building
`examples/borders` for the web and instantiating the
result in Node while writing this file; rows marked **read** were read in
the source named but not executed (the browser page was not driven by a
script). Line numbers are as of this writing; the symbol beside each is
what to search for when they drift.

| Fact | Where |
| ---- | ----- |
| The screen agreement is four offsets: border byte 0, background byte 1, 1000 character codes from byte 2, 1000 colour bytes from byte 1002 — two side-by-side regions, not interleaved. 1000 cells was picked as "the C64's shape, a safe superset of the VIC-20's 506". | `packages/web/src/index.8bs:26-37`, `WebRegisters` (read) |
| Grid 40×25, cell 8×8 px, border 24 px on every side: canvas resolution 368×248, stretched to the window with `image-rendering: pixelated`. Characters are clipped to the inner 320×200 and cannot draw in the border. | `packages/cli/src/web-runtime.mjs:37-53`, `GRID_COLS`…`SCREEN_H`; `:238-241`, `paint()` clip (read); the headless PNG is 368×248 RGBA (ran) |
| Palette: the C64's sixteen colours, in the C64's numbering, as CSS hex; the host masks every colour byte `& 15`; the package masks border/background `& 15` before writing. | `web-runtime.mjs:23-35`, `COLORS`; `:229, :231, :247` (read); `packages/web/src/screen.8bs:26-27, 48, 52` (read) |
| A cell's colour is its own byte's low nibble (foreground only); there is no per-cell background. Colour bytes start at 0, so a cell written with `text.putChar` alone draws in colour 0 (black). `screen.blank()` clears characters, not colours. | `web-runtime.mjs:247` (read); `packages/web/src/text.8bs:39-56` (read); `screen.8bs:42-44` (read) |
| Only codes 32–95 draw (space, digits, upper-case letters, the ASCII punctuation between); 0 and everything else draws nothing, in both renderers. There are no block-graphics glyphs. | `web-runtime.mjs:181-184`, `decodeScreenCode`; `packages/cli/src/font8x8.mjs:23-27`, `glyphRows` (read); the font table is 64 glyphs, 512 bytes (ran) |
| The browser draws cells with the system monospace font (`ui-monospace, Menlo, monospace`, ascent-corrected); the headless screenshot draws Hepper's `font8x8_basic`. The two pictures are not pixel-identical. | `web-runtime.mjs:213-223` (read); `screenshot.mjs:362-377`, `webScreenshot` (read) |
| Memory: exactly one 64 KB wasm page (`--initialMemory 1`), `--maximumMemory 1` when the program uses `waitFrame()`; flat, unbanked; `memory.read`/`write` are `load<u8>`/`store<u8>` at any offset. | `packages/backend-web/src/index.mjs:321-335`, `buildWasm` asc flags; `:81-82, :128-129` (read); `memory.buffer.byteLength === 65536`, and a `SharedArrayBuffer` for a `waitFrame()` build (ran) |
| Static data — string literals, `const` arrays, **`let` arrays**, `string<N>` variables — is laid out by asc from `--memoryBase 0xE000`; the 8192 bytes to the end of the page are the limit, and going past it is a build error phrased in those terms. | `index.mjs:45-50`, `STRING_DATA_BASE`; `:232-245`; `:343-351` (read); the borders program's two literals sit at `0xE000` as `[5,'T','I','C','K',' ', 8,' ','O','P',…]` and its highest non-zero byte is `0xE016` (ran) |
| Scalar globals are wasm globals, exported by name, not bytes in linear memory: `memory.read` cannot see a variable. Arrays and strings *are* in memory. | `index.mjs:254-256` (read); exports of the built module are `BORDERS BACKGROUNDS framesUntilTick ticks option currentColor` (globals), `main` (function), `memory` (ran) |
| `@address` on a scalar is refused for the web; `@address` on an *array* is accepted and becomes a raw offset into the page. | `index.mjs:247-252` vs `:241` (read) |
| The `.wasm` imports at most `env.waitFrame` and exports exactly one function, found by kind, not by name; there is no crt0 — the worker and the headless host call the entry bare. | `index.mjs:205-213, 260-283` (read); `wasm-host.mjs:45-56`, `instantiateProgram` (read); imports `['env.waitFrame']` (ran); `web-runtime.mjs:102`, `wasm-host.mjs:70` (read) |
| The page's clock: real elapsed time accumulates per `requestAnimationFrame`; each whole `1000 / frameRate` ms releases one logical frame by `Atomics.add`/`notify` on `ISSUED`, but only while fewer than two are owed; a stall is capped at ten steps. The worker's `waitFrame()` loops `Atomics.wait` on `ISSUED` until it exceeds `CONSUMED`, then increments `CONSUMED`. So one real frame satisfies 0, 1 or 2 `waitFrame()` calls — the same rule as the 6502 backend's accumulator, which names this host as its reference. | `web-runtime.mjs:257-300`, `tick()`; `:83-89`, worker `waitFrame` (read); `packages/backend-6502/src/index.mjs:236-250` (read) |
| `frameRate` comes from `8bs.config.ts` (default 60, positive integer) and is threaded through `compile()` into `runInBrowser` and `webScreenshot`; `--pal` is ignored for the web. | `packages/cli/src/config.mjs:36-45`, `resolveFrameRate`; `run.mjs:223, 246`; `build.mjs:16-18` (read) |
| The page paints the *live* shared memory every display refresh — no snapshot, no double buffer. A write is visible at whatever paint comes next, mid-frame included. | `web-runtime.mjs:225-255`, `paint(mem)`; `:298` (read) |
| A program that never calls `waitFrame()` is built without shared memory, runs to completion in the worker, and its memory is posted to the page afterwards; a program that returns ends ("the program finished"); one that spins burns the worker, not the tab. | `web-runtime.mjs:97-108, 302-308` (read); `index.mjs:333-335` (read) |
| Shared memory needs cross-origin isolation, so every response carries `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. | `web-runtime.mjs:323-330`, `ISOLATION_HEADERS` (read) |
| Headless: `boundedWaitFrame(limit)` throws `FrameLimitReached` on call `limit + 1`, unwinding through the wasm frames; `--frames` counts `waitFrame()` calls exactly; the default is `3 × frameRate`. After 180 frames at 60 the borders program shows `TICK 6 OPTION 0`, border 6, background 3, cell-0 colour 7 — exactly 3 s of its 0.5 s tick. | `wasm-host.mjs:11-29, 67-75` (read); `screenshot.mjs:323, 344-350` (read); memory after the run (ran) |
| Toolchain: `asc 0.28.20`, flags `-O3 --runtime stub --memoryBase 57344 --initialMemory 1` (+ `--maximumMemory 1 --sharedMemory --enable threads` for `waitFrame()` builds); Node ≥ 26. LLVM-MOS is not involved: the SDK's `bin/` has no web driver (only `wasm-ld`, LLVM's linker). | `packages/backend-web/package.json:8-12`; `index.mjs:318-336` (read); `ls ~/.local/opt/llvm-mos/bin` (ran); the borders `.wasm` is 747 bytes (ran) |
| Output is `dist/<stem>.wasm` beside its generated `dist/<stem>.ts`, no target/region/profile suffix; the memory line is the source's declared counts. | `build.mjs:215-225, 262-268`, `memoryLine` (read); `built …/dist/main.wasm`, `memory: 4 bytes of RAM for variables, 23 bytes of constant data (as declared)` (ran) |
| The checker's portable string set is space, `0`–`9`, `A`–`Z`, `! , - . : ?` — a subset of what the host draws (32–95). `text.putChar` takes any `utinyint`; the host decides what shows. | `packages/compiler/src/checker/index.mjs:68` (read) |
| The web is the last of nine machines the resolver knows; `@8bitscript/screen` and `@8bitscript/text` map it to this package's two subpaths. | `packages/compiler/src/resolver/index.mjs:42`; `packages/screen/package.json`, `packages/web/package.json:9-12` (read) |
| The catalog's stock fact sheet: grid 40×25 of 8×8, 16 colours, 2 per cell (its own foreground, the global background), no redefinable glyphs, no block glyphs (only codes 32–95 draw), no bitmap, one layer, no scroll, no sprites; no sound, keyboard, ports, pads, mouse or paddles, and nowhere to save — every one `0` or `false`, honestly, until the runtime grows them (see the proposal below); 57344 bytes (`0x0000`–`0xDFFF`, under the data base), nothing banked. The absence of a keyboard is why Studio is a viewer here. | `src/text.8bs`; the grid, font, memory and `--memoryBase` rows above; `package.json` (read) |

## The schema, as the runtime decides it today

The brief every target is written against asks sixteen questions. For the
web each answer is a line of code, cited above; this is the compact form.

1. **CPU / clock** — none emulated. The program is wasm32 from
   AssemblyScript; integer arithmetic widens to i32 and narrows at every
   store, so `u8` wraps exactly as specified; 24-bit types widen to 32.
   There is no cycle budget: a frame's work takes however long the host
   takes. `asm6502` is refused.
2. **RAM and banking** — one flat 64 KB page, no banking. `0x0000`–`0x07D1`
   is the screen agreement, `0xE000`–`0xFFFF` is static data (8 KB, shared
   by literals and `let`/`const` arrays), everything between is free and
   unprotected. Scalar variables are not in the page at all.
3. **Native unit** — character cells drawn by the host from a font it
   owns; no framebuffer the program can reach; no tiles; no sprites.
4. **Text grid** — 40×25 of 8×8 px inside a 24 px border whose colour is
   byte 0; a character at `(x, y)` is `memory.write(2 + y * 40 + x, code)`.
5. **Modes / colour** — one mode. Sixteen C64 colours; per-cell foreground
   (low nibble), one global background, one global border. No bitmap, no
   multicolour, no per-cell background.
6. **Layers** — one (the cell grid over the background colour). No scroll.
7. **Sprites** — none, and no software substitute in the package.
8. **Pseudo-pixels** — none: only codes 32–95 draw, and they are text.
9. **Audio** — none. No entropy source either.
10. **Input** — none reaches the program.
11. **Storage / persistence** — none.
12. **Timing** — logical frames at `frameRate` (default 60) from a
    `requestAnimationFrame` accumulator, ≤ 2 owed, released through
    `Atomics`; no vblank and no unsafe window, but no coherent frame
    either (the page paints live memory). Headless: a counter.
13. **Profiles** — none; `--pal` ignored; no `--profile`.
14. **Emulator** — the runtime itself (`8bs run web`), a local HTTP server
    plus the OS browser; headless screenshot through Node + `font8x8` +
    a minimal PNG encoder; no host-filesystem route.
15. **LLVM-MOS** — not used; `asc 0.28.20`, `--runtime stub`, one page,
    `--memoryBase 0xE000`; no crt0; the entry is the one exported function.
16. **Traps** — see "Traps" below.

## Rules for this target

### The runtime is the datasheet

- There are three places the "machine" is defined and they are kept in
  sync by hand: `WebRegisters` in `index.8bs`, the constants at the top of
  `web-runtime.mjs` (which `screenshot.mjs` imports, so the headless
  renderer cannot drift from the browser's layout — only from its font),
  and the asc flags in `backend-web`. Change one and the other two are
  wrong. There is no shared module the `.8bs` side and the JS host can
  both import; until there is, a change to the agreement is a three-file
  change and a test.
- Every number above is a *choice*, so write the reason beside it when you
  change one, the way the existing comments do ("the C64's shape, a safe
  superset of the VIC-20's 506"). A future reader cannot look it up
  anywhere else.
- The web target proves *semantics*, never *fit*. It has no cycle budget,
  its divide is one instruction, and its memory line is declared, not
  measured. A program that runs at `frameRate` here says nothing about
  whether it runs at `frameRate` on a VIC-20. Do not use the web build to
  argue a program is small or fast enough for a 6502.

### Memory is one page, and only some things are in it

- `memory.read`/`write` reach the whole 64 KB; nothing is protected.
  Writing a C64 register address changes a byte nothing reads
  (`docs/compiler.md` says so; keep it saying so). A program that pokes
  `$D020` for its border on the web is a bug on the web, not a bug in the
  web.
- Scalar globals are wasm globals. `memory.read` cannot observe a
  variable, and no offset in the page aliases one. Arrays, `string<N>`
  variables and literals are in the page, at `0xE000` and up — including
  `let` arrays, which therefore spend the same 8 KB static budget as
  constants. That budget is the target's only memory limit today and it
  is the one thing that fails a web build for size.
- `@address` is refused on a scalar and accepted on an array. Until that
  asymmetry is resolved deliberately, do not build a package on it: an
  `@address` array over the screen agreement works, but it is the only
  place the language lets you name an absolute web offset, and nothing
  checks it against `WebRegisters`.

### The screen is bytes the page reads whenever it likes

- The picture is whatever bytes 0–2001 hold at the instant of a paint.
  There is no vblank, no "picture off", no write budget — the NES rules
  do not apply here. But there is also no coherent frame: a program that
  rewrites the grid across several statements can be painted half-way.
  Today that is accepted; the proposal below fixes it. Do not add a
  vblank queue to this package to work around it.
- Colour is a foreground nibble per cell and starts at black. A package
  or program that writes characters with `putChar` and never `putColor`
  gets invisible text on a black background and black text on any other.
  `print`/`printNumber` write both; prefer them.
- Codes outside 32–95 are blank. There is no reverse video, no PETSCII,
  no block set, no lower case. A portable "block/pattern" helper cannot
  be implemented here today without a font change in *both* renderers.
- The two renderers differ in font. When a screenshot and the tab
  disagree about glyph shape, that is expected; when they disagree about
  which cell is which colour, that is a bug.

### Time is the page's, and only `waitFrame()` sees it

- `frameRate` is the only timing knob. There is no 50 Hz variant, no
  `--pal`, no region; a project that sets `frameRate: 50` runs at 50 here
  and at 50 logical frames per second on every 6502 target too. Keep it
  that way — the 6502 accumulator is written against this host as the
  reference, and the reference must stay a fixed timestep.
- The ≤ 2-owed rule and the ten-step stall cap are the web's version of
  "a real machine never catches up a backlog". Keep them in step with
  `FRAME_SYNC` in `backend-6502` if either side changes.
- A `waitFrame()` build is a shared-memory build and needs COOP/COEP.
  Hosting the `.wasm` on any server other than `8bs run web`'s needs those
  two headers, or `SharedArrayBuffer` does not exist and the worker cannot
  block.
- Headless, `--frames` is exact and OS-independent — the only target
  where it is. A test that needs to see a program's screen after exactly
  N frames should be a web test.

### What is not here yet

- No input, sound, sprites, tiles, storage, palette or scroll — for the
  web or (mostly) any machine. `packages/studio/AGENTS.md` lists what
  Studio needs in order; the web implementations of those capabilities
  are the subject of the proposal below, and none of them exist.

## Traps

The five things most likely to make someone who knows the C64 write a
wrong web program, today:

- **`memory.write($D020, …)` does nothing.** There is no chip; the byte
  changes and nothing reads it. Border is byte 0, through `screen`.
- **A variable is not in memory.** `memory.read` of "where my counter is"
  reads a page byte, never the wasm global the counter actually is.
  Arrays and strings are in the page — at `0xE000`, and `let` arrays
  count against the same 8 KB as the constants.
- **Colour RAM starts black, and there is only a foreground nibble.**
  `putChar` alone is invisible on black; there is no per-cell background,
  no reverse video, no colours 16+, nothing above code 95.
- **There is no vblank — in both directions.** Writes are always safe and
  never lost, but the page may paint the middle of your redraw. And the
  tab's font is not the screenshot's font.
- **`--pal` is ignored and speed means nothing.** `frameRate` is the only
  clock; a web build that keeps up says nothing about a 6502 keeping up,
  and a `waitFrame()` build needs COOP/COEP headers anywhere but here.

## PROPOSAL: what the web target should emulate

**Everything in this section is a proposal. None of it exists, none of it
is scheduled, and nothing in `docs/` may describe it as working until it
does.** It is written down here so that when the portable capabilities
arrive (input first, then character/sprite access, sound, storage — the
order Studio sets), the web implementation of each has a shape agreed in
advance, and so that the web can host Studio's full tier and be the
reference the 6502 implementations are measured against.

Two rules from the root file discipline it. First, *a superset runtime is
for hosting capabilities and Studio, never for programs to write against*:
a portable API still has to be satisfiable by the smallest machine that
claims it, and the web build proves nothing about fit or speed. Second,
*intent, not pixels*: the primitive stays cells, tiles, sprites and a
palette, not a framebuffer, because a framebuffer is exactly the thing
most of the 6502 targets do not have. A third, from the brief every one
of these files is written against: a number about another machine that
is not in that machine's `AGENTS.md` or package source is recalled, not
verified, and is marked *to verify* below — confirm it in that machine's
sources before a capability depends on it.

1. **CPU / clock** — keep wasm; add nothing. Consider a per-frame *time*
   diagnostic in the page (a logical frame whose worker time exceeds
   `1000 / frameRate` ms drops the FPS readout already; logging it once
   would make "too slow on the web" visible). Never a cycle count — there
   is no honest one.
2. **RAM and banking** — keep one flat 64 KB page; it is the same size as
   the 6502's window and that likeness is worth more than room. Carve the
   bottom of the page into a documented map instead of the current
   "2002 bytes then nothing": an *agreement page* (registers, input
   snapshot, audio voice table, sprite table, palette RAM, layer scroll)
   at fixed offsets, then the character/tile maps, then free RAM. Move
   `let` arrays out of the `0xE000` static segment into that free RAM so
   variables and constants stop sharing 8 KB. If Studio's web tier ever
   needs more than a page, do it as a *profile* (`web` / `web-large`),
   never by growing the default — and shape any far-memory idea after the
   X16's bank model, which is Studio's reference, not after wasm's.
3. **Native unit** — a virtual video chip made of what every 6502 target
   has *some* of: a character layer with a redefinable 256-glyph × 8-byte
   charset in the page (the C64 keeps a RAM copy of its character set —
   `@8bitscript/c64/video`, per `packages/studio/AGENTS.md`; the X16's
   charset is VRAM at a base the KERNAL chooses — `packages/cx16/AGENTS.md`;
   the VIC-20, Atari, C128 and MEGA65 redefining theirs is *to verify* in
   their packages; the NES ships its font as CHR-ROM, `docs/compiler.md`,
   so only a CHR-RAM *mapper profile* could redefine it — a property of
   the cartridge, never of the machine; the PET cannot, and ignores the
   write),
   one or two tile layers with scroll registers, a sprite table, and
   palette RAM. No bitmap layer: not universal, and it would invite
   pixel-thinking.
4. **Text grid** — keep 40×25 as the default and make geometry a
   profile file the way the PET does (`geometry.web.<profile>.8bs`). 40×25
   is a superset of the VIC-20 (22×23), NES (28×26) and Atari (40×24)
   grids but not of the X16's 76×56 or the 8032's 80×25; Studio's full
   tier is designed on the X16, so a `web-studio` profile at the X16's
   76×56 (or 80×50) may be what "the full editor, sized to the machine"
   needs. Keep the border: it is where "the border colour" shows.
5. **Modes / colour** — palette RAM of 256 RGB entries in the page with
   entries 0–15 preloaded as the C64 palette, so every existing colour
   number keeps its meaning and `& 15` stays valid for the old surfaces.
   Per-cell foreground *and* background nibble (the X16 has both —
   `packages/cx16/AGENTS.md`; the NES colours per attribute region —
   `packages/nes/src/screen.8bs`; the PET has none — `packages/pet/AGENTS.md`;
   the C64's foreground-only colour RAM is *to verify* in its package —
   each implements what it can). The portable API names intent (`TextColor.RED`); the web
   resolves it through the palette like everyone else.
6. **Layers** — two tile layers with per-layer horizontal/vertical fine
   scroll in the agreement page (the X16 has two — `packages/cx16/AGENTS.md`;
   the NES's one scrolling nametable, the C64's `$D016` fine scroll and
   Atari's display list are recalled, *to verify*). Priority: layer 1
   behind layer 0 behind sprites, fixed. Per-scanline effects: none
   emulated — they are the thing that differs most across chips.
7. **Sprites** — a sprite table of 128 entries (the X16's count,
   `packages/cx16/AGENTS.md`; that it is the largest of any target here is
   *to verify* against the MEGA65 package) with position, 8×8/16×16 size,
   palette index,
   flip bits, enable. **No per-scanline limit in the runtime**, but a
   *tooling* diagnostic that counts sprites per scanline against the
   6502 target being built for, because the per-scanline number is the
   real constraint everywhere (root `AGENTS.md`). Collision: software
   only; the hardware kinds are too different to promise.
8. **Pseudo-pixels** — come free with the redefinable charset (item 3):
   a 2×2 block set in glyphs 96–111, or the PETSCII quarter blocks, in
   both renderers. Not before the charset; a font-only change would have
   to be made twice.
9. **Audio** — a voice table in the agreement page (frequency, waveform
   square/saw/triangle/noise, volume, ADSR) played by the page through an
   `AudioWorklet` reading the shared memory once per logical frame, so
   sound is deterministic in frames like everything else. Sixteen voices
   (the X16 PSG's count, *to verify*; SID's three are in
   `packages/studio/AGENTS.md` and the PET's one in `packages/pet/AGENTS.md`;
   POKEY's four and the NES's five are recalled, *to verify*). PCM
   and filter later, if a capability needs them. Entropy: none, unless a
   separate explicitly optional import wraps `crypto.getRandomValues`, per
   the root rule on randomness.
10. **Input** — the page writes, the program reads, and the worker never
    sees a DOM event: a key-state snapshot (one byte per key, or a
    matrix-shaped bitset so the PET/C64 packages have a twin), a joystick
    byte per port in the Commodore/Atari five-line shape (recalled, *to
    verify* against `@8bitscript/c64/joystick`) from the Gamepad API,
    and a pointer (x, y, buttons) from the mouse. The program samples them
    right after `waitFrame()` — the PET's snapshot rule — and a
    `@8bitscript/input` capability sits on top. This needs no new wasm
    import; the shared memory is the port.
11. **Storage / persistence** — the page can hand the browser a file and
    take one dropped on it (`packages/studio/AGENTS.md` already assumes
    so; *to verify* what a capability wants of it). Shape: a byte region
    plus a request byte in the agreement page; `8bs run web`'s server can
    read and write project files for Studio's "Launch in Studio" round
    trip, behind the same persistence capability every media profile
    declares — never assumed from `machine == web`.
12. **Timing** — keep the clock exactly as it is. Make the frame
    *coherent*: copy the agreement page and maps once at each paint, or
    better, have the worker snapshot at `waitFrame()` so the picture is
    "what memory held when the program said it was done" — what a real
    machine shows when writes happen in vblank. Keep the headless counter.
13. **Profiles** — `web` (today's 40×25) and, if Studio needs it,
    `web-studio` (item 4). Nothing else; every profile is a matrix row.
14. **Emulator** — keep `8bs run web`; make the page and the headless
    path share one renderer (`font8x8` in both, drawn to the canvas as
    pixels, not text) so a screenshot is the tab, pixel for pixel.
15. **LLVM-MOS** — stays out. `asc` stays; the `--memoryBase` and page
    flags change only with item 2.
16. **Traps** — the "Traps" section above is what to keep true, or
    update, whichever way the proposal goes.

## Where things live

```
packages/web/src/index.8bs               target package: WebRegisters — the four offsets (0, 1, 2, 1002) the host reads
packages/web/src/screen.8bs              @8bitscript/web/screen: setColors/setBorder/setBackground (& 15), blank() over 1000 chars, sixteen names + KEEP
packages/web/src/text.8bs                @8bitscript/web/text: ASCII straight into the page, COLUMNS 40, CELL_COUNT 1000, divide-based printNumber, eight TextColor names
packages/web/package.json                "8bitscript".entry and the two subpaths ./screen, ./text
packages/backend-web/src/index.mjs       IR → AssemblyScript → asc: STRING_DATA_BASE 0xE000, one page, env.waitFrame import, @address/asm6502 refusals, the asc flags
packages/backend-web/test/backend.test.mjs   u8 wrap, shared memory + host import, string data at 0xE000 clear of the screen
packages/cli/src/web-runtime.mjs         the emulator: COLORS, GRID_COLS/ROWS, CHAR_W/H, BORDER_PX, CHAR_BASE/COLOR_BASE, the worker's Atomics.wait, the page's rAF clock, paint(), COOP/COEP
packages/cli/src/wasm-host.mjs           headless: instantiateProgram (one export, one import), boundedWaitFrame, runProgram
packages/cli/src/font8x8.mjs             the 64-glyph 8×8 font (ASCII 32–95) the screenshot draws with
packages/cli/src/png.mjs                 the PNG encoder the web target alone needs
packages/cli/src/screenshot.mjs          webScreenshot: runProgram for --frames, rasterise the same layout, write the PNG; WEB_DEFAULT_FRAME_SECONDS
packages/cli/src/run.mjs                 8bs run web / --no-open → runInBrowser; --screenshot route
packages/cli/src/build.mjs               --target web → buildWasm, dist/<stem>.wasm, declared memory line; --pal ignored
packages/cli/src/config.mjs              resolveFrameRate: the one timing knob
packages/cli/test/screenshot.test.mjs    web: --screenshot produces a PNG with no emulator at all
packages/backend-6502/src/index.mjs      FRAME_SYNC's accumulator comment: this host is the reference the 6502 clock imitates
packages/compiler/src/fold/index.mjs     SYSTEMS: #system() is 0 on a web build (System.WEB)
packages/studio/src/main.8bs             the one Studio entry: no input.keyboard fact, so the web takes Tier.VIEWER
docs/compiler.md                         the web backend row, 0xE000 strings, the 8 KB static-data limit, memory.write on the web
docs/setup/verify.md                     the web row of the --screenshot table
docs/roadmap.md, docs/studio.md          "the web version can be much fancier"; the web is a viewer until its runtime reads keys
packages/studio/AGENTS.md                what Studio needs (browser keyboard, "the web runtime can hand the browser a file")
```
