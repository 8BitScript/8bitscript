# @8bitscript/cli

## 0.23.2

### Patch Changes

- Updated dependencies [7027388]
- Updated dependencies [4376f27]
- Updated dependencies [5a21549]
- Updated dependencies [697766e]
  - @8bitscript/examples@0.23.2
  - @8bitscript/compiler@0.23.2
  - @8bitscript/pet@0.23.2
  - @8bitscript/vic20@0.23.2
  - @8bitscript/language-server@0.23.2
  - @8bitscript/studio@0.23.2
  - @8bitscript/atari8@0.23.2
  - @8bitscript/c128@0.23.2
  - @8bitscript/c64@0.23.2
  - @8bitscript/cx16@0.23.2
  - @8bitscript/mega65@0.23.2
  - @8bitscript/nes@0.23.2
  - @8bitscript/web@0.23.2

## 0.23.1

### Patch Changes

- 6a26f13: Spawn ffmpeg, target emulators, and the system browser opener by absolute path, and verify Studio webview message origins in the listener.
- @8bitscript/compiler@0.23.1
  - @8bitscript/language-server@0.23.1
  - @8bitscript/atari8@0.23.1
  - @8bitscript/c128@0.23.1
  - @8bitscript/c64@0.23.1
  - @8bitscript/cx16@0.23.1
  - @8bitscript/examples@0.23.1
  - @8bitscript/mega65@0.23.1
  - @8bitscript/nes@0.23.1
  - @8bitscript/pet@0.23.1
  - @8bitscript/studio@0.23.1
  - @8bitscript/vic20@0.23.1
  - @8bitscript/web@0.23.1

## 0.23.0

### Minor Changes

- 499c62d: Doctor offers every emulator it can install by default (`--want` to narrow, `--install` to skip the prompt). VS Code groups machines by family and has a Doctor panel (`8bitscript.doctorEmulators`, default all) with Install selected.
- 499c62d: Narrow `RELEASE_MACHINES` to five targets — `pet`, `vic20`, `c64`, `cx16`, and `web` — so `8bs build` and `8bs run`, examples, Studio, and the editor launcher focus on a polished slice. Every other id stays in `MACHINES` for twins, facts, and `8bs check`; hello-world still compiles. Restoring the original nine and the remaining roadmap machines to `RELEASE_MACHINES` is planned in a follow-up (see `.changeset/remaining-systems.md` for the wider emulator and package work).
- 499c62d: Emulators are optional: doctor WARNs when one is missing, machine catalogs name title/binary/screenshot, VS Code greys Run/Boot from `8bs doctor --json`, and `8bs setup cx16`/`mega65` have an apt path on Ubuntu.
- 499c62d: Add a portable graphics and audio slice: `.8bg` / `.8ba` front ends, PNG and WAV/FLAC host tools, machine-owned lowering on C64, NES, PET, and Atari 8-bit with a glyph/no-driver fallback everywhere else, and a dogfood example that builds for every machine.
- 499c62d: Land the remaining roadmap machines: MOS packages (Plus/4 through Atari 7800), SM83/Z80/6809/8048/F8 backends, `port.read`/`port.write`, and catalog-driven emulators. Hello-world compiles for every `RELEASE_MACHINES` id; `8bs run plus4` is VICE; the other remaining machines are deferred pending emulator setup. `--screenshot` still captures on those machines (VICE, MAME `-str`, openMSX Tcl, or macOS window capture); a missing emulator or ROM set fails the capture. New ids use RetroArch-style shorts (`gb`, `gbc`, `pce`, `spectrum`); Atari consoles stay `atari2600`, `atari5200`, `atari7800`; `gamegear` stays.

### Patch Changes

- 7232d3f: Widen VIC-20 zero-page to the owned budget when a linked program calls `screen.blank()`, so title screens and media clears link without overrunning the polite KERNAL window.
- Updated dependencies [499c62d]
- Updated dependencies [499c62d]
- Updated dependencies [499c62d]
- Updated dependencies [499c62d]
- Updated dependencies [7232d3f]
  - @8bitscript/compiler@0.23.0
  - @8bitscript/examples@0.23.0
  - @8bitscript/studio@0.23.0
  - @8bitscript/pet@0.23.0
  - @8bitscript/c64@0.23.0
  - @8bitscript/vic20@0.23.0
  - @8bitscript/cx16@0.23.0
  - @8bitscript/web@0.23.0
  - @8bitscript/language-server@0.23.0
  - @8bitscript/nes@0.23.0
  - @8bitscript/atari8@0.23.0
  - @8bitscript/plus4@0.23.0
  - @8bitscript/oric@0.23.0
  - @8bitscript/apple2@0.23.0
  - @8bitscript/bbc@0.23.0
  - @8bitscript/atari5200@0.23.0
  - @8bitscript/lynx@0.23.0
  - @8bitscript/pce@0.23.0
  - @8bitscript/supervision@0.23.0
  - @8bitscript/atari2600@0.23.0
  - @8bitscript/atari7800@0.23.0
  - @8bitscript/gb@0.23.0
  - @8bitscript/gbc@0.23.0
  - @8bitscript/sms@0.23.0
  - @8bitscript/gamegear@0.23.0
  - @8bitscript/sg1000@0.23.0
  - @8bitscript/msx@0.23.0
  - @8bitscript/coleco@0.23.0
  - @8bitscript/spectrum@0.23.0
  - @8bitscript/cpc@0.23.0
  - @8bitscript/coco@0.23.0
  - @8bitscript/vectrex@0.23.0
  - @8bitscript/odyssey2@0.23.0
  - @8bitscript/channelf@0.23.0
  - @8bitscript/c128@0.23.0
  - @8bitscript/mega65@0.23.0

## 0.22.1

### Patch Changes

- de4cf1f: The Atari 7800 is on the roadmap at phase 6. `8bs targets --reach` reports that phase instead of leaving the machine unplanned.
- @8bitscript/atari8@0.22.1
  - @8bitscript/c128@0.22.1
  - @8bitscript/c64@0.22.1
  - @8bitscript/compiler@0.22.1
  - @8bitscript/cx16@0.22.1
  - @8bitscript/examples@0.22.1
  - @8bitscript/language-server@0.22.1
  - @8bitscript/mega65@0.22.1
  - @8bitscript/nes@0.22.1
  - @8bitscript/pet@0.22.1
  - @8bitscript/studio@0.22.1
  - @8bitscript/vic20@0.22.1
  - @8bitscript/web@0.22.1

## 0.22.0

### Minor Changes

- 8796c08: The web 8×8 font has quarter-circle corner masks at codes 144–147 (top-left, top-right, bottom-left, bottom-right). Under reverse video the host punches the curve out, so a tile corner reads as a rounded corner rather than a quadrant chamfer. 148 up to the copyright glyph stays blank.

### Patch Changes

- Updated dependencies [8796c08]
  - @8bitscript/web@0.22.0
  - @8bitscript/examples@0.22.0
  - @8bitscript/studio@0.22.0
  - @8bitscript/compiler@0.22.0
  - @8bitscript/atari8@0.22.0
  - @8bitscript/c128@0.22.0
  - @8bitscript/c64@0.22.0
  - @8bitscript/cx16@0.22.0
  - @8bitscript/language-server@0.22.0
  - @8bitscript/mega65@0.22.0
  - @8bitscript/nes@0.22.0
  - @8bitscript/pet@0.22.0
  - @8bitscript/vic20@0.22.0

## 0.21.0

### Minor Changes

- 4c3f70f: `8bs run cx16 --web` runs the program in the browser's x16emu: the WebAssembly build X16Community ships with each release, pinned (r49) by URL and SHA-256, downloaded into the user's cache on first use — no Emscripten, no sudo — and served from loopback with the freshly built `.prg`. The page passes the emulator the same flags as the native window (the catalog's `run.x16emu`, the controller's, `-prg … -run`), so a program behaves the same in a tab as in a window. In the tab the mouse is the browser's Pointer Lock: a click on the screen takes it, Esc gives it back. `--no-open` and `--port` apply; the URL lands in `dist/.8bs-last-cx16.json` for the editor's Running machines tree. Studio gains `pnpm start:cx16-web`.
- af452e9: `8bs targets --reach`: every machine — the eight that build and the seventeen with no package yet — against the project's `requires` and its new `input: { primary, also }`, with the file `8bs build` writes and the routes it reaches, and who is out there to run it: units sold, interest in 2025, releases a year, new hardware on sale. The figures are the reach sheet, `packages/cli/data/reach.json` — research, dated and sourced, never read by a build (docs/project/reach.md).

### Patch Changes

- a9d7596: The VS Code launcher passes `--capture-mouse` and `--fullscreen` on native Commander X16 runs and boots by default (`8bitscript.cx16.captureMouse` and `8bitscript.cx16.fullscreen` in Settings). Studio in a tab is unchanged. The CLI accepts the same flags for `8bs run cx16` and `8bs boot cx16`; a terminal launch without them still starts with a free mouse and a window.
- d7b930a: `8bs run cx16` starts x16emu with your mouse free again (no `-capture`): the pointer can leave the window for the editor, and ⇧⌘M (Ctrl+M on Linux/Windows) captures it when tracking has to be exact — a click never does, so the launch says so once. Uncaptured tracking drifts a little; in use it is good enough, and the free pointer is worth more.
- Updated dependencies [9692ca7]
- Updated dependencies [d7b930a]
- Updated dependencies [4c3f70f]
- Updated dependencies [65829bd]
- Updated dependencies [d8bff18]
- Updated dependencies [38c8dfc]
  - @8bitscript/cx16@0.21.0
  - @8bitscript/studio@0.21.0
  - @8bitscript/compiler@0.21.0
  - @8bitscript/language-server@0.21.0
  - @8bitscript/examples@0.21.0
  - @8bitscript/atari8@0.21.0
  - @8bitscript/c128@0.21.0
  - @8bitscript/c64@0.21.0
  - @8bitscript/mega65@0.21.0
  - @8bitscript/nes@0.21.0
  - @8bitscript/pet@0.21.0
  - @8bitscript/vic20@0.21.0
  - @8bitscript/web@0.21.0

## 0.20.0

### Minor Changes

- d661455: `input.keyboard()` on the web: whether the host has anything to press arrows on. The page writes a second bit into the `HOST_OFFSET` byte, `NO_KEYBOARD`, set on a touch host whose pointer cannot hover (`(hover: none)` — a phone, or a tablet in the hands) and cleared for good by the first trusted key it sees from outside a form field (an iPad on a keyboard folio gets its keyboard back at its first arrow). Zero stays a desktop with a mouse and a keyboard, so `--screenshot` PNGs keep the desktop layout. A program that names its controls reads `keyboard()` when it prints, next to `touch()`: SWIPE on a phone, SWIPE OR ARROWS on a touchscreen laptop, ARROWS on a desktop. `hostHasKeyboard()` and `hostStatusByte()` in `web-layout.mjs` are the tested rule; `Input.KEYBOARD` from `@8bitscript/system` is still the build's fact.

### Patch Changes

- Updated dependencies [d661455]
  - @8bitscript/web@0.20.0
  - @8bitscript/examples@0.20.0
  - @8bitscript/studio@0.20.0
  - @8bitscript/compiler@0.20.0
  - @8bitscript/atari8@0.20.0
  - @8bitscript/c128@0.20.0
  - @8bitscript/c64@0.20.0
  - @8bitscript/cx16@0.20.0
  - @8bitscript/language-server@0.20.0
  - @8bitscript/mega65@0.20.0
  - @8bitscript/nes@0.20.0
  - @8bitscript/pet@0.20.0
  - @8bitscript/vic20@0.20.0

## 0.19.1

### Patch Changes

- @8bitscript/examples@0.19.1
  - @8bitscript/atari8@0.19.1
  - @8bitscript/c128@0.19.1
  - @8bitscript/c64@0.19.1
  - @8bitscript/compiler@0.19.1
  - @8bitscript/cx16@0.19.1
  - @8bitscript/language-server@0.19.1
  - @8bitscript/mega65@0.19.1
  - @8bitscript/nes@0.19.1
  - @8bitscript/pet@0.19.1
  - @8bitscript/studio@0.19.1
  - @8bitscript/vic20@0.19.1
  - @8bitscript/web@0.19.1

