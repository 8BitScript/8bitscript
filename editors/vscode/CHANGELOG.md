# 8bitscript-lang

## 0.22.0

No changes in this release.

## 0.21.0

### Minor Changes

- d4385cb: **Open Studio**: the largest button on the side bar, above Quick launch — Studio on the Commander X16, its baseline, with no change to the selected project — and a ▾ sliver on its edge whose menu opens Studio on any of its systems; the packages block only appears when something needs installing; `8BitScript: Open Studio` on the palette. The title bar's rocket keeps the quick pick.
- dff55d0: Studio in an editor tab. The Open Studio button's menu gains **In an editor tab** (and the palette **8BitScript: Open Studio in a Tab**): `8bs run cx16 --web` builds Studio and serves the CLI's WebAssembly x16emu on loopback, and a **Studio** tab frames it with Reset, Rebuild, Stop and Open in browser above the screen. Closing the tab ends the run. The tab's mouse line says whether Studio has the mouse (a click on the screen gives it, Esc takes it back) and, should the editor not let a framed page capture it, points at Open in browser. Needs a CLI with `8bs run cx16 --web`.

### Patch Changes

- a9d7596: The VS Code launcher passes `--capture-mouse` and `--fullscreen` on native Commander X16 runs and boots by default (`8bitscript.cx16.captureMouse` and `8bitscript.cx16.fullscreen` in Settings). Studio in a tab is unchanged. The CLI accepts the same flags for `8bs run cx16` and `8bs boot cx16`; a terminal launch without them still starts with a free mouse and a window.
- 38c8dfc: Studio has a light mode beside its dark one — a white screen, black ink, a blue bar — switched from the mark's menu on every machine with more than two colors; the extension's panels already follow the editor's theme, and a test now holds them to it (no colors of their own outside the LAN QR code).

## 0.20.0

No changes in this release.

## 0.19.1

No changes in this release.

## 0.19.0

No changes in this release.

## 0.18.0

No changes in this release.

## 0.17.0

### Minor Changes

- e2d7792: "View Generated Assembly" now explains itself. Each run of instructions is introduced by the source line it came from (`; line 98: screen.blank(...)`, the way the `.lst` already does), and every instruction carries a plain-English comment saying what the machine does — `LDA #$06  ; A = 6`, `STA $02  ; keysBefore = A`, `JSR $0668  ; call screen_blank`, `BEQ $043C  ; if zero, loop back to $043C` — with the program's own globals and functions named in place of bare addresses wherever the debug map knows them, and never guessed where it doesn't. The per-instruction column is on by default and toggled from the assembly tab's title bar (**Toggle Plain-English Comments**, `8bitscript.assemblyView.explain`), re-rendering open tabs in place without a rebuild; a compiler-inserted instruction's reason now reads `(compiler-generated: branch-relaxation)`, matching the `.lst`.

## 0.16.0

### Patch Changes

- b6dbbbb: `8bs doctor` offers to install pnpm (`npx get-pnpm`) and to run `8bs setup cx16` / `8bs setup mega65` for the source-built emulators. The editor finds pnpm where the installer actually puts it — including `~/Library/pnpm` on macOS — and offers **Run Doctor** instead of lecturing about `.zshrc`.

## 0.15.0

### Minor Changes

- 0c3f890: "View Generated Assembly" now colors its listing with a real 6502 assembly grammar, shows the whole file rather than just the statement under the cursor (so the view stays put regardless of where you click in the source), and gains "View Generated Assembly For…" plus an open tab's own "Open For Another Machine…" button to open several machines' listings side by side. Saving any `.8bs`/`.8bx` file in the same project rebuilds every open tab in place, preserving scroll position and selection and never blanking a tab on a mid-edit build failure.
- 5d6dc92: Native builds can now retain source provenance through lowering, assembly, and branch relaxation, and `8bs build --debug` writes a human-readable `.lst` listing and a versioned `.8bs.debug.json` debug map alongside the artifact. The VS Code extension adds "8BitScript: View Generated Assembly", which opens the generated instructions for the file beside the editor and navigates back to source on selection. Off by default; release builds are unaffected.

