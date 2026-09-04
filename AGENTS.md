# Working on 8BitScript

This file is for anyone — human or agent — contributing to this repository.
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers workflow (trunk-only, tests,
docs authoring conventions); this file covers a recurring design mistake
worth naming explicitly: treating 8-bit machines as more alike than they are.

The project's own status section (see [`README.md`](README.md)) is the
source of truth for what compiles today — check it, and
[`docs/compiler.md`](docs/compiler.md), before describing anything as
working. Nothing here overrides that: a rule below about how a *future*
capability should be shaped is not a claim that the capability exists yet.

## The one rule everything else follows from

> **8BitScript should abstract concepts, but expose constraints. It should
> never abstract away a hardware limit that determines whether a program
> actually works.**

A portable program talks about positions, actors, input, deterministic
random numbers, persistent state, and frame updates. `sprite`, `tile`,
`screen RAM`, `VRAM`, `bank`, and even `draw()` are not universal concepts
across VIC-20, C64, PET, C128, Atari 8-bit, and NES — each of those words
either doesn't exist on some machine or means a different amount of hardware
on each one. See [`docs/roadmap.md`](docs/roadmap.md)'s Phase 3 section for
why NES is the first target where this stops being optional.

## Rules that apply to every target

- **A "machine" and a "cartridge/media profile" are different axes.** This
  repo already has the pattern: `ATARI8_PROFILES`, `VIC20_PROFILES`, and
  `C64_PROFILES` in `packages/backend-6502/src/index.mjs` let one machine
  resolve to several build configurations. Any new machine-specific storage,
  banking, or output-format question should extend that pattern rather than
  invent a new one, and rather than being hardcoded into the machine's base
  target the way NES's mapper currently is (see
  [`packages/nes/AGENTS.md`](packages/nes/AGENTS.md)).
- **Don't assume a framebuffer.** A target may be character-cell, tile/
  nametable, sprite/display-list, or bitmap based, or some mix. A portable
  drawing API has to describe intent (`sprites.place(...)`,
  `background.setTile(...)`), not "write this RGB value at this pixel."
- **Don't assume a flat, unbanked address space.** C128 in particular maps
  128K of RAM through one 64K CPU window at a time. A pointer that is
  directly dereferenceable and an address that lives in another bank are not
  the same kind of thing, and the language must not pretend otherwise once
  banked machines arrive.
- **A number from one machine is not a number for "8-bit."** "8 sprites"
  means one thing on NES (8 *of 64*, selectable per scanline — the real
  constraint is per-scanline, not the 64) and something else entirely on C64
  (8 hardware movable-object blocks, full stop). A shared capability like
  `8bit:sprites` has to describe intent the underlying hardware can satisfy
  differently, never a specific implementation shared across targets. The
  same caution applies to RAM budgets (VIC-20 unexpanded has a little over
  5K total), screen geometry, and anything else that looks like a constant
  until the next machine breaks it.
- **Prefer compact semantic level/world storage over expanded display data.**
  Metatiles, repeated-object references, and procedural description usually
  beat storing a level at display resolution — but the right compressor
  depends on the data's shape and its decode cost against the frame budget,
  not on always reaching for one technique.
- **Randomness must be deterministic by default, explicitly seeded, with
  small fixed state.** Hardware entropy (a POKEY register, SID's oscillator
  3, timing jitter) belongs behind a separate, explicitly optional import —
  never as something a deterministic PRNG silently depends on.
- **Persistence is a capability, not an assumption baked into a machine
  name.** Whether a target can save depends on the cartridge/media profile,
  not the machine family (see the NES notes on this specifically).
- **Prefer clear integer/fixed-point source over hand-written assembly, and
  check the generated code before reaching for the latter.** The 6502 family
  has no hardware multiply/divide, which is the real reason to special-case
  those in frame-critical code — not a broader claim that the CPU is
  limited to a handful of operations.
- **Verify hardware facts before writing them into comments or docs.** This
  codebase already holds itself to this: see the COLBK/COLPF2 comment in
  `packages/atari8/src/index.8bs`, which records that it was corrected after
  being checked on screen under atari800, not left as an assumption. A
  lecture note or blog post recollection is a lead to verify, not a citation.
- **Don't promote one game's implementation trivia into an engineering rule
  or a compiler diagnostic.** A specific game's collision algorithm, PRNG
  choice, or ROM byte count is a good anecdote for prose and a bad thing to
  encode into the standard library or the compiler — it describes that game,
  not a hardware constraint every program on the target shares.

## Per-target rules

Machine-specific engineering rules live next to the target package they
describe, not here — this file only holds what's true across all of them.
Today that means [`packages/nes/AGENTS.md`](packages/nes/AGENTS.md) (a
machine with almost nothing, where abstraction is forced) and
[`packages/cx16/AGENTS.md`](packages/cx16/AGENTS.md) (a machine with a
great deal, all of it behind windows, ports, and firmware — where
abstraction keeps bank state, VERA state, and optional hardware out of
game code). If you're adding equivalent depth for another target, put it
at `packages/<target>/AGENTS.md` and link it from here.

## Documentation and workflow

For everything else — trunk-only workflow, running tests, adding a docs
page, front-matter and linking conventions, not presenting unimplemented
behaviour as working — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
