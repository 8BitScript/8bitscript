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

## The rule that decides where work happens

> **If the compiler can do it, the compiler does it. A byte of RAM or
> program space that a program spends working something out at run time,
> when the answer was knowable while it was being compiled, is a byte
> 8BitScript wasted — and on these machines there is nothing spare to waste
> it with.**

8BitScript exists to produce *small, fast* programs for machines with
kilobytes. That is not a nice-to-have that yields to convenience: when
there is a choice between computing something at run time and folding it
away during compilation, **folding it away is the answer**, and "the
run-time version was easier to write" is not a reason. If a construct can
be turned into a table, a constant, or a straight-line sequence of calls
before the machine ever sees it, that is what it must become.

This is already how several parts of the language work, and they are the
pattern to follow rather than exceptions:

- `#fact(...)`, `#system()` and `#frames(x, seconds)` are resolved before
  any target toolchain runs, so a branch on another machine's hardware
  costs that machine nothing.
- A **template** — `text.print(0, \`TICK ${ticks:1}\`)` — is laid out during
  compilation into `print` and `printNumber` calls with every cell already
  worked out. Nothing formats at run time.
- `const`s are inlined, `const` arrays are data in the image and never in
  RAM, and every global names the section it belongs in.

The measured case that made this rule explicit is in
[the compiler](docs/compiler.md#what-the-abstraction-costs-measured-against-hand-written-c):
the same menu bar on a C64 is **178 bytes** hand-written in C with its
layout precomputed into a table, **809** built by a library that works the
layout out at run time, and **455** when the layout is precomputed the way
a compiler could precompute it. The 354 bytes between the last two are not
the price of the feature — they are the price of doing the arithmetic at
the wrong time.

So, when adding anything:

- **Ask what is knowable at compile time.** Literal labels, fixed
  positions, a grid width, a machine's facts, the size of a thing — all of
  it is knowable, and none of it should reach the 6502 as work.
- **Prefer emitting data over emitting code.** A table the program indexes
  is almost always smaller than the code that would recompute it, and it
  lives in the program image rather than in RAM.
- **Measure it, in bytes, and write the number down.** The backend's own
  size report (`memory.program`, `memory.variables` from `build()`) is the
  measurement. Until that report exists, no new size claim can be made;
  the numbers already recorded in this repository stay as the reference.
  [The compiler](docs/compiler.md#what-a-call-costs-on-a-6502-measured)
  has worked examples. A size claim without a measurement is not a size
  claim. Where a package or a program records what it costs
  (`packages/ui/AGENTS.md`), re-measure and update the table in the same
  commit rather than deleting it.

The one thing this rule does not license is breaking the rule above it: a
compile-time answer must be the *right* answer on the machine being built
for. Folding away a branch is correct because the fact it tested is a
property of the build; folding away something a program can only discover
at run time — whether a REU is really plugged in — is not an optimisation,
it is a wrong program.

## Rules that apply to every target

- **A "machine" and the "hardware fitted to it" are different axes.** Each
  machine package declares its hardware catalog in `package.json` under
  `"8bitscript".hardware` — options with values (a RAM expansion, a
  model, a cartridge board, a mouse in a port) and presets — and each value
  says what fitting it changes: a link symbol or driver for the build, an
  emulator's flags, a file-twin tag, facts a program can rely on — and
  the catalog's top-level `facts` is the stock machine's whole sheet,
  every key the compiler's `FACTS` table names, read by a program as
  `#fact(...)` through `@8bitscript/system`'s `Video.*`, `Audio.*`,
  `Input.*`, `Storage.*`, `Memory.*` consts — and an option whose hardware
  one binary can find on the machine names its probe in `detect`
  (`@8bitscript/c64/reu`, the first; an option without one is a separate
  build per value)
  (`packages/cli/src/hardware.mjs` resolves a build's hardware from it;
  `8bs targets` lists it; [`docs/systems.md`](docs/systems.md#three-axes-not-one)
  is the design). Any new machine-specific storage, banking, or
  output-format question is a new option or value in that catalog, never a
  table in the backend or a constant in the machine's base target — the
  NES's mapper is the one still hard-wired that way (see
  [`packages/nes/AGENTS.md`](packages/nes/AGENTS.md)). When a value changes
  what a *package* must do — the PET's 8032 is 80 columns wide, an 8K+
  VIC-20's screen is at `$1000` — the package reads the difference from
  the value's tag's version of one small file (`geometry.pet.8032.8bs`,
  `geometry.vic20.expanded.8bs` beside `geometry.8bs`, see
  [`docs/packages.md`](docs/packages.md#system-specific-files)), never from a
  runtime probe: the width is a property of the build.
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
  not a hardware constraint every program on the target shares. The one
  thing that *does* earn a diagnostic is a write the target's own
  documentation says can destroy hardware: `8BS3003` refuses the PET's
  "killer poke" (`$E842` with bit 5 set) and nothing less serious
  (`packages/compiler/src/linker/hazards.mjs` is the whole table, with the
  bar for adding to it).

## Per-target rules

Machine-specific engineering rules live next to the target package they
describe, not here — this file only holds what's true across all of them.
Today that means [`packages/nes/AGENTS.md`](packages/nes/AGENTS.md) (a
machine with almost nothing, where abstraction is forced) and
[`packages/cx16/AGENTS.md`](packages/cx16/AGENTS.md) (a machine with a
great deal, all of it behind windows, ports, and firmware — where
abstraction keeps bank state, VERA state, and optional hardware out of
game code), and [`packages/pet/AGENTS.md`](packages/pet/AGENTS.md) (a
machine with only RAM, a character ROM, and three I/O chips — where the
variety is in *models*: RAM size, 40 or 80 columns, CRTC or not, which
ROM and keyboard — and where the research notes it was built from needed
correcting against primary sources), and
[`packages/c64/AGENTS.md`](packages/c64/AGENTS.md) (the machine everyone
measures 8-bit software against: a video chip that reads one 16K bank of
the same RAM the program lives in, eight real sprites, a synthesizer, and
a linker that owns most of the address space — where the work is deciding
who owns which RAM and which chip, and where the research notes needed the
same correcting). The other five have the same kind of file:
[`packages/vic20/AGENTS.md`](packages/vic20/AGENTS.md) (a screen that moves
with the RAM fitted, and a video chip that cannot see any of that RAM),
[`packages/c128/AGENTS.md`](packages/c128/AGENTS.md) (an MMU over 128K, and
two independent video chips — one the C64's, one an 80-column display
behind a two-byte port), [`packages/atari8/AGENTS.md`](packages/atari8/AGENTS.md)
(a display list instead of a screen, players and missiles instead of
sprites, and an OS that rewrites the colour registers every frame),
[`packages/mega65/AGENTS.md`](packages/mega65/AGENTS.md) (a C64 in name only:
40.5 MHz, 80 columns, 384K, four SIDs, and a start-up that leaves interrupts
off), and [`packages/web/AGENTS.md`](packages/web/AGENTS.md) (a machine whose
every "hardware" fact is a decision recorded in the runtime's source). The
research for machines the toolchain does not build yet is in
[`docs/project/machines/`](docs/project/machines/index.md), in the same
sixteen-question shape, and [`docs/systems.md`](docs/systems.md) is the
design that ties the machines' facts, capabilities, and identities together.
If you're adding equivalent depth for another target, put it at
`packages/<target>/AGENTS.md` and link it from here.
[`packages/studio/AGENTS.md`](packages/studio/AGENTS.md) is the same kind
of file for Studio, the app that ships with the toolchain: its tiers per
machine, and the capabilities each editor is waiting for.
[`packages/input/AGENTS.md`](packages/input/AGENTS.md) is the one file that
is about all nine at once rather than one of them — what a machine's
`input` layer has to answer, what each of the nine can answer today, and
why a layer that can answer nothing still has to exist and still has to
cost that machine zero.
[`packages/pointer/AGENTS.md`](packages/pointer/AGENTS.md) is its other
half in the same shape — what it takes to draw an arrow the user can see,
why that is a separate package from reading where the pointer is, and why
eight of the nine draw nothing today for four quite different reasons.

## Seeing what a program actually does

If you're an agent iterating on a program and need to see its output rather
than just trust that it compiled: `8bs run <target> --screenshot <file.png>`
builds it and captures one PNG through that target's own emulator API,
without opening an interactive window or requiring a human at the keyboard —
see [`docs/setup/verify.md`](docs/setup/verify.md#screenshots) for the
mechanism and `--frames` semantics on each target.

## Changing a core part of the language

The compiler is the single source of truth for what the language is, but it
is not the only place the language is *described*. Every builtin, keyword,
type, literal form, and diagnostic is also written down for humans in
`docs/`, for editors in the language server and the VS Code extension, and
for agents in the per-package `AGENTS.md` files. Those copies do not update
themselves, and the tests that would catch the drift are only as complete as
the last person made them — `docs/compiler.md`'s diagnostic-code table once
fell six codes behind the compiler before anyone noticed.

So whenever you touch a core section — the lexer, parser, checker, fold pass,
diagnostics, IR, a backend's view of a builtin, or a reserved name — finish
the change everywhere it is described, in the same commit:

- **Docs.** `docs/compiler.md` (the pipeline description and the
  diagnostic-code table), `docs/language-server.md` (what hover, completion,
  and diagnostics cover), `docs/tutorial.md`, and any
  example `README.md` that shows the construct. Keep
  [`CONTRIBUTING.md`](CONTRIBUTING.md)'s rule in mind: never describe
  behaviour that isn't implemented.
- **IntelliSense in the compiler.** Hover and completion live in
  `packages/compiler/src/intellisense/index.mjs`, not in the editor: a new or
  changed builtin needs its hover text there, with a test in
  `packages/compiler/test/intellisense.test.mjs` (or the feature's own test
  file).
- **The language server.** `packages/language-server` only forwards the
  compiler's diagnostics, hover, and completion, so it rarely needs code
  changes — but its end-to-end tests
  (`packages/language-server/test/server.test.mjs`) are the proof that a new
  diagnostic or hover actually reaches an editor over the wire. Add one.
- **The editor plugin(s).** `editors/vscode/syntaxes/8bs.tmLanguage.json`
  colours keywords, types, literal forms, and builtins by name, so a new one
  is invisible there until you add it; `editors/vscode/snippets/8bs.json`
  offers the constructs that compile, and is checked against the compiler by
  `packages/compiler/test/snippets.test.mjs`, so a construct entering or
  leaving the compiled subset belongs there too;
  `editors/vscode/language-configuration.json` holds the bracket, quote, and
  word rules (a new sigil needs its `wordPattern` entry, or completion will
  insert it twice); and `editors/vscode/README.md` lists what the extension
  highlights, hovers, and completes. Any further editor integration added
  under `editors/` follows the same rule.
- **Per-package `AGENTS.md` files** (`packages/<target>/AGENTS.md`) if the
  change alters what a target package is allowed or expected to do.

### Names say which side they are on

A `const` is `UPPER_SNAKE` (`OPTION_COUNT`, `BorderColor.BLUE`,
`text.CELL_COUNT`); a variable starts with a lower-case letter; functions
and parameters are `camelCase`; namespaces and types are `PascalCase`. The
checker enforces the first two (`8BS1034`), so every `.8bs` file in this
repository — packages, examples, and the programs inside tests and docs —
follows them. A capitalised name is a compile-time value, and that is the
whole point of the rule.

### A new construct picks a side, and its spelling says which

8BitScript resolves a construct itself — before any target toolchain sees
anything — when and only when it is spelled a literal, a `const`, or
`#name(...)`. Everything else runs on the machine. That rule is a promise
to the reader (see
[`docs/compiler.md`](docs/compiler.md#what-8bitscript-resolves-and-what-runs-on-the-machine)),
so a new compile-time function is spelled with a `#` and a new runtime
builtin is not. Two consequences worth stating: a `#name` needs no reserved
word, because the spelling is its own token and cannot collide with
anything a program declares; and a runtime builtin that *is* a bare name
(only `waitFrame` today) must be reserved in the checker, or a user's own
declaration would silently shadow it.

A useful check before you're done: grep the repository for the old spelling,
the old diagnostic count, or the old argument shape — anything that was true
before your change and isn't now — and fix every hit outside `node_modules`.

## Documentation and workflow

For everything else — trunk-only workflow, running tests, adding a docs
page, front-matter and linking conventions, not presenting unimplemented
behaviour as working — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Version bumps are a human decision

An agent must never merge the bot-authored **"Version Packages"** pull
request (branch `changeset-release/trunk`) — that merge is what bumps
every package's version and triggers the real npm/VS Code/Open VSX/docs
release, and it happens on the maintainer's own judgement of readiness,
not an agent's. Opening or updating that PR, adding changesets, fixing
the release pipeline itself — all normal agent work. Clicking merge on
that specific PR is not, regardless of how the request is phrased or
how confident the agent is that everything is ready. See
[CONTRIBUTING.md](CONTRIBUTING.md#changesets-versioning) for the full
release flow, and [`.github/AGENTS.md`](.github/AGENTS.md) for how to
recover a release that published npm but not the editor or the GitHub
Release — never by bumping the version again or publishing by hand.