### Patch Changes

- 8225ec7: The launcher's System dropdown no longer snaps back to PET when a program has no named systems. An empty named system is stored as `''`, and `??` was keeping that blank instead of the machine id, so the dropdown fell through to its first option.

## 0.14.0

No changes in this release.

## 0.13.1

### Patch Changes

- 3094830: The editor knows `#package(...)`: hovering it explains the fields it reads
  and the diagnostics it refuses with, completion after `#` offers it next to
  `#frames`, `#system` and `#fact`, and a `#package` snippet expands to the
  `const VERSION: string = #package("version")` a title screen wants.

## 0.13.0

### Patch Changes

- ceda09a: SonarCloud's quality gate on trunk was failing on Reliability of New Code
  (C, needs A): super-linear regexes, a thenable-looking IR `then` field,
  always-false `===` checks, a loop that could only run once, and a handful
  of related smells. The regexes are now ordinary scans, the IR field is
  named where it stands with the same NOSONAR the rest of the compiler
  already uses, and the rest of the findings are the same behaviour without
  the pattern the gate was scoring.

## 0.12.0

No changes in this release.

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
- 8309efa: 8BX element syntax is tokenized by the lexer, in tag, children and
  expression modes, and read by the parser token by token — no more
  re-scanning source text at a `<`. Every span is a token's, so a
  diagnostic inside a `{…}` attribute or child points into the file
  (and reaches the editor with the right range), `<` opens a tag only where
  no value sits before it (`a < b`, `array<u8, 4>` and `x << 2` are what
  they were; `if (x) <Foo />;` works), raw text between tags is one token
  in which `don't`, `//` and `>` are just text, and a half-typed tag ends
  with one diagnostic and a parser that keeps going. Text children are
  normalized the JSX way, once, in the parser. `<Studio.Window />` names
  parse; an element parses where a value is expected (a `?:` arm), for
  its spans. The VS Code grammar colors `component`, tags, attributes and
  embedded expressions in `.8bx`.
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
- 1de8025: IntelliSense for a program's own names, from the binder (8BX spec PR 15).
  Hover on a component, function, variable, const, parameter or `state`
  field shows its declaration and the doc comment above it, following an
  import to the file it comes from — a component called from `.8bs`
  (`MenuBar();`) is the same component as `<MenuBar />`. Completion offers
  the names visible from the cursor; in `.8bx`, `<` offers the components
  in scope and `slot`, a component's tag offers the props it still needs
  (as snippets), and `</` closes the innermost open element. New
  `getDefinition` in the compiler and `textDocument/definition` in the
  language server: Go to Definition lands on the declaration, in this file
  or another. Hover and completion now lex an `.8bx` buffer as one.

### Patch Changes

- b5173e9: An `.8bx` file opened in VS Code now reaches the language server: the
  client only accepted the `8bitscript` language id, so a file registered
  as `8bitextensible` got highlighting and nothing else — no diagnostics,
  hover or completion. Both ids go to the one server, which tells the two
  source kinds apart by extension.
- 987fa42: `.8bx` highlighting knows an element as a whole: from `<Name` through its
  props to the `/>` or the matching `</Name>`, with the children between —
  nested elements, text left plain, `{ … }` expressions with `?:` and `&&`
  composing elements — and a fragment `<>` … `</>`. The grammar is now run
  through Oniguruma in the extension's tests, not just compiled.

## 0.10.2

No changes in this release.

## 0.10.1

No changes in this release.

## 0.10.0

No changes in this release.

## 0.9.1

### Patch Changes

- 5a29ff3: Run and Build from the side bar use a real `node`, not Cursor's Electron helper.
  
  A `.mjs` toolchain used to launch as `process.execPath`, which inside the
  editor is the Plugin Helper. A task terminal is not `ELECTRON_RUN_AS_NODE`,
  so that helper started as a GUI and died on `--system` / `--checkout`.
- 9a6a9d7: The extension README no longer describes 0.2.0 as the current release.
  
  Marketplace 0.9.0 still shipped the 0.2.0 copy that said only PET and
  the web build. The System list is all nine `RELEASE_MACHINES`, and Run
  and Build work for each of them.