## 0.19.0

### Minor Changes

- dcb09eb: `baseline` in 8bitscript.config.ts: the system a program is designed on — the build every fact the program tests is true on, where `requires` is the floor every build clears (docs/project/baseline.md, docs/config.md). A machine's name (`'c64'`, under the project's own hardware for it), a name from `systems`, or a system's shape. `8bs build` and `8bs run` with no target build it; `8bs targets` names it ("This program is designed on"), and `--json` carries it with its resolved sheet; `8bs build --release` prints, after every artifact, how it stands to the baseline — `the baseline`, `level with the baseline (c64)`, or `short of the baseline (c64): video.palette 2 of 16, video.raster, memory.ram 3071 of 51199`. Only the facts the program's own files test are counted: the linker records every `#fact(key)` a project file spells and every `Video.*`/`Memory.*`/… const it reads from `@8bitscript/system` (`factsTested` on `link()`'s result; a package's own fact reads are the package's business), and `shortOfBaseline(baseline, facts)` in the compiler is the comparison. A baseline below the program's `requires` is refused as a config mistake. The builds that are not the baseline are called builds — the note says why not ports, tiers or editions.
  
  Also: `8bs build --release --checkout <dir>` honours the checkout. It returned into the release before the flag was read, so every artifact came from node_modules and nothing said so.

### Patch Changes

- Updated dependencies [dcb09eb]
  - @8bitscript/compiler@0.19.0
  - @8bitscript/language-server@0.19.0
  - @8bitscript/atari8@0.19.0
  - @8bitscript/c128@0.19.0
  - @8bitscript/c64@0.19.0
  - @8bitscript/cx16@0.19.0
  - @8bitscript/examples@0.19.0
  - @8bitscript/mega65@0.19.0
  - @8bitscript/nes@0.19.0
  - @8bitscript/pet@0.19.0
  - @8bitscript/studio@0.19.0
  - @8bitscript/vic20@0.19.0
  - @8bitscript/web@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [aa3fd8e]
- Updated dependencies [63b1906]
- Updated dependencies [63b1906]
  - @8bitscript/c64@0.18.0
  - @8bitscript/compiler@0.18.0
  - @8bitscript/vic20@0.18.0
  - @8bitscript/pet@0.18.0
  - @8bitscript/c128@0.18.0
  - @8bitscript/atari8@0.18.0
  - @8bitscript/nes@0.18.0
  - @8bitscript/cx16@0.18.0
  - @8bitscript/mega65@0.18.0
  - @8bitscript/web@0.18.0
  - @8bitscript/examples@0.18.0
  - @8bitscript/language-server@0.18.0
  - @8bitscript/studio@0.18.0

## 0.17.0

### Patch Changes

- @8bitscript/atari8@0.17.0
  - @8bitscript/c128@0.17.0
  - @8bitscript/c64@0.17.0
  - @8bitscript/compiler@0.17.0
  - @8bitscript/cx16@0.17.0
  - @8bitscript/examples@0.17.0
  - @8bitscript/language-server@0.17.0
  - @8bitscript/mega65@0.17.0
  - @8bitscript/nes@0.17.0
  - @8bitscript/pet@0.17.0
  - @8bitscript/studio@0.17.0
  - @8bitscript/vic20@0.17.0
  - @8bitscript/web@0.17.0

## 0.16.0

### Patch Changes

- 592197a: Atari 8-bit builds can opt into ANTIC 6 (`textmode=gr1`): 20 columns and four playfield colors per character, so `text.setColor` is real instead of an empty stub. Stock GR.0 is unchanged.
- b6dbbbb: `8bs doctor` offers to install pnpm (`npx get-pnpm`) and to run `8bs setup cx16` / `8bs setup mega65` for the source-built emulators. The editor finds pnpm where the installer actually puts it — including `~/Library/pnpm` on macOS — and offers **Run Doctor** instead of lecturing about `.zshrc`.
- Updated dependencies [592197a]
- Updated dependencies [46e9791]
  - @8bitscript/atari8@0.16.0
  - @8bitscript/compiler@0.16.0
  - @8bitscript/mega65@0.16.0
  - @8bitscript/language-server@0.16.0
  - @8bitscript/studio@0.16.0
  - @8bitscript/examples@0.16.0
  - @8bitscript/c128@0.16.0
  - @8bitscript/c64@0.16.0
  - @8bitscript/cx16@0.16.0
  - @8bitscript/nes@0.16.0
  - @8bitscript/pet@0.16.0
  - @8bitscript/vic20@0.16.0
  - @8bitscript/web@0.16.0

## 0.15.0

### Minor Changes

- 758765d: Add project message catalogs (`src/i18n/<locale>.8bs`, imported as `@8bitscript/i18n/catalog`), compile-time `i18n.format`, Latin transliteration into the portable set, and `Input.CONFIRM_LABEL` on each machine's input layer. One locale still means one binary; projects without catalogs are unchanged.
- ae09eab: Add project `imports` in `8bitscript.config.ts` so specifiers like `@lib/game/rules.8bs` map to directories under the project. Wired through `8bs build`, `8bs check`, and the language server.
- 5d6dc92: Native builds can now retain source provenance through lowering, assembly, and branch relaxation, and `8bs build --debug` writes a human-readable `.lst` listing and a versioned `.8bs.debug.json` debug map alongside the artifact. The VS Code extension adds "8BitScript: View Generated Assembly", which opens the generated instructions for the file beside the editor and navigates back to source on selection. Off by default; release builds are unaffected.

### Patch Changes

- f063fcf: Cleared every open SonarCloud finding that was failing trunk's quality gate after 0.14.x:
  
  - Two MINOR code smells (`javascript:S7737`, object-literal default parameters) in the IntelliSense module's `hoverAt()`/`completionsAt()` — both now default to one shared, frozen `NO_MACHINE` constant instead of a fresh literal.
  - Three CRITICAL reliability bugs (`javascript:S2871`, sorting strings with no explicit compare function) in `discoverCatalogLocales()` (cli and compiler) and the i18n module's dead `schemaKeys()` helper. The two `discoverCatalogLocales()` sorts now use the same explicit ordinal comparator `packages/compiler/src/mos/debug.ts` already established for this exact reason — this order feeds build output and must not depend on the host's locale, so `localeCompare` (Sonar's own default suggestion) would have been the wrong fix. `schemaKeys()` was unused since the PR that added it and is deleted rather than patched.
  
  Also fixes a real bug found while resolving the object-literal defaults above: hover and completion for an imported namespace's member (`screen.blank`) inside a template string's `${...}` field (`` `Score: ${screen.blank()}` ``) silently answered nothing. The recursive re-lex that handles a template field's own contents was passing its small, freshly re-lexed token slice to the import-resolution lookup too, which needs the *whole* file's tokens to find the original `import` statement — a handful of tokens with no `import` in them can never resolve one. Both `hoverAt()` and `completionsAt()` now carry the outer file's token stream through the recursion (`outerTokens`) separately from the token slice used to find the cursor's own position, and use whichever one each job actually needs.
- Updated dependencies [758765d]
- Updated dependencies [f063fcf]
- Updated dependencies [ae09eab]
- Updated dependencies [5d6dc92]
  - @8bitscript/compiler@0.15.0
  - @8bitscript/language-server@0.15.0
  - @8bitscript/pet@0.15.0
  - @8bitscript/vic20@0.15.0
  - @8bitscript/c64@0.15.0
  - @8bitscript/c128@0.15.0
  - @8bitscript/atari8@0.15.0
  - @8bitscript/nes@0.15.0
  - @8bitscript/cx16@0.15.0
  - @8bitscript/mega65@0.15.0
  - @8bitscript/web@0.15.0
  - @8bitscript/examples@0.15.0
  - @8bitscript/studio@0.15.0

## 0.14.0

### Patch Changes

- @8bitscript/atari8@0.14.0
  - @8bitscript/c128@0.14.0
  - @8bitscript/c64@0.14.0
  - @8bitscript/compiler@0.14.0
  - @8bitscript/cx16@0.14.0
  - @8bitscript/examples@0.14.0
  - @8bitscript/language-server@0.14.0
  - @8bitscript/mega65@0.14.0
  - @8bitscript/nes@0.14.0
  - @8bitscript/pet@0.14.0
  - @8bitscript/studio@0.14.0
  - @8bitscript/vic20@0.14.0
  - @8bitscript/web@0.14.0

## 0.13.1

### Patch Changes

- Updated dependencies [3094830]
  - @8bitscript/compiler@0.13.1
  - @8bitscript/language-server@0.13.1
  - @8bitscript/atari8@0.13.1
  - @8bitscript/c128@0.13.1
  - @8bitscript/c64@0.13.1
  - @8bitscript/cx16@0.13.1
  - @8bitscript/examples@0.13.1
  - @8bitscript/mega65@0.13.1
  - @8bitscript/nes@0.13.1
  - @8bitscript/pet@0.13.1
  - @8bitscript/studio@0.13.1
  - @8bitscript/vic20@0.13.1
  - @8bitscript/web@0.13.1

## 0.13.0

### Minor Changes

- 7577c5e: `#package("version")` and `#package("name")`: a program reads its own
  package.json at compile time, as a string literal — the nearest package.json
  above the file, resolved the same way by `8bs build`, `8bs check` and the
  editor — so a title screen prints the version the package was published
  as, and a build with it is byte-identical to one with the string written
  by hand. Any other field is refused by name (`8BS1041`); a missing or
  unparseable package.json, or one without the field, is `8BS1042` naming
  the file.

### Patch Changes

- ceda09a: SonarCloud's quality gate on trunk was failing on Reliability of New Code
  (C, needs A): super-linear regexes, a thenable-looking IR `then` field,
  always-false `===` checks, a loop that could only run once, and a handful
  of related smells. The regexes are now ordinary scans, the IR field is
  named where it stands with the same NOSONAR the rest of the compiler
  already uses, and the rest of the findings are the same behaviour without
  the pattern the gate was scoring.
- Updated dependencies [82f0cda]
- Updated dependencies [ceda09a]
  - @8bitscript/language-server@0.13.0
  - @8bitscript/compiler@0.13.0
  - @8bitscript/atari8@0.13.0
  - @8bitscript/c128@0.13.0
  - @8bitscript/c64@0.13.0
  - @8bitscript/cx16@0.13.0
  - @8bitscript/examples@0.13.0
  - @8bitscript/mega65@0.13.0
  - @8bitscript/nes@0.13.0
  - @8bitscript/pet@0.13.0
  - @8bitscript/studio@0.13.0
  - @8bitscript/vic20@0.13.0
  - @8bitscript/web@0.13.0

## 0.12.0

### Minor Changes

- b1b08fb: A locale is a build input. `strings.de.8bs` beside `strings.8bs` is the
  German version, `strings.pet.de.8bs` the German version of the PET's twin,
  `strings.pet.8032.de.8bs` of the 8032's — the locale is the innermost twin
  dimension, always the last word before the extension, for `.8bx` files
  too. It refines the machine choice and never changes it: whichever level a
  build would take without a locale, it takes that level's `.<locale>` file
  when one exists; a machine twin with no version in the locale is used and
  said (`8BS3005`, a warning) when the plain file has one. A build that names
  no locale reads no locale's file, so every existing project builds and
  names exactly as before.
  
  `locale` in `8bitscript.config.ts` (project-wide, per target, or in a
  `release` entry — `release: [{}, { locale: 'de' }]` builds both), and
  `8bs build --locale de` / `8bs run --locale de` over all of them. A name is
  two to eight lower-case letters with an optional `-region` (`de`, `pt-br`),
  never a machine's name or one of its hardware tags. The artifact carries it
  — `2048-pet-de.prg`, `program-de.wasm` beside `program.wasm` in `dist/web`
  — only when one is set. `#locale("de")` folds to `true` in that build and
  `false` in every other, and in one that names none (`8BS1040` for anything
  but one name in quotes).
  
  Not in this release: a compile-time conversion of a string literal to a
  machine's screen codes, so a machine whose strings are pre-converted by
  hand (the size-fitted PET) still wants a `strings.pet.<locale>.8bs` per
  locale.

### Patch Changes

- 605b346: docs: the language manual and the 8BX specification live in the repo.
  
  `docs/language/` is the manual — the language by task, nine pages:
  hello world both ways, the core `.8bs` language, `.8bx` composition
  (elements, components, `<slot />`, conditional composition, state,
  methods, the purity rule), the `.8bs` ↔ `.8bx` boundary, project config
  and the CLI, the editor and every `8BS` diagnostic code, the standard
  packages, two worked examples with their measured byte counts, and the
  one list of what is not built yet. `docs/spec/8bx.md` is the 8BX
  specification itself, all 142 sections, cited from the other pages as
  `§N`. `docs/project/8bx.md` becomes the ledger between them: the spec's
  PR sequence as it landed (#159–#177, 2048 #46), the rules code enforces,
  and where the code and the spec still differ. The home page says what
  0.11.0 is instead of what 0.2.0 was, and nothing on the site links out
  to an artifact for its own documentation any more.
  
  Two claims corrected against the code on the way in: there is no
  "children required" diagnostic — the `.8bs` call form of a slotted
  component is its body with the slot elided — and the CLI table now lists
  `8bs boot`, `8bs setup` and `8bs controller`.
- eebccb4: docs: the 8BX ledger records that forwarders are free (#178, #184) and the
  compiler findings from 2048's restructure into `ui/` elements over `lib/`;
  the manual's "not yet available" page drops the forwarder row.
- Updated dependencies [a0f9493]
- Updated dependencies [3d33043]
- Updated dependencies [6597363]
- Updated dependencies [922ec1f]
  - @8bitscript/compiler@0.12.0
  - @8bitscript/web@0.12.0
  - @8bitscript/language-server@0.12.0
  - @8bitscript/examples@0.12.0
  - @8bitscript/studio@0.12.0
  - @8bitscript/atari8@0.12.0
  - @8bitscript/c128@0.12.0
  - @8bitscript/c64@0.12.0
  - @8bitscript/cx16@0.12.0
  - @8bitscript/mega65@0.12.0
  - @8bitscript/nes@0.12.0
  - @8bitscript/pet@0.12.0
  - @8bitscript/vic20@0.12.0

## 0.11.0

### Minor Changes

- 660b8c0: 8BX (`.8bx`): a `component` declaration that elaborates to a plain call
  before any backend sees it, so a declarative element (`<Foo bar={baz} />`)
  costs exactly what writing `foo(baz)` by hand would cost — measured
  byte-identical on the PET in the new `hello-bx` example (108 bytes, same as
  `hello-world`).
  
  The front end grows a binder (`packages/compiler/src/binder`) that resolves
  symbols and scopes ahead of the checker, and a `bx/` pass
  (`check.mjs`, `elaborate.mjs`, `parse.mjs`) that parses element syntax at
  statement boundaries — `<`, `<<` and the rest of the operator grammar are
  unchanged in either source kind — checks it, then elaborates it into the
  core AST the checker, folder and every backend already understand.
  `analyze()`, `link()` and the language server all run binding and BX
  elaboration before folding and checking, for both `.8bs` and `.8bx` files.
  
  Also: a conditional expression (`cond ? a : b`) lowers to real branching
  IR and MOS instruction selection, editor support for `.8bx` (grammar,
  language registration, activation), and `docs/compiler.md`, which replaces
  the `8bx` design-direction doc with a description of the pipeline as
  built.
  
  Not in this release: array-typed component props, and no backend beyond
  mos/wasm has been asked to prove elaboration is free — only the PET and
  web are measured.
- 9ad0106: A program starts from a `.8bs` file. `8bs build` refuses an `.8bx` entry
  by name — an `.8bx` declares composition, and a program reaches its
  components by importing them and calling them: `Hello();` is `<Hello />`
  the way `.8bs` can spell it, and is checked as any call is. `hello-bx`
  is split accordingly: `src/hello-bx.8bs` is the program, `src/Hello.8bx`
  the component, and its PET build is still byte-identical to
  `hello-world`'s.
- fb4cf62: `.8bs` is code, `.8bx` is composition. `asm6502` is refused in an `.8bx`
  file (`8BS2020`): machine code lives in a `.8bs` function the component
  imports. A top-level function that composes nothing, or a top-level
  `let`, in an `.8bx` is a warning (`8BS2021`) that `bx: { strict: false }`
  in `8bitscript.config.ts` switches off; component methods and state, and
  anything inside `{…}`, are never linted.
  
  A warning now reports and rides along: the linker and `8bs build` stop
  for errors only, where before any diagnostic — an inexact `#frames()`
  duration included — stopped a build.
- d1ab357: 8BX components keep state. `state count: utinyint = 0;` at the top of a
  component body is storage per static instance: every element — and every
  call from `.8bs` — is an instance with its own copy of the function and
  its own globals, laid out at compile time and named after the instance
  (`__bx_Counter__count__i1`), the template dropped, and a stateless
  component that contains a stateful one instanced per site too, so two
  `<Pair />` holding a `<Tally />` are four tallies. The two halves of a
  slotted component share one instance. Nothing is allocated at run time;
  `8bs build --size` lists every instance and the bytes of state it holds.
  `state` belongs at the top of a component body, typed, once per name,
  unshadowed (`8BS2022`); the initializer is a literal or a const, as for
  any global. Component methods and arrays of state are later.
- 6154194: `8bitscript.config.ts` learns its own shape, and a project can build more
  than one program.
  
  - `import { defineConfig } from '@8bitscript/cli'` types the config
    (`src/index.d.ts`; `schemas/config.json` is the same shape as a JSON
    schema). A plain `export default { … }` is still a config.
  - `programs: { main: { entry }, format: { entry, targets?, requires? } }`
    — each its own build from its own `.8bs` entry, the key its output stem
    (`dist/format-c64-ntsc.prg`, `dist/web/format/`). `entry: 'src/main.8bs'`
    still works and means `programs: { main: { entry } }` with the entry's
    filename as the stem, so no existing `dist/` name moves. An `.8bx` entry
    is refused by name: a program starts from `.8bs`. `--program <name>` on
    `8bs build` and `8bs run`; `--release` builds every program for the
    targets it lists; `8bs targets` lists them and `--json` carries them;
    the last-run file records which program ran.
  - `images: { name: { target, format, boot, files } }` — disk images over
    the programs, validated by every build and named by `--release`, which
    says plainly that it does not write them yet.
  - `bx: { strict }` is accepted, for the 8BX lint that lands with the
    grammar.
  - The editor's project reader understands a `programs` block, so "the"
    program is `main`'s entry and the others are listed beside it.

### Patch Changes

- 86649ac: On the web's resizable host, a window resize now re-grids the program
  between frames: the page holds the measurement and applies it right
  before releasing the next `waitFrame()`, once the program is waiting for
  it — so `Video.columns()` never changes between two reads inside one
  frame, and a program that redraws each frame simply follows the next
  one. A program with no frame clock is re-gridded at once, as before.
- Updated dependencies [660b8c0]
- Updated dependencies [4a594eb]
- Updated dependencies [b96ef5f]
- Updated dependencies [9ad0106]
- Updated dependencies [8309efa]
- Updated dependencies [548f29b]
- Updated dependencies [fb4cf62]
- Updated dependencies [47cf362]
- Updated dependencies [d1ab357]
- Updated dependencies [bd9a32a]
- Updated dependencies [1de8025]
- Updated dependencies [44b31ef]
  - @8bitscript/compiler@0.11.0
  - @8bitscript/language-server@0.11.0
  - @8bitscript/examples@0.11.0
  - @8bitscript/studio@0.11.0
  - @8bitscript/atari8@0.11.0
  - @8bitscript/c128@0.11.0
  - @8bitscript/c64@0.11.0
  - @8bitscript/cx16@0.11.0
  - @8bitscript/mega65@0.11.0
  - @8bitscript/nes@0.11.0
  - @8bitscript/pet@0.11.0
  - @8bitscript/vic20@0.11.0
  - @8bitscript/web@0.11.0

## 0.10.2

### Patch Changes

- 67b2aa5: A resizable web build's first frame could lay itself out for the compiled default grid (48×27) instead of the grid the page had already measured, while the page painted the picture at the real width — sheared, duplicated-looking text on load, self-correcting the moment the window was resized. The worker's `postMessage({ memory: ... })` back to the page is fire-and-forget: the worker calling the program's entry right after posting could (and reliably did) run the program's first `text.columns()` read before the page had processed that message and written the live grid back into the program's memory.
  
  The worker now writes the grid into its own freshly instantiated memory itself, synchronously, before ever calling entry — using the grid the page already measured and sent in the same message that starts the worker, closing the race instead of racing to win it. Only the Modern host's resizable preset does this; every fixed machine skin is unaffected (its `columnsOffset` is the screen's own first character cell, not a grid register).
  
  A second, independent bug produced the same symptom: `applyLayout()` — run once at mount to apply the program's compiled sidecar (`program.json`: palette, aspect, register offsets) — also applied that sidecar's `cols`/`rows`, which on a resizable host are the compiled default (48×27), not a live measurement. That overwrote `INNER_W`/`INNER_H` right after `resize()` had already computed the real grid from the window, and the very next `resize()` call's change check only compared `gridCols`/`gridRows` (never touched by `applyLayout`), so it silently skipped fixing `INNER_W`/`INNER_H` back — leaving the canvas painted at one grid while the program (and the worker fix above) used another. `applyLayout()` no longer touches `cols`/`rows`/`INNER_W`/`INNER_H` on a resizable host; every other field it applies (palette, aspect, register offsets) is unaffected, and a fixed skin still gets its own `cols`/`rows` applied as before, since those genuinely vary by machine.
  
  Both verified live in a browser (not just the existing headless suite): the title screen and a real window resize now render correctly on the very first frame.
- Updated dependencies [74f2785]
- Updated dependencies [2288987]
  - @8bitscript/compiler@0.10.2
  - @8bitscript/pet@0.10.2
  - @8bitscript/vic20@0.10.2
  - @8bitscript/c64@0.10.2
  - @8bitscript/c128@0.10.2
  - @8bitscript/cx16@0.10.2
  - @8bitscript/mega65@0.10.2
  - @8bitscript/atari8@0.10.2
  - @8bitscript/nes@0.10.2
  - @8bitscript/web@0.10.2
  - @8bitscript/examples@0.10.2
  - @8bitscript/language-server@0.10.2
  - @8bitscript/studio@0.10.2

## 0.10.1

### Patch Changes

- @8bitscript/examples@0.10.1
  - @8bitscript/atari8@0.10.1
  - @8bitscript/c128@0.10.1
  - @8bitscript/c64@0.10.1
  - @8bitscript/compiler@0.10.1
  - @8bitscript/cx16@0.10.1
  - @8bitscript/language-server@0.10.1
  - @8bitscript/mega65@0.10.1
  - @8bitscript/nes@0.10.1
  - @8bitscript/pet@0.10.1
  - @8bitscript/studio@0.10.1
  - @8bitscript/vic20@0.10.1
  - @8bitscript/web@0.10.1

## 0.10.0

### Patch Changes

- @8bitscript/examples@0.10.0
  - @8bitscript/atari8@0.10.0
  - @8bitscript/c128@0.10.0
  - @8bitscript/c64@0.10.0
  - @8bitscript/compiler@0.10.0
  - @8bitscript/cx16@0.10.0
  - @8bitscript/language-server@0.10.0
  - @8bitscript/mega65@0.10.0
  - @8bitscript/nes@0.10.0
  - @8bitscript/pet@0.10.0
  - @8bitscript/studio@0.10.0
  - @8bitscript/vic20@0.10.0
  - @8bitscript/web@0.10.0

## 0.9.1

### Patch Changes

- @8bitscript/atari8@0.9.1
  - @8bitscript/c128@0.9.1
  - @8bitscript/c64@0.9.1
  - @8bitscript/compiler@0.9.1
  - @8bitscript/cx16@0.9.1
  - @8bitscript/examples@0.9.1
  - @8bitscript/language-server@0.9.1
  - @8bitscript/mega65@0.9.1
  - @8bitscript/nes@0.9.1
  - @8bitscript/pet@0.9.1
  - @8bitscript/studio@0.9.1
  - @8bitscript/vic20@0.9.1
  - @8bitscript/web@0.9.1

## 0.9.0

### Patch Changes

- @8bitscript/atari8@0.9.0
  - @8bitscript/c128@0.9.0
  - @8bitscript/c64@0.9.0
  - @8bitscript/compiler@0.9.0
  - @8bitscript/cx16@0.9.0
  - @8bitscript/examples@0.9.0
  - @8bitscript/language-server@0.9.0
  - @8bitscript/mega65@0.9.0
  - @8bitscript/nes@0.9.0
  - @8bitscript/pet@0.9.0
  - @8bitscript/studio@0.9.0
  - @8bitscript/vic20@0.9.0
  - @8bitscript/web@0.9.0

## 0.8.0

### Minor Changes

- 2026d01: Named systems live in three layers — advertised in 8bitscript.config.ts, this clone's .8bitscript/systems.json, and ~/.config/8bitscript/systems.json — and `8bs run --system` / `build` / `boot` resolve through that merge. `--checkout` (or EIGHTBITSCRIPT_CHECKOUT / toolchain.json) points a consumer at a local 8BitScript tree without rewriting its package.json. The editor's side bar has one Update/Install for that tree (workspace repo, or a clone under the extension's global storage) plus named-system quick launch; Configure System and Show Project are editor tabs.

### Patch Changes

- 2026d01: `8bs run web` binds an ephemeral port by default so two runs can coexist (`--port n` still pins one). The launcher shows a QR of the LAN HTTPS URL on a web run so a phone on the same Wi-Fi can open it without typing the address.
- Updated dependencies [2026d01]
  - @8bitscript/compiler@0.8.0
  - @8bitscript/language-server@0.8.0
  - @8bitscript/atari8@0.8.0
  - @8bitscript/c128@0.8.0
  - @8bitscript/c64@0.8.0
  - @8bitscript/cx16@0.8.0
  - @8bitscript/examples@0.8.0
  - @8bitscript/mega65@0.8.0
  - @8bitscript/nes@0.8.0
  - @8bitscript/pet@0.8.0
  - @8bitscript/studio@0.8.0
  - @8bitscript/vic20@0.8.0
  - @8bitscript/web@0.8.0

## 0.7.1

### Patch Changes

- 55b6e9e: `8bs run pet` launches on the keyboard when a controller profile is recorded.
  
  The PET has no control ports (`input.joysticks: 0`), and xpet's only joystick
  flags are for a userport adapter the catalog does not fit. A mapped pad used
  to fail the whole launch — which made every PET program unplayable once a
  gamepad had been recorded for another machine. The adapter now matches web:
  no flags, a note that the pad was not attached, and the keyboard still runs.
  
  Where the line is drawn: a profile a machine cannot honour *as flags* is a
  note when the machine has no control ports at all, because the point of
  naming a refusal is that somebody reads it, and nobody reads a line that
  scrolled past while an emulator was starting. A port that exists and is
  fitted with nothing is still a refusal — that profile asked for hardware
  the catalog does not fit, and `--hardware port1=joystick` is the fix.
- 54cdcad: © at 0xA9, on every target whose character set this project can reach.
  
  The symbol's own Unicode/Latin-1 code point is the code, so a program spells
  what it means rather than an agreed-on private number, and the three targets
  that can draw it all agree on it:
  
  - **web** — the host font (`packages/cli/src/font8x8.mjs`) is ours: ASCII
    32-122 from Hepper's public-domain font8x8, plus the sixteen 2×2 quadrant
    blocks at 128-143 this project added. The gap between the blocks and 0xA9
    stays blank and costs nothing: `glyphTableLiteral()` skips every code with
    no ink, so both renderers (the browser page and `--screenshot`) pick the
    new glyph up with no other change.
  - **NES** — the CHR-ROM is ours too (`packages/nes/native/6502/font.s`), and
    now draws the same artwork at the same tile. Tile $A9 sat inside the
    reverse-video run as the reverse of `)`, and `)` has no glyph in this font
    to reverse, so what it displaced was an inverted blank. No portable
    character's reverse lands there either — the portable set maps to $A0,
    $A1, $AC-$AE, $B0-$B9, $BA, $BF, $C1-$DA and $E1-$FA.
  - **Commander X16** — nothing to add. The screen runs in ISO mode, where
    VERA's tile index IS the character code, and the KERNAL's ISO-8859-15 set
    already holds © at 169. `packages/cx16/test/charset.test.mjs` reads it out
    of the installed `rom.bin` and asserts the artwork, so that is a measured
    fact rather than a code chart quoted from memory; it skips when no ROM is
    installed.
  
  The other six targets do **not** gain the symbol, and the headers say so.
  The PET, C64, VIC-20, C128, MEGA65 and Atari 8-bit draw from a character
  generator this build does not replace, and none of those ROMs holds a © at
  all — every chargen VICE ships, plus the Atari OS and MEGA65 ROMs, was
  scanned for one. `putChar(cell, 169)` there draws whatever its ROM happens
  to have at that code. They join when a redefined-charset layer exists, which
  no machine has yet.
  
  © is outside the checker's portable character set and cannot appear in a
  string literal, so a program reaches it through `putChar(169)` — the same
  way `(` and `)` already are on machines whose fonts do have them.
- Updated dependencies [0311af7]
- Updated dependencies [0311af7]
- Updated dependencies [0311af7]
- Updated dependencies [3b75885]
- Updated dependencies [54cdcad]
  - @8bitscript/c128@0.7.1
  - @8bitscript/cx16@0.7.1
  - @8bitscript/compiler@0.7.1
  - @8bitscript/nes@0.7.1
  - @8bitscript/language-server@0.7.1
  - @8bitscript/examples@0.7.1
  - @8bitscript/studio@0.7.1
  - @8bitscript/atari8@0.7.1
  - @8bitscript/c64@0.7.1
  - @8bitscript/mega65@0.7.1
  - @8bitscript/pet@0.7.1
  - @8bitscript/vic20@0.7.1
  - @8bitscript/web@0.7.1

## 0.7.0

### Minor Changes

- ea88a5d: A grid that follows the window, on the web target's Modern host only.
  
  Modern is 8BitScript's own invention — no chip to be faithful to, so the grid
  was always a decision — and it now changes shape while a program runs: 48×27
  in a landscape window, 27×48 in a portrait one, 42×31 at 4:3, from one .wasm
  and without restarting the program. Every machine skin is untouched: a C64 is
  40×25 because a C64 is 40×25.
  
  Two new pieces of portable API, both of which fold to constants on a machine
  whose grid cannot change — a PET 2001 image built against them is byte-for-byte
  identical to one written the old way:
  
    - `text.columns()` / `text.rows()` — the live grid
    - `screen.RESIZABLE` / `screen.resized()` — whether it can change, and
      whether it just did
  
  (`text.fill()`, which a derived layout also needs, ships separately.)
  
  Two bugs found while building it, both in the web target:
  
    - `screen.blank()` left the color bytes alone. Reverse video rides in bit 7
      of the color byte here, and the host paints a reverse cell as a solid
      block whatever the character is — so a "blank" screen kept every reverse
      block that had been on it.
    - `Video.cells()` multiplied two `utinyint`s. On a 27×48 grid that product
      is 1296, which does not fit, so `blank()` cleared 16 cells instead of all
      of them.

### Patch Changes

- a8f02ed: The web target never draws a zero border again, however small the screen.
  
  `borderFor()` dropped the border to nothing below 2x scale, which is every
  phone in either orientation. The reasoning was sound as far as it went — the
  border is decoration, and 48 of every 432 horizontal pixels is canvas spent on
  nothing — but it treated the border as *only* decoration.
  
  It is also a channel. `screen.setBorder()` is how a program says something
  about the whole screen at once, and the border is the one part of the picture
  still visible when something is drawn over the middle of it: 2048 turns it red
  on game over. At zero that said nothing at all, on exactly the devices most
  people play on.
  
  The floor is 3 picture pixels — 3 of 216 rows, under 3% of the height across
  both edges, and unmistakable when the colour changes.
- Updated dependencies [ea88a5d]
- Updated dependencies [e6c4938]
  - @8bitscript/web@0.7.0
  - @8bitscript/atari8@0.7.0
  - @8bitscript/c128@0.7.0
  - @8bitscript/c64@0.7.0
  - @8bitscript/cx16@0.7.0
  - @8bitscript/mega65@0.7.0
  - @8bitscript/nes@0.7.0
  - @8bitscript/pet@0.7.0
  - @8bitscript/vic20@0.7.0
  - @8bitscript/examples@0.7.0
  - @8bitscript/compiler@0.7.0
  - @8bitscript/studio@0.7.0
  - @8bitscript/language-server@0.7.0

## 0.6.2

### Patch Changes

- 8e3a326: The web target gets a screen of its own, and machine skins beside it.
  
  Its stock grid was 40×25 — the C64's, inherited because every other machine had one and the web had to say something. Nothing on the web is 40×25. The default is now **48×27 cells of 8×8: 384×216, exactly 16:9**, so a browser canvas scales to it without pillarboxing.
  
  The old shapes did not go away, they became choices. `--hardware machine=<hifi|pet-2001|c64|vic20>` picks the skin the wasm build is compiled for, with `c64`, `pet-2001` and `vic20` also available as presets:
  
  | machine | grid | palette | notes |
  | --- | --- | --- | --- |
  | `hifi` (default) | 48×27 | 16 | 16:9, per-cell color |
  | `pet-2001` | 40×25 | 2 | green phosphor, swapped character set |
  | `c64` | 40×25 | 16 | per-cell color |
  | `vic20` | 22×23 | 16 | per-cell color |
  
  Each skin is a geometry twin next to `geometry.8bs` — `geometry.web.c64.8bs` and friends — resolved by the same system-specific-file mechanism every machine package already uses. So `text.COLUMNS`, `text.CELL_COUNT`, and the offsets the host and the program agree on fold to that skin's constants at build time; nothing probes the grid at runtime.
  
  A tagged build writes `program-<tag>.wasm` beside a `program.json` layout sidecar carrying grid, palette and aspect, which the web loader reads to size the canvas instead of assuming one shape. `8bs screenshot` reads the same layout, so a skinned build screenshots at its own grid rather than the default one.
- 8e3a326: `8bs run web` serves on port 8008 (HTTPS 8009) and on the LAN by default so a phone on the same Wi-Fi can reopen the same URL (`--local` is loopback only, `--port` picks another). The editor setting `8bitscript.webLan` turns LAN off.
- Updated dependencies [8e3a326]
  - @8bitscript/web@0.6.2
  - @8bitscript/examples@0.6.2
  - @8bitscript/studio@0.6.2
  - @8bitscript/compiler@0.6.2
  - @8bitscript/atari8@0.6.2
  - @8bitscript/c128@0.6.2
  - @8bitscript/c64@0.6.2
  - @8bitscript/cx16@0.6.2
  - @8bitscript/language-server@0.6.2
  - @8bitscript/mega65@0.6.2
  - @8bitscript/nes@0.6.2
  - @8bitscript/pet@0.6.2
  - @8bitscript/vic20@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [f278212]
  - @8bitscript/compiler@0.6.1
  - @8bitscript/language-server@0.6.1
  - @8bitscript/atari8@0.6.1
  - @8bitscript/c128@0.6.1
  - @8bitscript/c64@0.6.1
  - @8bitscript/cx16@0.6.1
  - @8bitscript/examples@0.6.1
  - @8bitscript/mega65@0.6.1
  - @8bitscript/nes@0.6.1
  - @8bitscript/pet@0.6.1
  - @8bitscript/studio@0.6.1
  - @8bitscript/vic20@0.6.1
  - @8bitscript/web@0.6.1

## 0.6.0

### Minor Changes

- fc0af15: The C128 builds and runs, and the editor offers every machine that does.
  
  The C128 is the C64 again in almost every respect that matters here, which is why it went quickly: the same VIC-II registers and the same frame as an exact fraction of the same crystal (`FRAME_SYNC` already recorded the two entries identically), a screen at `$0400` written through a computed address, and a character ROM whose mixed-case set holds lower case at 1-26 and upper case at 65-90 — measured against `chargen-390059-01.bin`, where code 8 is `h` and code 72 is `H`, with only 105 and 122 differing across the block-graphics range, exactly as on every other Commodore here.
  
  Three things are its own. Its `.prg` loads at `$1C01` and its RAM ends at `$C000` — 41983 bytes, which is what `packages/c128/AGENTS.md` has always recorded, and the catalog's new build symbols reproduce that number exactly. Its zero page starts at `$0A`: `$00`/`$01` are the 8502's port and `$02`-`$09` are the KERNAL's JMPFAR/JSRFAR parameters, so those nine bytes stay the machine's — which is not a new decision, but the one this project's own pre-0.2.0 C128 link map already made. And its text package now selects the mixed-case set, which on this machine means agreeing with the ROM rather than overriding it: the C128 boots that way.
  
  Measured under x128: hello-world is **225 bytes** and returns to a working `ready.` prompt; 2048 is **3583 bytes** and draws its board.
  
  `@8bitscript/c128/text` also gets the fix its siblings got: it mapped only 64-95 and left lower case at 97-122, which in the upper-case set are graphics symbols.
  
  The VS Code extension offers `pet`, `c64`, `vic20`, `c128` and `web` — its task-definition enum, its system setting, and the launcher's own list. What each machine *offers* was never listed there and still is not: every option, value and preset comes from `8bs targets --json`, so the C64's REU sizes and the VIC-20's RAM expansions arrived on their own the moment those machines were on the list.
- c7fea69: The C64 and the VIC-20 build and run. 2048 plays on both.
  
  `RELEASE_MACHINES` is `pet, c64, vic20, web`. What it took, beyond the groundwork in the changes before this one:
  
  **`waitFrame()` on a raster.** The PET has a retrace flag and no documented crystal, so it measures its own frame at start-up. Every other Commodore here has the opposite pair of facts: no flag, but a raster counter readable as a plain byte and a frame that is an exact fraction of a known crystal. So the accumulator, its denominator and the whole compare/subtract body are shared, and only two things differ per machine — how a hardware frame is waited for (the raster leaving the top half of the frame and coming back to it, never a narrow at-line-0 window, for the reason `FRAME_SYNC` records at length) and how the per-frame credit is arrived at. PAL or NTSC cannot be a build flag, since one `.prg` runs on both, so it is probed once at start-up by watching for a line only one region ever reaches.
  
  **`string<N>` buffers.** A buffer's name is its address, the way a literal's is — it lives in the data section, not zero page — so it can be passed to `text.print` and assigned into. `stringCopy` is the assignment: the length byte and then that many characters, through two pointers.
  
  **Narrowing assignment.** `let offset: utinyint = (cellWidth - width) >> 1` is ordinary code — the subtraction is 16-bit because one side is, and the answer is kept in a byte. Narrowing takes the low byte, which is what it has always meant, instead of the statement being refused for a width the program never asked anything unusual of.
  
  **A 16-bit array index goes through a pointer.** Y is eight bits, so `screenRam[cell]` with a cell past 255 cannot be indexed with it. Truncating collapsed 1000 cells into the first 256 — on a 40-column screen, the whole display crammed into its top six rows, which is exactly what a C64 2048 drew before this. The address is computed instead, as a computed `memory.write` address already was.
  
  Measured under x64sc and xvic, through the real CLI:
  
  | | hello-world | 2048 |
  |---|---|---|
  | C64 | 424 bytes | 3747 bytes |
  | VIC-20 | 232 bytes | 3116 bytes, inside an unexpanded 3583 |
  
  The PET is unchanged at 108/108/127 bytes, and its 2048 got *smaller* — 2440 to 2413 — from the index-offset fold.
- 188cd63: Controller profiles reach the emulator: one adapter per emulator, and an honest account of what each will take.
  
  `8bs run` and `8bs boot` now read `8bitscript.controllers.json` — the file the editor's Controller Setup panel writes — and hand it to whichever emulator the target uses, in whatever shape that emulator will accept. The two ends share one grammar on purpose: `packages/cli/src/controllers.mjs`'s `parseBinding` is the inverse of `editors/vscode/src/controllerProfile.cjs`'s, because two spellings of one mapping is how a binding comes to mean different things at each end.
  
  ```json
  {
    "version": 1,
    "controllers": {
      "devices": [
        { "id": "…", "name": "8BitDo SN30 Pro", "player": 1, "mode": "standard",
          "mapping": { "up": "button:12", "a": "button:0", "left": "axis:0-" } }
      ]
    }
  }
  ```
  
  The eighteen control names are `docs/project/input.md`'s. A device with `player: 0` is one the panel has seen and nobody has assigned, and drives nothing — "plugged in" and "playing" are different facts. **The host joystick number is the player number minus one**: nothing in the file carries one, because a device is identified by its Gamepad API id string, which has no relationship to the index SDL hands the emulator, and matching them by name would be a guess that fails silently. Which emulated port a player takes comes from the machine, not the file — player 1 is port **2** on a C64, C128 and MEGA65, because port 1 shares its lines with the keyboard matrix and a stick left there types.
  
  `8bs targets --json` now publishes `primaryPort` per machine so the editor can stop keeping its own copy of that table.
  
  `controllers.mjs` is all pure functions — profile in, arguments and file *contents* out — which is what lets the tests assert on argument vectors rather than opening a window. That matters here more than anywhere: `8bs run <target>` without `--screenshot` waits for a human, and a test that launches one does not fail, it hangs.
  
  What each emulator actually does, measured against the binaries rather than remembered:
  
  - **VICE** (`xvic`/`x64sc`/`x128`) gets the most. `-joydev<port>` picks which host device drives a port, and a full per-button map goes through a generated `.vjm` joystick file whose format is documented inside VICE's own binary. `JoyMapFile` has no command-line form, so the map is reached through a generated `vicerc` — which works only under the emulator's own section header (`[C64SC]`, `[VIC20]`, `[C128]`), and only when `-config` is the **first** argument on the line. Both were measured with bounded `-limitcycles` runs; with the flag buried mid-argv VICE silently falls back to its default map, which is exactly the quiet nothing this work exists to prevent. The user's own `vicerc` is copied rather than replaced, since `-config` replaces it.
  - **atari800** takes a keyboard stick — `-kbdjoy0`/`-kbdjoy1` plus `SDL2_JOY_<n>_*` keycodes — in the same single `-config` file the CRT knobs already used. A real pad's buttons are not settable at all: `SDL2_JOY_<n>_BUTTON_KEYS` maps buttons to emulated *keys*, not to stick directions. An Atari stick has one trigger, so everything past `a` is named rather than mapped.
  - **fceux** takes `--input1`/`--input2` and nothing else. Its bindings live in `~/.fceux/fceux.cfg` and named profiles under `~/.fceux/input/`, both set from the Qt GUI, and there is no `-config <file>` to point elsewhere. Said by name at launch rather than quietly dropped.
  - **x16emu** takes `-joy1`..`-joy4` — "enable binding a gamepad to SNES controller port N" — and no mapping; its `-keymap` is a Commodore keyboard layout, not a controller map. **xmega65** takes `-joyport 1|2` and `-curskeyjoy`, one port at a time.
  - **The PET is refused by name.** It has no control ports: VICE offers `xpet` only the userport joystick adapter, and the catalog agrees (`input.joysticks: 0`). If one is ever fitted it belongs in `packages/pet`'s catalog as an option.
  - **web** is accepted and says it has nowhere to land yet — the browser runtime reads six fixed edge bits.
  
  Nothing here emits a `-controlport<n>device` flag: which device is *in* a port is the machine catalog's sentence, and the adapters' flags go after it. A port fitted with nothing (a stock C64's port 1, where player 2 lands) is refused with the `--hardware port1=joystick` that fixes it, rather than pointing `-joydev1` at an empty port and looking broken.
  
  A hand-written `key:<KeyboardEvent.code>` binding is read — it is the only shape atari800 takes a mapping in at all — but the panel's own `parseBinding` does not accept it yet, and `normalizeProfile` rewrites the file on save. A launch that finds one says so by name, because otherwise it works until somebody opens the panel and presses a button, and then it is gone with nothing said. Two characters of the panel's regex close it.
  
  A project with no `8bitscript.controllers.json` launches byte-identically to before.
- 188cd63: `8bs controller` maps a game controller from the terminal, in a real browser.
  
  The Gamepad API belongs to a browsing context, so nothing in Node can see a pad and the editor's Controller Setup panel polls for one inside its webview. That is the right place only if the editor grants it: Chromium gates `navigator.getGamepads()` behind the `gamepad` permission policy, whose default allowlist is `self`, and a webview is a cross-origin iframe whose `allow` attribute belongs to the *editor* — Cursor's bundled workbench lists cross-origin-isolated, autoplay and the two clipboard features in it, and not `gamepad`. A panel that can never see a controller looks exactly like a controller that is not plugged in.
  
  A browser has no such question. `8bs controller` serves the mapping page on loopback, opens it in the browser the person already has, and takes the profile back over the socket: assign pads to players, bind the eighteen logical controls (by hand, from the standard layout, or through the guided walkthrough), and `8bitscript.controllers.json` is written beside `8bitscript.config.ts` as each binding is made — the same file `8bs run` already reads to aim each emulator's joystick ports, in the same shape the editor's panel writes. `--no-open` prints the URL and waits, the way `8bs run web --no-open` does; `--list` prints the controllers a project has on record and `--print` dumps the file, both without a browser; `--dir` names the project.
  
  The page is the editor's page, not a second one: `media/controller.js`, its stylesheet, the silhouette, and `controllerProfile.cjs` — which is what a binding *means*, down to the deadzone that turns a shoved stick into a direction — are mirrored into `src/controller-page/` and served from there, because an installed `@8bitscript/cli` cannot reach `editors/vscode` (it is private and outside `packages/`). The mirror is byte-for-byte and a test says so, printing the `cp` that fixes it: two mapping UIs that had each drifted to their own idea of a deadzone would be two different profiles.
  
  `bin/8bs.mjs` also stopped losing output. `process.exit()` abandons a pending write and a pipe holds 64KB, so `8bs targets --json | ...` had begun handing its readers — the editor among them — JSON that ended mid-string at byte 65536, with an exit code of 0 to say all was well. Every command now drains stdout before it exits.
- 57ccce1: The Commander X16 builds and runs. The MEGA65 builds.
  
  Four things the backend gained, all of them machine-independent and all of them wanted by these two rather than invented for them:
  
  - **`x / 2^k` is a shift and `x % 2^k` is a mask.** The 6502 has no divide, so `/` was refused by name — but a power-of-two divisor is not really a divide. The X16 package is written in those terms throughout (`memory.read(0x9F35) / 128`, `low / 256`, `attr / 16`, `cell % 256`), which is how a program reads best. Unsigned only: `>>` floors where `/` truncates, so the two disagree on negatives.
  - **16-bit `&`, `|` and `^`.** A byte at a time, which is all a bitwise operation ever is — no carry between the halves.
  - **Narrowing at every 8-bit boundary**, not just at a local or an assignment: a `memory.write` value, an 8-bit call argument and an array element all take the low byte of a wider expression now, which is what narrowing has always meant.
  - **`waitFrame()` for both.** The MEGA65's VIC-IV answers `$D011`/`$D012` like the C64's VIC-II, so it is the same raster poll. The X16 is a third shape: VERA raises a VSYNC bit in its ISR and acknowledging it is writing it back — an edge like the PET's, but needing no calibration, because the X16's frame is exactly 1/60s everywhere. At the default frame rate one VSYNC is exactly one logical frame and the accumulator never carries.
  
  The X16 also needed a start-up its package had documented and the native backend had never emitted: `CHR$(15)` through CHROUT, which switches the screen editor into ISO mode. `@8bitscript/cx16/text` writes ASCII straight to VERA — the tile index *is* the character code there — and without the switch the machine is in PETSCII and every letter draws as a graphic. Two instructions, on the one machine that needs them.
  
  **Measured under x16emu: hello-world is 1370 bytes and prints `Hello World!` over a working `READY.`**
  
  The MEGA65 is **not** un-parked. Its hello-world (251 bytes) and 2048 (3615 bytes) both build, but Xemu shows a one-time onboarding screen that waits for a keypress before it will run anything, so nothing has been seen on screen yet — and un-parking is what switches a machine's emulator tests on. It joins the list when a screenshot can prove it.
  
  2048 does not fit the X16 yet: its deepest call chain wants more zero page than the 94 bytes `$22`-`$7F` the X16 documents as the user's, and taking any of the KERNAL's `$80`+ would need research this workspace does not have.
- 57ccce1: Every machine the toolchain knows now builds and runs. `RELEASE_MACHINES` is the whole list.
  
  The NES and the Atari 8-bit join, each brought up against its own emulator — `Hello World!` and 2048 seen on screen under `fceux` and `atari800`. Neither fits the shape every machine before them shared (a `.prg` with a BASIC stub that `SYS`es in and `RTS`es back), which is what `mos/image.ts` exists for: a NES program is a ROM started by a reset vector, an Atari program is a segmented `.xex` the DOS loader jumps through.
  
  **The X16's zero page widens from 94 bytes to 181**, and 2048 fits it. The evidence is the ROM's own ld65 configuration rather than the docs' summary table: `cfg/x16.cfginc` declares ZPKERNAL at `$80`, ZPDOS at `$91`, ZPAUDIO at `$A7`, ZPMATH at `$A9` and ZPBASIC at `$D4`, and `cfg/kernal-x16.cfgtpl` loads every one of the KERNAL bank's four zero-page segments into ZPKERNAL while no other bank declares zero page at all — so no KERNAL routine can reach `$A9`-`$FF`, whatever it is asked to do. That range is the Math library's and BASIC's, and the reference manual releases both to machine code outright. A program that never hands BASIC back takes it; one that does keeps the polite `$22`-`$7F`.
  
  `$02`-`$21` stays out under both, though 2048 would fit inside the old ceiling if it were taken: those are `r0`-`r15`, the KERNAL API's caller-supplied 16-bit argument registers, demonstrably written through `extapi`, and "does this program call such a routine" is not a fact readable off the finished instruction stream the way `usesWaitFrame` is — the calls sit inside opaque `asm6502` blocks.
  
  A zero-page budget may now carry holes of its own, and they survive into every program. The PET's CHRGET hole is the other kind — it exists only because a returning program leaves BASIC's interpreter running — and still drops for a program that never returns.
  
  The VS Code extension offers all nine targets. What each machine *offers* is still never listed there: every option, value and preset comes from `8bs targets --json`.
- 57ccce1: The MEGA65 builds, runs and is no longer parked — and two bugs in its package are fixed.
  
  Getting it on screen at all took cracking Xemu's onboarding screen, which waits for a keypress and so hung every headless run. The cause is upstream: Hyppo reads its config sector from absolute LBA 1 of the SD image, while Xemu only ever writes one at syspart+1, so the onboarding-complete byte was never set. Writing a valid config sector at LBA 1 of `mega65.img` — `$0E = $80` being the byte that matters — makes `xmega65 -headless -besure -prgmode 65 -prg … -screenshot …` work. That is emulator state, not repo state, and it is recorded here because the next person will hit it too.
  
  What that revealed, neither of which any build could have shown:
  
  - **Lower case drew as graphics.** `text.8bs` mapped only 64-95 and pinned `$D018` to the upper-case set, so lower-case ASCII passed straight through into the graphics range: hello-world drew `H`, four blobs, ` W`, four more blobs, `!`. It now selects the mixed-case set (`$26`, measured: screen codes `08 05 0C 0C 0F` render as `hello`, `48 45 4C 4C 4F` as `HELLO`) and maps `97`-`122` down by 96, which is what every other Commodore in this workspace does and what `packages/pet/src/text.8bs` argues at length. This reverses a deliberate choice recorded in that file — that `TICK` should read as `TICK` the way it does on the NES and the X16 — because a text package that silently changes the text is answering a different question than the one it was asked.
  - **Colour RAM was left mapped over the CIAs.** `prepare()` set CRAM2K (`$D030` bit 0) so the 80-column screen's cells 1024-1999 could be coloured, and never cleared it — leaving colour RAM in front of `$DC00`-`$DFFF`, where the CIAs are. `@8bitscript/mega65/input`'s `poll()` then scanned the keyboard matrix through colour cells and invented key presses out of whatever the screen held: in 2048 a phantom LEFT slid the board and spawned a third tile before the player touched anything. Its writes went astray too, landing in colour cells 1024-1027. Every text entry point now hands the CIAs back. The file's own note — "the frame runtime polls `$D012`, not a CIA, so nothing here misses them" — had overlooked `poll()` in the same package.
  
  Measured under xmega65: hello-world **256 bytes**, printing `Hello World!`; 2048 **3645 bytes**, drawing its board with exactly the two starting tiles its own generator predicts, at the indices the C64 build puts them.
- 08fa8b5: A web build is now something you can put in someone else's page, and it stops spending a fifth of a phone's screen on a border.
  
  `8bs build --target web` writes `8bitscript.js` — a loader with `mount()` and an `<eightbit-screen>` custom element — next to `program.wasm`, so embedding a program is two lines:
  
  ```html
  <script src="8bitscript.js"></script>
  <eightbit-screen src="program.wasm"></eightbit-screen>
  ```
  
  `index.html` is now a forty-line shell that calls that same loader, so the page we ship takes the path an embedder takes and cannot quietly drift away from it. The bundle also gains `embed.html` (the worked example of a screen inside an article), `worker.js` as a real file for pages whose CSP forbids `blob:` workers, and `coi.js`.
  
  **The border is measured, not assumed.** It was 24 px on every side always — 48 of every 368 horizontal pixels and a fifth of the height, which is a fine frame on a desktop and plainly wrong on a phone, where the picture renders at barely 1–2×. `borderFor()` now reads the box the picture is going into and returns 24 px at 3× and up with a mouse, an 8 px hairline between 2× and 3× or on any touch screen, and nothing at all below 2×. Measured in Chromium: a 1920×1080 desktop keeps its 24; an iPhone gets 0 in **both** orientations (portrait 393×852 and landscape 852×393); a 42rem article column gets the hairline. It reads the *container*, so a narrow column is treated like the small screen it is. `border="24"` pins it, and the headless `--screenshot` still always renders 24 — there is no viewport there to measure.
  
  **Cross-origin isolation is now explained rather than assumed.** The gate turns out to be on *sharing* memory, not on having it: without COOP/COEP, `new WebAssembly.Memory({shared: true})` succeeds and a shared-memory module instantiates fine, but `postMessage` of the buffer throws `DataCloneError: SharedArrayBuffer transfer requires self.crossOriginIsolated`. So the loader detects it and says which two headers are missing instead of failing blankly, `docs/web-embedding.md` gives the Cloudflare/Netlify/nginx/Apache/Vercel/Express forms, and `coi.js` installs a service worker that supplies them on a host that cannot — verified end to end against a static server sending none. It is opt-in, because `require-corp` then applies to the embedder's whole page.
  
  Embedded, a screen stays a guest: it sizes from a `ResizeObserver` on its container rather than the viewport, takes the arrow keys only while focused so the page still scrolls, goes fullscreen into its own element, and never posts to `/status`. The loader carries the worker inside itself and starts it from a `blob:` URL, so serving `8bitscript.js` from a different origin than the page works.

### Patch Changes

- cc04ede: Hello World runs on the C64 and the VIC-20, and reads as `Hello World` on both.
  
  **A constant added to an index folds into the address.** `screenRam[i + 250] = 32` — the second quarter of the C64 and VIC-20 screen-clearing loops — was computing `i + 250` in an 8-bit register and indexing with the result. The sum wraps at 255, so from `i = 6` on every iteration wrote back over the first quarter and the rest of the screen was never cleared: a real miscompile, visible as a screen full of uncleared garbage. The 6502's answer is the other association, `STA base+250,Y`, which is exact for every index Y can hold and is what those loops were written in terms of all along ("four constant offsets off one 8-bit index is the shape a 6502 wants"). It is also smaller and faster: C64 hello-world went from 481 bytes to 424.
  
  **The C64 and VIC-20 text packages draw in the mixed-case character set.** They selected the upper-case/graphics set and mapped only 64-95, leaving lower case at 97-122 — which in that set are graphics symbols, so `"Hello World"` drew as `H`, a graphic, three graphics, a space, `W`… Both ROMs were measured directly (`chargen-901225-01.bin`, `chargen-901460-03.bin`): the mixed-case set holds lower case at 1-26 and upper case at its own 65-90, exactly as the PET's does, and in the 96-127 block the two sets differ only at 105 and 122, which no block-graphics code uses. This is the same decision `@8bitscript/pet` took, for the same reason: it is the only set holding both cases, so it is the only one that can draw a string as it was written.
  
  **The VIC-20's hardware sheet carries its load address and RAM ceiling**, because a RAM expansion moves both: `$1001` unexpanded, `$0401` with the 3K (which fills `$0400-$0FFF`), `$1201` with 8K and up (the screen drops to `$1000`). Each is checked against the catalog's own `memory.ram` fact. `__ram_ceiling` joins `__ram_size` as a spelling of the linker's ceiling, for machines whose usable RAM does not end on a whole number of KiB — unexpanded, the VIC-20's ends at `$1E00`, which is 7.5.
  
  **Zero-page budgets for both.** The VIC-20 keeps a real polite shape and uses it: hello-world is 232 bytes and 4 zero-page bytes, and returns to a working BASIC. The C64 has no polite shape to keep — `setupVideo()` banks the KERNAL out and keeps it out, because the screen it sets up lives at `$E000` under the KERNAL ROM, so a C64 program that draws has already taken the machine — and takes the whole page.
  
  Measured under x64sc and xvic: both show `Hello World!`. The PET is unchanged at 108/108/127 bytes.
- c85fa23: Controller profiles live in `~/.config/8bitscript/`, not the project. An 8BitDo at one desk is not a `systems` block.
  
  Gamepad API button numbers are not written into VICE `.vjm` files — they are the browser's indices, not SDL's, and `!CLEAR` plus those numbers is how a working pad went dead the moment a profile appeared. FCEUX `--input1 gamepad` (the help text) is not what UpdateInput() matches — that is `GamePad.0`; lowercase `gamepad` is SI_NONE, an empty NES port, and it persists into `~/.fceux/fceux.cfg`.
- 6e1056b: Groundwork for the second 6502 machine: the backend stops assuming it is building for the PET.
  
  Three things that were the PET's are now the hardware sheet's or the machine's:
  
  - **The load address comes off the sheet.** It was a per-machine table in `mos/index.ts`, which the VIC-20 disproves — a RAM expansion moves BASIC's program area from `$1001` to `$1201`, so one machine has two. It is `build.defsym.__load_address` now, alongside `__ram_size`, and a catalog can carry machine-level build symbols (`"8bitscript".hardware.build`) rather than only per-option ones. A machine whose sheet lacks one is refused by name.
  - **Zero-page budgets are per machine.** `ZP_BUDGETS` pairs the polite budget (a program that returns to BASIC) with the owned one (a program that never does). The C64's polite range is nothing like the PET's: BASIC owns `$02-$8F` and the KERNAL `$90-$FF`, leaving `$FB-$FE` — four bytes, enough to print and return and nothing like enough for real state, which is the same trade the PET's own two budgets make.
  - **`@address` arrays lower.** They were refused by name; they now bind their label to the pinned address through a new `equate` directive in the assembler, so an `@address` array reaches hardware by exactly the path a data-section array reaches the program image by, and emits no bytes. This is what the C64 and VIC-20 packages are written against — `screenRam[cell] = 32` over the VIC's screen — 65 uses across the two.
  
  The PET is byte-for-byte unchanged by all of it (hello-world 108/108/127 across the 2001, 3032 and 8032; 2048 2440 bytes on a stock 4K 2001).
  
  The C64 is deliberately **not** added to `RELEASE_MACHINES` yet: a package's own emulator tests switch on from that list, so listing a machine before it can build a program runs them against one that cannot boot what they load. It joins when it builds. The next blocker is `asm6502` blocks, which reach the backend as raw text and need a 6502 assembly parser; `setupVideo()` in `@8bitscript/c64` uses them to bank the KERNAL out.
- b390ef3: PET text is now drawn in the machine's text character set, so a string reaches the screen as it was written — and nothing puts the old set back on the way out.
  
  `"Hello World"` is `Hello World`, not `HELLO WORLD`. The PET's graphics set holds exactly one case of the alphabet, so a text package that encodes for it silently flattens mixed-case text to capitals — answering a different question than the one the caller asked. The text set holds both cases, so `@8bitscript/pet/text` draws in that one and selects it first on the models that boot elsewhere. The 8032's editor ROM already boots into it, so `#fact(video.bootsInTextMode)` folds the write away there and no `$E84C` store reaches the binary at all.
  
  `video.characterSetSwapped` matters again as a result: the original 2001's 901447-08 ROM arranges the text set's two cases the other way round from every later model's (upper case stays at 1-26, lower case moves to 65-90 — verified glyph by glyph against the ROM, where code 8 is `H` and not `h`). A build for the 2001 gets that mapping; a build for anything else gets the other.
  
  **`restoreOnExit` is removed**, along with the `usesCharacterSet` scan and the `LDA $E84C`/`PHA` … `PLA`/`STA $E84C` pair it drove. Restoring the character set could never work: the bit is retroactive — it selects the ROM the video hardware reads for every cell already on screen — so writing the old value back re-rendered the text the program had just drawn, through the very set it switched away from in order to draw it. Measured on a 3032, `Hello World!` came back as `|ELLO OORLD!` above a correct prompt. A program now exits in the set it selected, which is the only state where what it drew still reads as what it wrote. A project that still sets `restoreOnExit` is told the option is retired rather than having it quietly ignored.
  
  Measured under xpet on all three models: the 8032 shows `Hello World!` over its own `ready.` and spends nothing; the 2001 shows `Hello World!` over an upper-case `READY.`, because its ROM's two sets agree on codes 1-26 where BASIC's prompt is drawn; a 3032 shows `Hello World!` over a lower-case `ready.`, which is the whole of what this costs. hello-world is 108 bytes on a 3032, against 116 when the restore was still being paid for.
- Updated dependencies [05764ff]
- Updated dependencies [57ccce1]
- Updated dependencies [fc0af15]
- Updated dependencies [cc04ede]
- Updated dependencies [c7fea69]
- Updated dependencies [188cd63]
- Updated dependencies [57ccce1]
- Updated dependencies [57ccce1]
- Updated dependencies [188cd63]
- Updated dependencies [188cd63]
- Updated dependencies [6e1056b]
- Updated dependencies [57ccce1]
- Updated dependencies [57ccce1]
- Updated dependencies [b390ef3]
  - @8bitscript/compiler@0.6.0
  - @8bitscript/atari8@0.6.0
  - @8bitscript/c128@0.6.0
  - @8bitscript/c64@0.6.0
  - @8bitscript/vic20@0.6.0
  - @8bitscript/pet@0.6.0
  - @8bitscript/mega65@0.6.0
  - @8bitscript/nes@0.6.0
  - @8bitscript/cx16@0.6.0
  - @8bitscript/web@0.6.0
  - @8bitscript/examples@0.6.0
  - @8bitscript/language-server@0.6.0
  - @8bitscript/studio@0.6.0

## 0.5.0

### Minor Changes

- 5666fe1: A program that changes the machine's character set now hands it back the way it found it. `8bitscript.config.ts` gains `restoreOnExit`, on by default: the prologue copies the PET's VIA PCR to the CPU stack and the epilogue writes it back, so a machine is returned in whichever mode it was launched in rather than a fixed one. It costs eight bytes and no RAM, and only a program whose finished code actually stores to `$E84C` pays them — which, since `@8bitscript/pet/text` no longer selects a character set at all (see that package's own note), means most programs pay nothing. `restoreOnExit: false` turns it off.
  
  One thing it deliberately does not try to do: un-draw. The PET's character-set bit is a single switch for the whole screen and it is retroactive, so a program that means to both return the machine and leave a readable screen has to blank the screen before it returns.
  
  The `hello-world` example no longer ends in a `while (true) waitFrame()` holding loop — it prints and returns, landing back in the BASIC `SYS` that started it. Its project file is also now named `8bitscript.config.ts`, the name the toolchain has preferred since 0.4.0.

### Patch Changes

- c8bd6c0: A release's assets are now one file per thing you can actually run. The attach step uploaded `dist/**/*` flattened, which scattered the web bundle's own internals across the release listing: `index.html`, `worker.js`, a Cloudflare `_headers` file, and a `program.wasm` that was a byte-for-byte copy of the `main.wasm` listed above it. The machine artifacts now upload as themselves and the web bundle uploads as a single `web-bundle.zip`, which is the only form it works in — its four files are one deployable unit, useless apart. The loose `.wasm` is left out for the same reason: it is already in the bundle, and alone it has no runtime to load it.
  
  `8bs build` also now says when an artifact's name is longer than the medium it is meant for can hold. CBM DOS gives a directory entry exactly sixteen characters for a filename and truncates anything longer with no error at all (measured with `c1541` on a real D64: a twenty-character name came back sixteen), so two builds whose names differ only past the sixteenth character are one file once they reach a floppy. It is a note rather than a refusal — every part of a generated name is there because it can change the bytes, so the build is valid, just awkward to carry to a disk.
- Updated dependencies [5754df7]
  - @8bitscript/pet@0.5.0
  - @8bitscript/examples@0.5.0
  - @8bitscript/studio@0.5.0
  - @8bitscript/compiler@0.5.0
  - @8bitscript/atari8@0.5.0
  - @8bitscript/c128@0.5.0
  - @8bitscript/c64@0.5.0
  - @8bitscript/cx16@0.5.0
  - @8bitscript/language-server@0.5.0
  - @8bitscript/mega65@0.5.0
  - @8bitscript/nes@0.5.0
  - @8bitscript/vic20@0.5.0
  - @8bitscript/web@0.5.0

## 0.4.1

### Patch Changes

- efabcfd: The web target's generated page now declares `viewport-fit=cover` and safe-area padding (no more drawing under a notch or the home-indicator strip), the `apple-mobile-web-app-capable` meta trio so Add to Home Screen launches full-screen with no browser chrome, and `resize()` now prefers `visualViewport` over `window.innerWidth`/`innerHeight` for the area actually visible. A best-effort, harmless-when-it-does-nothing nudge (`nudgeChromeCollapsed`) also tries to collapse a mobile browser's own toolbar on load and on rotation — there is no API that can guarantee this in an ordinary browser tab, only Add to Home Screen can.
- @8bitscript/atari8@0.4.1
  - @8bitscript/c128@0.4.1
  - @8bitscript/c64@0.4.1
  - @8bitscript/compiler@0.4.1
  - @8bitscript/cx16@0.4.1
  - @8bitscript/examples@0.4.1
  - @8bitscript/language-server@0.4.1
  - @8bitscript/mega65@0.4.1
  - @8bitscript/nes@0.4.1
  - @8bitscript/pet@0.4.1
  - @8bitscript/studio@0.4.1
  - @8bitscript/vic20@0.4.1
  - @8bitscript/web@0.4.1

## 0.4.0

### Minor Changes

- 1ab782e: `8bs build --release` builds every artifact a project's config declares for a release in one command: each release-ready target it lists, once per name in that target's own `release` array (a catalog preset, a project profile, or `{}` for the target's own default hardware), or once with its defaults when it lists none. The reusable `compile.yml` workflow calls it automatically when its `targets` input is left empty, so a project's release matrix — how many PET RAM/model variants, say — lives in one place, versioned with the project, instead of duplicated into CI. `compile.yml`'s `targets` also now accepts `target@profile:hardware=opts` entries for projects that would rather keep the matrix in CI.
  
  The project config file is now `8bitscript.config.ts`; the old `8bs.config.ts` name still loads, so no existing project needs to rename anything to pick up this release.

### Patch Changes

- @8bitscript/atari8@0.4.0
  - @8bitscript/c128@0.4.0
  - @8bitscript/c64@0.4.0
  - @8bitscript/compiler@0.4.0
  - @8bitscript/cx16@0.4.0
  - @8bitscript/examples@0.4.0
  - @8bitscript/language-server@0.4.0
  - @8bitscript/mega65@0.4.0
  - @8bitscript/nes@0.4.0
  - @8bitscript/pet@0.4.0
  - @8bitscript/studio@0.4.0
  - @8bitscript/vic20@0.4.0
  - @8bitscript/web@0.4.0

## 0.3.0

### Minor Changes

- 001c7e7: The web host draws the character grid from the same 8×8 bitmap font the screenshot path uses, and adds 2×2 block glyphs at codes 128–143 so a program can stamp PET-style digits.

### Patch Changes

- Updated dependencies [001c7e7]
  - @8bitscript/web@0.3.0
  - @8bitscript/examples@0.3.0
  - @8bitscript/studio@0.3.0
  - @8bitscript/compiler@0.3.0
  - @8bitscript/atari8@0.3.0
  - @8bitscript/c128@0.3.0
  - @8bitscript/c64@0.3.0
  - @8bitscript/cx16@0.3.0
  - @8bitscript/language-server@0.3.0
  - @8bitscript/mega65@0.3.0
  - @8bitscript/nes@0.3.0
  - @8bitscript/pet@0.3.0
  - @8bitscript/vic20@0.3.0

## 0.2.6

### Patch Changes

- 75cb131: `8bs run` keeps a muted VICE sound device open when the catalog said
  `+sound` (no speaker). GTK3 with no audio clock paces from vsync alone
  and stutters on Linux/Wayland; Pulse as a silent host clock does not.
  Screenshots still pass `+sound -warp`.
- @8bitscript/atari8@0.2.6
  - @8bitscript/c128@0.2.6
  - @8bitscript/c64@0.2.6
  - @8bitscript/compiler@0.2.6
  - @8bitscript/cx16@0.2.6
  - @8bitscript/examples@0.2.6
  - @8bitscript/language-server@0.2.6
  - @8bitscript/mega65@0.2.6
  - @8bitscript/nes@0.2.6
  - @8bitscript/pet@0.2.6
  - @8bitscript/studio@0.2.6
  - @8bitscript/vic20@0.2.6
  - @8bitscript/web@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies [0be3354]
  - @8bitscript/compiler@0.2.5
  - @8bitscript/language-server@0.2.5
  - @8bitscript/atari8@0.2.5
  - @8bitscript/c128@0.2.5
  - @8bitscript/c64@0.2.5
  - @8bitscript/cx16@0.2.5
  - @8bitscript/examples@0.2.5
  - @8bitscript/mega65@0.2.5
  - @8bitscript/nes@0.2.5
  - @8bitscript/pet@0.2.5
  - @8bitscript/studio@0.2.5
  - @8bitscript/vic20@0.2.5
  - @8bitscript/web@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [c143dbe]
- Updated dependencies [7e28950]
  - @8bitscript/compiler@0.2.4
  - @8bitscript/pet@0.2.4
  - @8bitscript/language-server@0.2.4
  - @8bitscript/examples@0.2.4
  - @8bitscript/studio@0.2.4
  - @8bitscript/atari8@0.2.4
  - @8bitscript/c128@0.2.4
  - @8bitscript/c64@0.2.4
  - @8bitscript/cx16@0.2.4
  - @8bitscript/mega65@0.2.4
  - @8bitscript/nes@0.2.4
  - @8bitscript/vic20@0.2.4
  - @8bitscript/web@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [d58bf12]
  - @8bitscript/compiler@0.2.3
  - @8bitscript/pet@0.2.3
  - @8bitscript/atari8@0.2.3
  - @8bitscript/nes@0.2.3
  - @8bitscript/language-server@0.2.3
  - @8bitscript/examples@0.2.3
  - @8bitscript/studio@0.2.3
  - @8bitscript/c128@0.2.3
  - @8bitscript/c64@0.2.3
  - @8bitscript/cx16@0.2.3
  - @8bitscript/mega65@0.2.3
  - @8bitscript/vic20@0.2.3
  - @8bitscript/web@0.2.3

## 0.2.2

### Patch Changes

- ee330ca: The launcher's Running section is now a Running machines tree. Run and
  build pass `--size`, so the per-function breakdown prints in the terminal
  before the emulator starts, and the same numbers — plus live FPS on the
  web — show in an expandable tree next to Stop. VICE has no live CPU
  readout: its monitor pauses the machine on any command.
- Updated dependencies [ee330ca]
  - @8bitscript/compiler@0.2.2
  - @8bitscript/language-server@0.2.2
  - @8bitscript/atari8@0.2.2
  - @8bitscript/c128@0.2.2
  - @8bitscript/c64@0.2.2
  - @8bitscript/cx16@0.2.2
  - @8bitscript/examples@0.2.2
  - @8bitscript/mega65@0.2.2
  - @8bitscript/nes@0.2.2
  - @8bitscript/pet@0.2.2
  - @8bitscript/studio@0.2.2
  - @8bitscript/vic20@0.2.2
  - @8bitscript/web@0.2.2

## 0.2.1

### Patch Changes

- b48b19b: Hello-world on the PET was 835 bytes of program and 49 of zero page because
  the compiler still emitted both `#fact` branches of asciiToScreenCode, a
  runtime ASCII conversion and string loop for `text.print(0, "Hello World!")`,
  JSRs into PET `blank`'s empty color stubs, a 16-bit STA (zp),Y screen fill,
  a 12-byte waitFrame scratch window, an unrolled 32-bit frameRate multiply
  (211 bytes of setup), and zp for helpers the program never reaches. Fold
  constant `if`s and never-assigned globals after pruning dead writers, turn a
  literal print into stores of already-converted screen codes, skip the string
  table entry those stores no longer need, inline a single-site void call
  whose parameters are unused, lower a constant fill loop to STA abs,X, and
  multiply waitFrame's measured elapsed with a Russian-peasant loop that
  reuses the accumulator — measured on the same example: 331 program bytes /
  8 zp. The per-frame waitFrame routine is unchanged; the print and fill are
  fewer cycles as well as fewer bytes. `--size` still names the inlined
  `text_print` / `screen_blank` bodies and splits wait-frame setup from the
  per-frame routine, so the report does not collapse into one `main` bucket.
- Updated dependencies [b48b19b]
- Updated dependencies [09ae45f]
- Updated dependencies [152a9f2]
  - @8bitscript/compiler@0.2.1
  - @8bitscript/pet@0.2.1
  - @8bitscript/language-server@0.2.1
  - @8bitscript/examples@0.2.1
  - @8bitscript/studio@0.2.1
  - @8bitscript/atari8@0.2.1
  - @8bitscript/c128@0.2.1
  - @8bitscript/c64@0.2.1
  - @8bitscript/cx16@0.2.1
  - @8bitscript/mega65@0.2.1
  - @8bitscript/nes@0.2.1
  - @8bitscript/vic20@0.2.1
  - @8bitscript/web@0.2.1

## 0.2.0

### Minor Changes

- 7e4c24e: Bare Metal: external code-generation toolchains are removed. 8BitScript now carries its own 6502 and WebAssembly backends in `@8bitscript/compiler` (`mos` and `wasm`), which do not yet build any target. The catalog key `build.driver` is renamed `build.startup`. `examples/` is removed.
- 75d5f27: `8bs build --target <t> --size` prints a per-function breakdown of the
  built program under the existing memory line — every function that
  survived reachability pruning, plus each backend's own fixed-cost
  buckets (the wait-frame runtime, the BASIC stub, a wasm module's own
  section framing), largest first, each with its own share of the total.
  Opt-in: without the flag, `8bs build` prints exactly what it always
  has.
- d7c558f: 0.2.0 is scoped to the Commodore PET and the web. `8bs build` and `8bs
  run` now refuse the other seven machines (vic20, c64, c128, atari8,
  nes, cx16, mega65) by name; their packages are unchanged and stay in
  the workspace, parked until their native backends land after 0.2.0.
  
  `@8bitscript/examples` is new: `hello-world`, the program both
  backends are built against, shipped with the CLI the way Studio is.
  The VS Code extension lists it by default and reads it from the
  package's own manifest rather than a fixed directory; it also now
  recognizes bun's lockfile alongside pnpm, npm, and yarn.
- 16e92f4: The `mos` and `wasm` backends in `@8bitscript/compiler` now emit for
  real. `8bs build` and `8bs run` work end to end for both 0.2.0 targets:
  `packages/examples/hello-world`, unmodified, builds, runs, and renders
  its own mixed-case "Hello World!" correctly on a real Commodore PET
  (checked against the `xpet` emulator) and in a real browser (checked
  against a real `--screenshot` run and the browser runtime's own
  generated page script). The `wasm` backend gained `&`, `|`, `^`, `<<`,
  and unsigned `>>` as real lowered operators (wasm's native
  `i32.and`/`i32.or`/`i32.xor`/`i32.shl`/`i32.shr_u`), needed once
  `@8bitscript/web/screen`'s own color masking (`value & 15`) became the
  first real caller. The web target's own text rendering (both the real
  browser canvas and the `--screenshot` bitmap font) now covers lower
  case too, matching what the checker's portable character set and the
  PET's own `asciiToScreenCode` have allowed all along — it previously
  covered upper case only, silently drawing every lower-case letter as a
  blank cell.
- a4aa759: Both native backends (`mos` and `wasm`) now compile only what a
  program's entry can actually reach, instead of every function and
  global an import brings along whether it's called or not. Measured on
  the real, unmodified `hello-world` example: the PET build shrank from
  1132 to 835 bytes of program (26% smaller, plus 101 to 49 bytes of
  RAM), and the web build's `.wasm` shrank from 614 to 408 bytes (34%
  smaller) — one `@8bitscript/text` import used to pull in `putChar`,
  `putColor`, `setColor`, `setReverse`, and `printNumber`'s whole
  decimal-digit loop alongside the `print()` a program actually calls.
  No language, API, or output behavior changed — only what nothing ever
  uses is gone.

### Patch Changes

- 57c262f: Normalized spelling in comments, docs, and user-facing strings
  (package descriptions, editor hover/grammar text, diagnostic prose) to
  match the spelling the code's own identifiers already use — `color`
  not `colour`, `behavior` not `behaviour`, `initialize`/`optimize`/
  `recognize` rather than `-ise`, and a handful of one-off words. No
  behavior, API, or identifier changed; this is text only. The `GREY`
  constant (`BorderColor.GREY`, `BackgroundColor.GREY`) and its prose
  mentions are left alone — that one's a real public API surface, a
  separate decision from a text-only pass like this.
- Updated dependencies [7e4c24e]
- Updated dependencies [75d5f27]
- Updated dependencies [d7c558f]
- Updated dependencies [16e92f4]
- Updated dependencies [3827a1c]
- Updated dependencies [a4aa759]
- Updated dependencies [57c262f]
  - @8bitscript/atari8@0.2.0
  - @8bitscript/c64@0.2.0
  - @8bitscript/c128@0.2.0
  - @8bitscript/compiler@0.2.0
  - @8bitscript/cx16@0.2.0
  - @8bitscript/language-server@0.2.0
  - @8bitscript/mega65@0.2.0
  - @8bitscript/nes@0.2.0
  - @8bitscript/pet@0.2.0
  - @8bitscript/studio@0.2.0
  - @8bitscript/vic20@0.2.0
  - @8bitscript/web@0.2.0
  - @8bitscript/examples@0.2.0

## 0.1.3

### Patch Changes

- 7547105: The VS Code extension now ships a Marketplace icon (the pixel-8 mark from
  the favicon, on the same purple/cream palette) instead of using the
  Marketplace's generic default.
- 47eaff5: Pin the workspace's `packageManager` to pnpm 12.3.4 (up from 12.1.0) and
  recommend the `8bitscript.8bitscript-lang` VS Code extension in this
  repo's `.vscode/extensions.json`. The VS Code extension also gains a
  Marketplace icon (the pixel-8 mark, on the same purple/cream palette as
  `docs/assets/favicon.svg`) instead of falling back to the generic default.
- Updated dependencies [7547105]
- Updated dependencies [47eaff5]
  - @8bitscript/atari8@0.1.3
  - @8bitscript/backend-6502@0.1.3
  - @8bitscript/backend-web@0.1.3
  - @8bitscript/c64@0.1.3
  - @8bitscript/c128@0.1.3
  - @8bitscript/compiler@0.1.3
  - @8bitscript/cx16@0.1.3
  - @8bitscript/language-server@0.1.3
  - @8bitscript/mega65@0.1.3
  - @8bitscript/nes@0.1.3
  - @8bitscript/pet@0.1.3
  - @8bitscript/studio@0.1.3
  - @8bitscript/vic20@0.1.3
  - @8bitscript/web@0.1.3

## 0.1.2

### Patch Changes

- b9aea09: The editor talks to `8bs lsp` with a thin stdio client instead of
  `vscode-languageclient`, so the VSIX is tens of kilobytes. Marketplace
  publish no longer uses vsce's 180-second gallery timeout.
- Updated dependencies [b9aea09]
  - @8bitscript/atari8@0.1.2
  - @8bitscript/backend-6502@0.1.2
  - @8bitscript/backend-web@0.1.2
  - @8bitscript/c64@0.1.2
  - @8bitscript/c128@0.1.2
  - @8bitscript/compiler@0.1.2
  - @8bitscript/cx16@0.1.2
  - @8bitscript/language-server@0.1.2
  - @8bitscript/mega65@0.1.2
  - @8bitscript/nes@0.1.2
  - @8bitscript/pet@0.1.2
  - @8bitscript/studio@0.1.2
  - @8bitscript/vic20@0.1.2
  - @8bitscript/web@0.1.2

## 0.1.1

### Patch Changes

- d56d494: Added a "How it compares" section to the root README, docs/about, and
  the VS Code extension's README, positioning 8BitScript against BASIC,
  hand-written assembly, and C with measured compiled-size numbers.
- Updated dependencies [d56d494]
  - @8bitscript/atari8@0.1.1
  - @8bitscript/backend-6502@0.1.1
  - @8bitscript/backend-web@0.1.1
  - @8bitscript/c64@0.1.1
  - @8bitscript/c128@0.1.1
  - @8bitscript/compiler@0.1.1
  - @8bitscript/cx16@0.1.1
  - @8bitscript/language-server@0.1.1
  - @8bitscript/mega65@0.1.1
  - @8bitscript/nes@0.1.1
  - @8bitscript/pet@0.1.1
  - @8bitscript/studio@0.1.1
  - @8bitscript/vic20@0.1.1
  - @8bitscript/web@0.1.1