## 0.9.0

### Minor Changes

- 715dec5: The side bar's "..." menu has **Enable Local Development Extension** / **Use Official Extension**, below Controller Setup — the UI half of what `pnpm --filter 8bitscript-lang run link-local` already did from a terminal. Enabling points the editor's extensions folder at an open workspace checkout, the editor's own managed clone, `8bitscript.checkout`, or a folder you pick, whichever resolves first — same order `--checkout` already uses. Disabling removes that link and asks the editor's own install command for the Marketplace/Open VSX build back, rather than fetching or extracting anything itself.

## 0.8.0

### Minor Changes

- 2026d01: Named systems live in three layers — advertised in 8bitscript.config.ts, this clone's .8bitscript/systems.json, and ~/.config/8bitscript/systems.json — and `8bs run --system` / `build` / `boot` resolve through that merge. `--checkout` (or EIGHTBITSCRIPT_CHECKOUT / toolchain.json) points a consumer at a local 8BitScript tree without rewriting its package.json. The editor's side bar has one Update/Install for that tree (workspace repo, or a clone under the extension's global storage) plus named-system quick launch; Configure System and Show Project are editor tabs.

### Patch Changes

- 2026d01: A source-checkout install watches `editors/vscode` and prompts **Rebuild the local extension** instead of compiling in the background. **Reload this window** appears only after that rebuild finishes. A window reload still compiles a stale `src/` so Developer: Reload Window cannot load yesterday's bundle. `pnpm --filter 8bitscript-lang run link-local` replaces a pinned VSIX copy with a symlink of this tree — a `.vsix` install does not auto-update from the gallery.
  
  Bundling no longer leaves Controller Setup reading `dist/controllerProfile.cjs` from a path esbuild does not write: the file is copied next to the bundle, and a checkout falls back to `src/` so activate cannot ENOENT.
- 2026d01: `8bs run web` binds an ephemeral port by default so two runs can coexist (`--port n` still pins one). The launcher shows a QR of the LAN HTTPS URL on a web run so a phone on the same Wi-Fi can open it without typing the address.

## 0.7.1

No changes in this release.

## 0.7.0

No changes in this release.

## 0.6.2

### Patch Changes

- 8e3a326: `8bs run web` serves on port 8008 (HTTPS 8009) and on the LAN by default so a phone on the same Wi-Fi can reopen the same URL (`--local` is loopback only, `--port` picks another). The editor setting `8bitscript.webLan` turns LAN off.

## 0.6.1

No changes in this release.

## 0.6.0

### Patch Changes

- 8f71acb: A first Atari 8-bit run from the editor loads a disk `.xex`, not an 8K cartridge.
  
  The launcher's "nothing chosen" fallback picks the smallest `memory.ram` on a **RAM-size** option — every value of it states that fact, the way the PET's `ram` and the VIC-20's memory do. An Atari cartridge value publishes 6400 because that is the RAM window a cart gets, a different program shape the native backend cannot build. Treating that number as "the tightest fit of the same machine" made a first `8bs run atari8` pass `--hardware media=cart8` and die. Pick Media → 8K cartridge on purpose and the compiler still refuses it by name.
- 188cd63: Each machine's hardware catalog now says what a controller **carries**, not just how many ports it has — and a controller's *kind* is derived from that list rather than written down beside it.
  
  `input.joysticks: 2` and `input.pads: 2` count ports. They cannot be projected onto a real control list, because two machines with two pad ports each can take entirely different pads: the NES's eight bits and the X16's twelve are both "2". So the editor's Controller Setup panel kept two tables of its own — what each kind of device carries, and which pad each machine takes — and its own comment said it should not have to. Those tables are gone.
  
  **The new fact is `input.controls`**: the logical controls, in 8BitScript's own names, that the controller on this machine's ports actually carries.
  
  | machine | declares | derived kind |
  |---|---|---|
  | PET | — | none |
  | VIC-20 | `up down left right a` | `atari-stick` |
  | C64 | `up down left right a` | `atari-stick` |
  | C128 | `up down left right a` | `atari-stick` |
  | Atari 8-bit | `up down left right a` | `atari-stick` |
  | MEGA65 | `up down left right a` | `atari-stick` |
  | NES | `a b select start up down left right` | `nes-pad` |
  | Commander X16 | `up down left right a b x y l r start select` | `snes-pad` |
  | web | — | none |
  
  Every row is the repository's own research, not recall. `packages/c64/src/joystick.8bs` declares `Joystick.UP`/`DOWN`/`LEFT`/`RIGHT`/`FIRE` — five switches shorting to ground, the whole of the nine-pin Atari standard; `packages/vic20/AGENTS.md` traces the VIC-20's same five lines across two VIAs (right is VIA2 port B bit 7, a keyboard-column line); `packages/atari8/AGENTS.md` records that the Atari's own masks are bit for bit the C64's with `JOY_BTN_1_MASK` the only button, which is why `@8bitscript/atari8/joystick` can export the same values without either machine being fudged; `packages/c128/AGENTS.md` and `packages/mega65/AGENTS.md` both say CIA1 as the C64's. `packages/nes/src/pad.8bs` names the shift register's fixed order — A, B, SELECT, START, UP, DOWN, LEFT, RIGHT — and the catalog lists them in that order for that reason. The one button on a stick is `a` rather than `b`: it is the only button the machine has, and `a` is the one control every wider shape has in common.
  
  **The X16 is the machine this branch could not fully establish.** `packages/cx16/AGENTS.md` settles that it has two SNES pad ports (and that the KERNAL's reader for them is confusingly called `joystick_get`, `$FF56`). The twelve controls are the SNES pad's own set. What this repository does *not* carry is the bit layout `joystick_get` returns, and nothing here invents one — `packages/cx16/src/input.8bs` is still an honest stub that reads neither the pads nor the keyboard. The catalog says what the ports hold; it does not yet say what order the bits arrive in.
  
  **A kind is derived, never declared.** Nothing in a catalog spells `nes-pad`. `CONTROLLER_KINDS` in `packages/compiler/src/fold/facts.mjs` names four shapes and the exact set of controls each one is — `atari-stick` (5), `nes-pad` (8), `snes-pad` (12), `xbox-style` (all 18) — and `controllerKind(controls)` matches a machine's list against them. A name stored beside the shape it names is two statements that can disagree, and the one that can be checked would lose to the one that cannot. It also means a machine added tomorrow whose controller happens to be an Atari stick is recognised as one without a line of code changing at either end, which is the point. Matching is exact set equality rather than a subset ladder: a two-button stick clears the bar for `a` and `b` and is still not an NES pad, and a shape that matches nothing is `null` rather than the nearest guess.
  
  `xbox-style` is in the table and no machine carries it. It is the shape of the *host* pad this project develops against — the 8BitDo SN30 Pro in X-input mode that `docs/project/input.md` names as the development standard — and it is the superset the other three are projected out of, so naming it costs nothing and leaves the ladder complete.
  
  **Where it lives in a catalog matters.** The Commodores declare it on the `joystick` *value* of `port1`/`port2`, because on those machines what is in the port is a choice: `--hardware port1=none,port2=none` really does resolve to no controls, and the panel says so instead of drawing five controls onto an empty port. It is deliberately *absent* from `none`, `paddles` and `mouse1351` rather than empty on them — option values merge in catalog order, so a `[]` on port 2's `none` would erase the stick port 1 really has. Paddles and a 1351 already have their own facts. The machines whose pads have no option behind them — the Atari, the MEGA65, the NES, the X16 — declare it at machine level, and the PET and the web target declare nothing, out loud.
  
  **`input.controls` is the first fact that is a list**, which needed two things of the compiler. `factProblems` now checks that a catalog's list is an array of real control names and says which one is wrong, because a typo there is a control that silently never projects. And `#fact(input.controls)` is refused by name: there is no literal to fold a list into, and folding one would have handed the IR an array where an integer goes — a miscompile rather than an error. It is `program: false` for the same reason, so it is off `@8bitscript/system` and off a program's sheet; the editor and `8bs targets --json` read it, a program asks its input layer.
  
  The eighteen control names now have an owner. They were spelled out in three places — the compiler had none, the CLI's `controllers.mjs` and the editor's panel had one each. `LOGICAL_CONTROLS` in the compiler is the list a catalog is validated against, and the other two copies are held equal to it by tests: the CLI's directly, the editor's through the same import its own test makes, because the extension has no dependencies at all and can only ever see this as JSON.
  
  **What the editor deleted.** `DEVICE_CONTROLS` and `PAD_KINDS` in `editors/vscode/src/controllerProfile.cjs`. `project()` reads `input.controls` off the resolved fact sheet it was already being handed, and derives the kind from the shapes the toolchain publishes on the `input.controls` fact's own description — which is where a table that is the *vocabulary* belongs, rather than on any one machine's sheet. A toolchain too old to publish the shapes still gets the right controls, only without a name for them; a machine with ports and nothing said about what is in them gets a sentence rather than an invented pad.
- 188cd63: A **Controller Setup** panel in the editor: find the pads plugged into this machine, say what their buttons are called in 8BitScript's terms, and write that down in the project.
  
  `8BitScript: Controller Setup` opens a webview panel — an editor tab rather than a side bar view, because a gamepad silhouette does not fit in 300px and a page polling an animation frame has no business staying resident behind a tree. Detection is in the page, on `navigator.getGamepads()`, because the extension host is Node and has no HID; everything done with those frames is in two modules that never import `vscode` (`src/controllerProfile.cjs`, `src/controllerStore.cjs`) and are tested with plain `node --test`. The page is handed the *same* profile module behind a three-line CommonJS shim rather than a second copy of it: the deadzone that turns a shoved stick into a direction is part of what a profile means, and two copies of that number would be two profiles.
  
  Each controller assigns to Unassigned or Player 1-4. A live view lights every raw button and draws every axis, so "is the device talking" can be answered before "is my mapping right". The mapper is an inline-SVG pad — inline because the webview's CSP names no image source at all — that can be clicked control-first, or walked through control by control; each step waits for the pad to go quiet before it listens, because the previous step's button is usually still held.
  
  **The stored profile is in 8BitScript's own names**, never a machine's and never a driver's:
  
      up down left right  a b x y  l r  start select
      leftStickX leftStickY rightStickX rightStickY  lt rt
  
  A profile phrased in X-input's terms would be a statement about the driver somebody happened to boot with; one phrased in the NES pad's terms could not be projected onto a VIC-20. The reference device — an 8BitDo SN30 Pro in X-input mode — is the test pad and the picture, not the model. Its two stick clicks are deliberately unnamed: no machine in the catalog has anywhere to put them, and an `l3` in every stored profile would be a control nothing downstream could read.
  
  It is stored as `8bitscript.controllers.json` beside `8bitscript.config.ts`, not as a block inside it. The config is source: `saveSystem` writes into it through a `WorkspaceEdit` so the write lands in the undo stack, and refuses a shape it cannot safely edit. That care is right for a line a person reads and wrong for eighteen machine-generated bindings per device rewritten on every button press. It is also not knowledge the compiler needs — which pad is Player 1 changes what an emulator is launched with, not what is built — and JSON is `JSON.parse` for anything that is not this editor, where the config is TypeScript that has to be evaluated.
  
  A **target preview** projects the mapping onto every machine. The port counts are the toolchain's answer, not a table here: `input.joysticks` and `input.pads` out of `8bs targets --json`, resolved through `effectiveFacts` with the hardware each machine is actually fitted with — the Atari's multiplexer really does raise `input.joysticks` to 4, and a preview computed from stock facts would disagree with the machine a Run starts.
  
  ## How it reaches `8bs run`
  
  `packages/cli/src/controllers.mjs` reads `8bitscript.controllers.json` itself — `controllerPlayers()` takes the very object `controllerStore.cjs` writes, keeps the same eighteen control names, and parses the same four binding shapes (its parser rejects `button:3-` as a typo for the same reason this one does). From there it is that file's business to turn a player into `-joydev`, a generated `.vjm`, an `SDL2_JOY_<n>_UP` or a named refusal. The host joystick number is the player number minus one, which is why the pads want plugging in in player order.
  
  **A keyboard key is a binding, not a special case.** `key:<KeyboardEvent.code>` is the fourth shape, and on the Atari it is the only one: atari800 has no per-button controller mapping at all. This end used to reject it, which would have been a documented gap except that `normalizeProfile` rewrites the file on every save and drops what it cannot read — so a hand-written Atari keyboard stick worked until somebody opened the panel and pressed one button, and then it was gone with nothing said.
  
  It is in `parseBinding` rather than beside it because three of that function's callers are not asking "what is the pad doing": `answered` (has this control an answer at all — the per-machine preview), `resolveDirection` (is this direction bound, or does it fall back to the stick), and the page's binding table (does this row say a name or say *not bound*). Held at arm's length, a fully bound Atari keyboard stick showed all four directions and its fire button as **missing** on the one machine it was written for. The rest of the callers read live state and have an answer too: a webview has `keydown` and `keyup`, so a held key lights the silhouette, fills a meter and can be captured — which is what makes an Atari stick reachable from the walkthrough instead of only by hand. Escape is never captured (it is what cancels a step) but round-trips if written by hand, and held keys are dropped on blur so a key held while the window loses focus cannot bind itself to whatever is asked for next.
  
  An earlier version of this panel emitted a `controllers.players` block for `8bitscript.config.ts`, because that is where the CLI first read a profile from. That is gone with the reader: offering somebody a snippet to paste into a config nothing consults would be exactly the kind of quiet trap this branch has spent its time closing.
  
  ## What this needed from the CLI
  
  Everything this panel asked of the toolchain has since been answered, and the asks are recorded only so the trail is complete.
  
  **What a port's device carries**, which was the last of them. The catalog said how many ports and, for the Commodores, what could go in one (`port1: none | joystick | paddles | mouse1351`), and never that an Atari-standard joystick is four switches and one button, that an NES pad is eight bits, or that the X16 takes a twelve-button SNES pad — so `input.pads: 2` could not be projected without knowing *which* pad, and `DEVICE_CONTROLS` and `PAD_KINDS` at the bottom of `editors/vscode/src/controllerProfile.cjs` were where the editor kept the answer for two machines and a documented gap for a third. Every machine package now declares `input.controls` and `8bs targets --json` publishes it, along with the shapes that have a name; both tables are deleted. See `.changeset/controller-catalog.md`. **Which port the first player drives**: `8bs targets --json` now publishes `primaryPort` per machine and the preview takes it; `PRIMARY_PORT` here is down to the two machines `packages/c64/src/joystick.8bs` documents and answers only for a toolchain too old to say. **How a profile reaches a launch**: the CLI reads this file directly.
  
  ## Known limitation, unverified against a live window
  
  Chromium gates `navigator.getGamepads()` behind the `gamepad` permissions policy, whose default allowlist is `self`. A VS Code webview is a cross-origin `vscode-webview://` iframe, and an extension cannot set the `allow` attribute on the iframe the editor creates. In Cursor's bundled workbench that attribute is `["cross-origin-isolated", "autoplay"]` plus the two clipboard features, and the string `gamepad` appears nowhere in the bundle — so a cross-origin child should not be granted it. That is static evidence, not a measurement: whether the call throws, returns nothing, or works anyway in this host is the first thing to check with a pad in hand.
  
  The panel is built so either outcome is honest. A refused call — an absent API, or a `SecurityError` from the policy — is reported as *"this window is not handing the panel gamepad access"*, never as an empty device list. A policy that answers silently instead of refusing is caught by the one contradiction it leaves: a `gamepadconnected` event from a window that has never once been able to list a pad. If the policy suppresses the *events* as well as the readings, that second mechanism is inert and the panel falls back to "no controller seen yet" — the safe direction, but not a complete detection.
  
  Two more things a person with a pad should know:
  
  - **Two identical controllers are told apart by connection order.** Two 8BitDo SN30 Pros report byte-identical `Gamepad.id` strings, which is the ordinary Player 1 + Player 2 setup, so the second and later get `#2`, `#3` by their position in the browser's list. The Gamepad API exposes no serial number and `Gamepad.index` is the same plug-ordered number wearing a different hat, so swapping the cables swaps the two profiles — fixable by changing one `player` in the file, and better than mapping only one of the two.
  - **A pad that rests an axis away from centre never goes quiet**, so a walkthrough step waiting for you to let go of everything would sit there. The prompt names what it is still reading (`Still reading: axis 2`) rather than hanging silently, the live view shows the same thing unmapped, and Esc leaves; each control can still be bound on its own from the table.
- c85fa23: Controller profiles live in `~/.config/8bitscript/`, not the project. An 8BitDo at one desk is not a `systems` block.
  
  Gamepad API button numbers are not written into VICE `.vjm` files — they are the browser's indices, not SDL's, and `!CLEAR` plus those numbers is how a working pad went dead the moment a profile appeared. FCEUX `--input1 gamepad` (the help text) is not what UpdateInput() matches — that is `GamePad.0`; lowercase `gamepad` is SI_NONE, an empty NES port, and it persists into `~/.fceux/fceux.cfg`.

## 0.5.0

### Patch Changes

- c245f9b: The VS Code extension now recognizes `8bitscript.config.ts` alongside the older `8bs.config.ts`, catching up with the CLI's rename: the extension activates and the launcher discovers a project under either name (a directory with both is one project, under the new name — the same precedence as the CLI's loader), and the file watcher, examples directory, shipped apps, task resolution, and the Open 8bitscript.config.ts command all follow whichever config the project has.

## 0.4.1

No changes in this release.

## 0.4.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.6

No changes in this release.

## 0.2.5

No changes in this release.

## 0.2.4

No changes in this release.

## 0.2.3

No changes in this release.

## 0.2.2

### Patch Changes

- ee330ca: The launcher's Running section is now a Running machines tree. Run and
  build pass `--size`, so the per-function breakdown prints in the terminal
  before the emulator starts, and the same numbers — plus live FPS on the
  web — show in an expandable tree next to Stop. VICE has no live CPU
  readout: its monitor pauses the machine on any command.

## 0.2.1

### Patch Changes

- 09ae45f: Hover and completion now cover a named import's own namespace, not just
  built-in syntax: hovering `screen.blank(...)` shows its signature and doc
  comment, and typing `screen.bl` after `import { screen } from
  "@8bitscript/screen"` offers `blank` in the completion list. This reads the
  module the import actually resolves to — for a machine-conditional package
  such as `@8bitscript/screen`, one release target's version (noted in the
  hover text), since no single machine is known while editing.
- 152a9f2: Resolved SonarQube findings in `editors/vscode/src/projects.cjs` (an
  explicit sort compare function, a `.map()` callback no longer passed
  a function with its own second parameter directly, two regexes with
  quadratic worst-case behavior replaced with plain string methods, and
  a hand-rolled scanner's loop rewritten so its own cursor isn't a
  reassigned `for` variable) and `packages/compiler/src/mos/asm/relax.ts`
  (`Number.parseInt` instead of the global). No behavior change.

## 0.2.0

### Minor Changes

- 7e4c24e: Bare Metal: external code-generation toolchains are removed. 8BitScript now carries its own 6502 and WebAssembly backends in `@8bitscript/compiler` (`mos` and `wasm`), which do not yet build any target. The catalog key `build.driver` is renamed `build.startup`. `examples/` is removed.
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

## 0.1.2

### Patch Changes

- b9aea09: The editor talks to `8bs lsp` with a thin stdio client instead of
  `vscode-languageclient`, so the VSIX is tens of kilobytes. Marketplace
  publish no longer uses vsce's 180-second gallery timeout.

## 0.1.1

### Patch Changes

- d56d494: Added a "How it compares" section to the root README, docs/about, and
  the VS Code extension's README, positioning 8BitScript against BASIC,
  hand-written assembly, and C with measured compiled-size numbers.
