# 8BitScript for VS Code and Cursor

Syntax highlighting, a real language server, and a project runner for `.8bs`
files. The extension itself is still a thin client: it finds the project's
`8bs` toolchain and runs `8bs lsp --stdio`, and every diagnostic, hover, and
completion it shows comes from `@8bitscript/compiler` through that server —
not from anything reimplemented here. The same goes for building and running:
the side bar's launcher only ever starts the `8bs run` and `8bs build`
commands you would otherwise type. See [Editor support](../../docs/language-server.md) for
the split between the compiler, the language server, and this extension.

## New to 8BitScript?

It's a statically compiled language for 6502-based 8-bit machines and the
web — closer to C than to BASIC or hand-written assembly. There's no
interpreter and no garbage collector; 8BitScript's own backends lower IR
to machine code and WebAssembly. `8bs build` and `8bs run` work end to
end for all nine targets — PET, VIC-20, C64, C128, Commander X16,
MEGA65, Atari 8-bit, NES, and the web — right from this extension's own
launcher. A range-checked type like `u8` is a compile error on overflow
(`300 does not fit in u8 (0..255)`) instead of a silent wrap, and one
source resolves per target through packages instead of `#ifdef`. The
System list is those nine, the same `RELEASE_MACHINES` set the CLI uses.

Compiled size sits close to hand-written C for that same reason: the same
screen built by hand in C came to 178 bytes on a C64, the equivalent
through 8BitScript's portable `screen`/`text` calls to 482, and through a
reusable UI component to 809 — the difference being what gets computed at
compile time (the hand-written version) versus resolved at run time (the
portable one). `8bs build` reports exactly what a program used, and a
build that doesn't fit its machine's RAM — 3583 bytes on the unexpanded
VIC-20 8BitScript targets first — is refused rather than truncated.

Full byte-by-byte accounting is in
[docs/compiler.md](../../docs/compiler.md#what-a-call-costs-on-a-6502-measured);
the project overview is in the [root README](../../README.md).

## What it does

- Registers `.8bs` as the language **8BitScript**, and `.8bx` as **8BitX**
  (`8bitextensible`), both served by the same language server
- Colors comments, strings and template strings (with their `${...}`
  fields), numbers (including the `0.5` a `#frames(...)` duration takes),
  types, keywords, declarations, calls, the compile-time `#frames(...)`
  and `#system()` (any `#name` colors as compile-time), the reserved `waitFrame()`, and
  the `seconds` unit inside a `#frames(...)` call
- In `.8bx`, also the `component` and `state` declarations, tags (`<Foo … />`,
  `</Foo>`, `<>`, `<slot />`) with their component names and attributes,
  and `{ … }` expressions inside them, which color as 8BitScript again;
  text between tags stays plain
- **Snippets** for the constructs that compile — `program`, `loop`,
  `countdown`, `print`, `#frames`, `#package`, `const`, `let`, `for`, `array`,
  `table`, `address`, `namespace`, `asm6502`, `poke`/`peek`. Nothing is offered that the compiler would
  reject, and the compiler's own test suite is what holds that
- `//` line comments and `/* */` blocks, so comment-toggling works, and a
  `/** */` block continues its `*` column on Enter
- Bracket matching, auto-closing pairs, and `// #region` folding
- Starts the language server (`8bs lsp --stdio`) when a `.8bs` file is open
  and the toolchain is installed, giving you:
  - **Diagnostics** — lexical, syntax, and range errors, as you type
  - **Hover** — documentation for built-in types (`utinyint`, `int`, ...),
    constructs (`string`, `volatile`, `ptr`, `array`, `asm6502`,
    `@address`, `memory.read`/`memory.write`), the builtins
    `#frames(...)` and its `seconds` unit, `#system()`, `#fact(...)`,
    `#package("version")`, and `waitFrame()`, and a member of
    a named import's own namespace — `screen.blank(...)` shows its
    signature and doc comment, read from whichever module the import
    actually resolves to
  - **Completion** — built-in type names in type position (after `:` or
    inside `ptr<...>`/`array<...>`/`volatile<...>`), the compile-time
    functions after a `#`, the unit words inside a `#frames(...)` call, and
    — right after `object.` — the members a named import brings in
    (`screen.bl` offers `blank`) — inside a template's `${...}` field as
    much as outside one
  - **Your own names** — hover on a component, function, variable, const,
    parameter or `state` field shows its declaration and the comment above
    it, following an import to the file it comes from; completion offers
    what is visible from the cursor; **Go to Definition** (F12) lands on
    the declaration, in this file or another
  - **8BX** — in an `.8bx` file, `<` offers the components in scope (and
    `slot`), a component's tag offers the props it still needs as
    snippets (`row={|}`), and `</` closes the innermost open element
- **8BitScript: View Generated Assembly** — from the command palette or
  an `.8bs`/`.8bx` editor's right-click menu, runs `8bs build --debug`
  and opens the whole file's generated instructions, colored by a 6502
  assembly grammar, in a read-only view beside the source. Clicking a
  line there jumps back to the exact source span that generated it.
  The listing is written to be read by someone who has never seen 6502
  assembly as much as by someone who has: each run of instructions is
  introduced by the source line it came from (`; line 98:
  screen.blank(...)`), and every instruction carries a plain-English
  comment saying what the machine does — `LDA #$06  ; A = 6`,
  `STA $02  ; keysBefore = A`, `JSR $0668  ; call screen_blank`,
  `BEQ $043C  ; if zero, loop back to $043C` — with your own globals and
  functions named in place of bare addresses wherever the debug map
  knows them (and never guessed where it doesn't). The comment icon in
  the tab's title bar (**Toggle Plain-English Comments**, the
  `8bitscript.assemblyView.explain` setting) turns the per-instruction
  column off for a reader who just wants the bytes; the source-line
  comments stay.
  **View Generated Assembly For…** opens the same file for a machine you
  pick, rather than whatever's currently selected — each machine gets its
  own stable tab, so several can stay open side by side; the open tab's
  own title-bar button (**Open For Another Machine…**) offers the same
  picker from there. Saving any `.8bs`/`.8bx` file in the same project
  rebuilds every open tab in place — no tab moves, gains focus,
  or loses its scroll position, and a mid-edit build failure just leaves
  the last successful listing on screen rather than blanking it. No
  compiler logic lives in the extension for any of this — it's all read
  off the compiler's own `.8bs.debug.json` (docs/compiler.md's "Debug
  output" section has the schema).

If no toolchain is found, the extension says so and falls back to syntax
highlighting alone — see "Installing it while developing" below.

## The side bar

The extension adds an **8BitScript** icon — the pixel "8" from the project
logo — to the Activity Bar, the strip of icons down the left edge where the
file explorer, search, and source control live. Clicking it opens a side
bar with one thing in it: a launcher.

```
8BITSCRIPT                              📖  🚀  ♥  ⟳  …

  8BITSCRIPT
    8BitScript     this workspace · pnpm    Update
    2048           0.7.1 · pnpm             Update

  QUICK LAUNCH
    PROGRAM  [ 2048  —  ../2048                 ▾ ] 📄
    SYSTEM   [ PET 2001 (8K)                    ▾ ]
    fitted as Commodore PET · ram=8 · NTSC

  ┌──────────────────────────────────────────────┐
  │  ▶   Run 2048                                │
  │      PET 2001 (8K) · ram=8                   │
  └──────────────────────────────────────────────┘

  RUNNING MACHINES
    ▾ 2048           run · pet · 12s        ⏹
        Emulator   xpet
        Image      dist/2048-pet.prg
        Memory     8 bytes RAM · 331 bytes program

  8bs run --system 'PET 2001 (8K)' --checkout /src/8bitscript --size
```

The side bar is **the 8BitScript tree, each workspace program, and
named-system quick launch**. **Update** on **8BitScript** refreshes the
toolchain: `pnpm install` at this workspace if it is the 8BitScript repo,
`git pull` plus install for a clone the editor keeps under its global
storage, or **Install** clones `https://github.com/8BitScript/8bitscript.git`
(`trunk`) into that storage when nothing is there yet. A second row
appears for each **program** in the workspace — 2048, not hello-world,
not Studio — with its own Update. Examples and apps are in the Program
dropdown, not as install buttons. Hardware fitting and project details
live in editor tabs — **Configure System** and **Show Project** — the
same pattern as Controller Setup. The hardware matrix is not in the
side bar.

- **Run** — starts `8bs run --system '<name>' --size` (or `8bs run <machine>`) for the selected project as a task in
  its own terminal, from the project's directory. A **Use local 8BitScript**
  toggle runs this checkout's CLI (`--checkout`) instead of
  `node_modules/.bin/8bs`, so a consumer app can keep published versions in
  `package.json`. What you see is exactly what the CLI prints.
  `--size` is the per-function breakdown under the memory line; it prints
  before the emulator window opens. On **web**, Run binds an ephemeral
  port (`--port 0`) so two web runs can listen at once, and listens on the
  LAN (`8bitscript.webLan`, on by default) so a phone on the same Wi-Fi can
  open it. The Running machines tree shows a QR of the
  `https://<lan-ip>:<port>/` URL — Safari will warn once; tap Advanced, then
  Proceed. Turn the setting off (`--local`) on an untrusted network. `--port
  n` on the CLI still pins HTTP to n (HTTPS on n+1) when you want a
  stable address. The button names the project, and the
  line under it names the machine, the hardware fitted to it, and the
  region — nothing has to be read off a dropdown to know what pressing it
  means. It greys out when the selected project does not target the selected
  system, or its emulator is missing, and says which in the line below. Run
  and Build work for every machine in the System list.
- **Build** — the same as Run, but `8bs build --system '<name>' --size` (or
  `--target <machine>`), which stops at the built file instead of
  starting an emulator.
- **Program** — the program both buttons act on (`8bitscript.project`).
  Every directory in the workspace with an `8bitscript.config.ts` is in the list,
  grouped as **Programs**, **Examples**, and **Apps**. Apps are packages whose
  `package.json` declares an `8bitscript.app`, [Studio](../../docs/studio.md)
  being the first. The 📄 beside it opens the program's entry `.8bs` file.
  Picking a program loads what it is set up for — the first of its systems,
  hardware and region and all — and a program with none keeps the current
  machine when it targets it.

  **The examples that ship with the toolchain are in the list** under
  *Examples* (`8bitscript.showExamples`, on by default), not under Programs —
  including when this repo is open and they are ordinary workspace folders.
  They come from `@8bitscript/examples`, which `@8bitscript/cli`
  depends on, so any project that has installed the CLI has them — today
  that's `hello-world` and `joystick`. The 📖 in the title bar hides or
  shows them. **Launch
  Example…** reaches them either way, and one that is already selected
  stays in the list even with the toggle off, so hiding them never blanks
  the picker.
- **System** — a **named system** from [project config](../../docs/config.md)
  (advertised in `8bitscript.config.ts`, this clone's
  `.8bitscript/systems.json`, or `~/.config/8bitscript/systems.json`), or a
  bare machine under them. The list comes from `8bs targets --json`, tagged
  with `origin`. **Configure System** is the tab that fits a machine and
  saves it to one of those three layers. The **fitted as …** line opens
  that tab. `8bitscript.namedSystem` is the selected name;
  `8bitscript.system` is the machine when no name is selected.

```
SYSTEM
[ ── This clone ────────────────────── ]
[ ── This machine ──────────────────── ]
[ ── Advertised ────────────────────── ]
[  PET 8032               —  pet · profile=8032 ]
[  The browser            —  web       ]
[ ── Machines ───────────────────────── ]
[  pet — Commodore PET                  ]
[  web — Web                            ]
```

  A system marked **(too small)** is one the program cannot run on: the
  project's config sets a
  [floor](../../docs/config.md) in its `requires`
  block — so much RAM, so much disk — and that machine, fitted that way,
  gives less. It is still listed and still runnable; the notice line says
  what is short, and `8bs build` is the authority that refuses.

  A named system is one choice that fits the machine, its hardware **and**
  its region together — it is a `8bs run` line the project wrote down.
  Picking one is the same as reaching that machine by hand, and reaching
  it by hand is recognized as that system: the button names it either way,
  because the panel compares what the options resolve to rather than
  remembering what was clicked.

- **Open Studio** — the largest button on the panel, above Quick launch:
  Studio, the asset editor that ships with the toolchain, with nothing
  changed — it does not become the selected project, and the Run button
  below still runs yours. The dropdown beside it picks which of Studio's
  own systems to open it on (the Commander X16, its baseline, until you
  pick another: a C64 with a mouse, a VIC-20 with 8K, …); the pick is the
  `8bitscript.studioSystem` setting. It shows up under Running machines
  like any `8bs run`, with its own Stop. The 🚀 rocket in the title bar
  is the same program through a quick pick.

- Every panel — the side bar, System, Project, Controller Setup, the
  assembly view — draws in your color theme: light, dark or
  high-contrast, from VS Code's own theme variables, with no colors of
  its own except the LAN QR code, which a phone's camera has to read.
  Studio has a light and a dark mode of its own on the machine
  (`packages/studio`), switched from its mark's menu.

- **Running machines** — a tree per `8bs` task in flight. A run or boot
  expands to the machine that launched: the emulator, the built image,
  RAM and program bytes, the `--size` breakdown (largest function first),
  the hardware fitted to it, and — on the web — a QR of the LAN HTTPS URL
  a phone on the same Wi-Fi can scan, plus live FPS and frame count
  from the page. Each row has its own **Stop**, which ends the task and
  the emulator with it. The section is not there when nothing is running.
  VICE (xpet on the PET) has no live CPU readout here: its binary monitor
  pauses the machine on any command, so a PET run shows the compile
  report and elapsed time rather than registers.
- The last line is the exact `8bs` command the Run button will start.

The view's title bar has 📖 **Show or Hide Examples**, 🚀 **Launch Studio**,
♥ **Doctor** (`8bs doctor` — checks Node, pnpm, git, and the emulators, and
offers to install missing pnpm or a packaged emulator), and ⟳ **Refresh**; its overflow menu adds **Launch App…**, **Launch
Example…**, **Configure System**, **Show Project**, **Save as a System…**, and **Controller Setup**. Those, and every choice the panel makes,
are on the command palette as well — **8BitScript: Select Project**, **Select System**,
**Select Region**, **Run**, **Build**, **Stop**, **Configure System**, **Show Project**,
**Use Local 8BitScript**, **Use Published Packages**, **Controller Setup**, **Open Entry File**,
**Open 8bitscript.config.ts**.

### Configure System

**8BitScript: Configure System** opens an editor tab — Machine, Hardware,
Region, Facts, Save — and writes the same `{ target, profile?, hardware?,
region? }` object the CLI already validates. Save destination is explicit:
advertise into `8bitscript.config.ts`, this clone (`.8bitscript/systems.json`,
gitignored), or this user (`~/.config/8bitscript/systems.json`).

The extension lists nothing of its own here: it asks the toolchain (`8bs
targets --json`), so a new option, or a new fact, in a package appears with
no extension update.

### Show Project

**8BitScript: Show Project** opens a tab for the selected project: path,
config, entry, targets, advertised vs personal systems, package manager and
lockfile, `@8bitscript/*` versions, and the toolchain source. **Install** /
**Refresh** run the detected package manager (`pnpm`, `npm`, `yarn`, or
`bun`). A Dock-launched editor does not read `.zshrc`; Install looks for
pnpm in the locations `npx get-pnpm` actually uses (`~/Library/pnpm` on
macOS) and offers **Run Doctor** if it still is not there. **Use local 8BitScript** / **Use published packages** persist the
choice in workspace settings and `.8bitscript/toolchain.json` — they do
not rewrite `package.json`.

Each choice is an ordinary setting, written at workspace level when a folder
is open, so it also appears in the Settings editor and survives a restart.

### Controller Setup

**8BitScript: Controller Setup** opens a panel — an editor tab, not a side
bar view, because a gamepad silhouette does not fit in 300px — that finds
the pads plugged into this machine and writes down what their buttons are
called.

It detects them with the browser's Gamepad API, polled on an animation
frame inside the webview: the extension host is Node and has no HID, so the
page is the only part of the extension that can see a controller at all. A
browser hides a pad until it has been used once, so a connected-but-untouched
controller really is invisible until a button is pressed — the panel says so
rather than showing an empty list.

Each controller assigns to **Unassigned** or **Player 1-4**. Under that,
**Live input** lights every raw button and draws every axis as it moves,
which is how you confirm the device is talking before worrying about what
anything is called. The mapper above it is a pad you can click: click a
control, press it on the device, and it is bound; or run the **Guided
setup**, which asks for every control in turn. Each step waits for you to
let go of everything first, because the previous step's button is usually
still down.

Bindings are stored in 8BitScript's own names, never an emulator's or a
driver's:

```
up down left right  a b x y  l r  start select
leftStickX leftStickY rightStickX rightStickY  lt rt
```

That set is what lets one profile serve every machine. **How this maps onto
each machine** projects it: a VIC-20 has one control port carrying four
directions and a fire button, an NES two pads carrying eight bits each, the
X16 two SNES pads carrying twelve — and those counts are the toolchain's
answer (`8bs targets --json`, the `input.joysticks` and `input.pads` facts
each machine package publishes), resolved with the hardware that machine is
actually fitted with, not a list kept here. A profile that binds only the
left stick still steers a joystick port: each direction falls back to the
matching half of the stick.

The result is a JSON file in `~/.config/8bitscript/` — this machine's pads,
not the project's source:

```json
{
  "version": 1,
  "controllers": {
    "devices": [
      {
        "id": "8bitdo-sn30-pro-vendor-2dc8-product-6001",
        "name": "8BitDo SN30 Pro (Vendor: 2dc8 Product: 6001)",
        "player": 1,
        "mode": "standard",
        "mapping": { "up": "button:12", "a": "button:0", "leftStickX": "axis:0" }
      }
    ]
  }
}
```

`8bitscript.controllers.json` rather than a block in `8bitscript.config.ts`:
the config is TypeScript source that a person reads and that **Save as a
System…** edits through the editor's own undo stack, and eighteen
machine-generated bindings per device rewritten on every button press are
not that. A binding is `button:N`, `axis:N` (whole and signed, for a stick),
`axis:N+` / `axis:N-` (one half, for a direction or a trigger), or
`key:ArrowLeft` — a keyboard key by DOM `KeyboardEvent.code`. `mode` is
`standard` when the browser vouched for the pad's layout and `custom` once
anything has been bound by hand. Anything in the file this cannot read is
simply unbound — a file you broke by hand costs you the profile, never the
panel. It is personal hardware, the way VICE's own `~/.config/vice/vicerc`
is: an 8BitDo at one desk is not a `systems` block. A copy sitting in the
project directory is still honoured if present (tests, a cabinet that ships
with a stick).

**A keyboard key is a real binding here**, and on one machine it is the
only one there is: atari800 has no per-button controller mapping at all —
`-kbdjoy0`/`-kbdjoy1` turn the *keyboard* into stick 0 or 1 and
`SDL2_JOY_<n>_*` says which keys, while a pad's own buttons reach nothing.
So during any binding step you can press a key instead of a button, and it
lights the same shapes and fills the same meters as a button does. Escape
is the one key you cannot bind by pressing, because it is what cancels the
step; write `key:Escape` in the file if you really want it.

`8bs run` reads this file directly — there is nothing to paste anywhere.
The host joystick number is the player number minus one, so plug the pads
in in player order. What each emulator can actually take a mapping in
differs a lot, and the CLI names by name anything it has nowhere to put.

### Projects, tasks, and what is missing

A project is any directory containing an `8bitscript.config.ts`; that file is
already the manifest the CLI reads for the entry file and the target list,
so the launcher uses it as the marker rather than a second list to
maintain. A `package.json` on its own does not count — every package in a
monorepo has one. The search covers every workspace folder, skips
`node_modules`, `.git`, and `.claude/worktrees`, and the launcher refreshes
itself when a config file is added, removed, or edited.
`8bitscript.examplesPath` names a directory of your own examples instead of
the shipped ones, if you have one.

**Launch Studio**, **Launch App…**, and **Launch Example…** start one of
the shipped programs without making it the selected project: pick it (when
there is a choice), pick where to open it — a program whose config
declares systems offers those by name, so Studio is launched on *"PET
8032"* rather than on `pet` — and it runs as an ordinary `8bs
run` task. The hardware that launch fits is the program's own; it does not
disturb what you have fitted for your work. An app is run with the
toolchain that found it, so an installed Studio launches even though its
own directory sits inside `node_modules`.

Every run and build is also a task of type `8bs`, so **Tasks: Run Task**
lists them, and a favorite can be pinned in `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "8bs",
      "command": "run",
      "project": "packages/studio",
      "target": "pet",
      "label": "Studio on the PET"
    }
  ]
}
```

`project` is relative to the workspace folder and defaults to the folder
itself; `command` is `run`, `build`, or `doctor`; `pal` is optional. This
is the way to keep a run the launcher's two dropdowns cannot express — a
second system, the other region — one keystroke away.

A project whose dependencies have never been installed — it declares some
and has no `node_modules` of its own, which is how a freshly cloned
project looks — gets a **Run `pnpm install`** button under the launch buttons (or
`npm`/`yarn`, whichever lockfile is nearest), which runs it in the project
as a task. Running such a project asks first, because otherwise the
compiler fails on the first import it cannot resolve, with a message about
the package rather than the install. A project whose emulator is missing
altogether cannot be run at all, and the panel says so. `pet` and `web`
build and run for real; every other target is still refused.

## The grammar is provisional

8BitScript's syntax is not fully specified yet. `syntaxes/8bs.tmLanguage.json`
covers the TypeScript-derived surface the project documentation actually
shows, the primitive integer types (both the friendly spelling — `utinyint`,
`int`, ... — and the low-level `u8`/`i8`-style aliases), and the hardware
escape hatches that already exist: `@address` decorators,
`volatile`/`ptr`/`array`, and `asm6502` blocks. A keyword the language turns
out not to have simply never matches, so a wrong guess costs a word that does
not color rather than a broken file.

This is still only lexical coloring — it has no idea what a name refers to.
The language server layers semantic information over it once it has a binder
to draw on; until then, hover and completion (see above) are the only
compiler-backed intelligence in the editor.

## Installing it

Install **8BitScript** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=8bitscript.8bitscript-lang)
or from [Open VSX](https://open-vsx.org/extension/8bitscript/8bitscript-lang)
(Cursor uses Open VSX). The extension talks to `8bs` in the project:
`pnpm add -D @8bitscript/cli` so `node_modules/.bin/8bs` exists.

A `.vsix` installed by hand does **not** auto-update. The editor treats that
copy as pinned, so it will sit there while a newer version is `latest` on the
gallery. Uninstall it and install from the gallery, or use the source-checkout
link below.

## Installing it while developing the extension

Link this directory into the editor's extensions folder so the window runs
the checkout, not a frozen VSIX.

From the repository root, after `pnpm install`:

```bash
pnpm --filter 8bitscript-lang run link-local
```

That removes any previous `8bitscript.8bitscript-lang-*` in
`~/.cursor/extensions` (including a VSIX copy) and symlinks this directory
under the current version. Pass `--vscode` for VS Code, or `--also-vscode`
to link both. Then **Developer: Reload Window**.

The entry is a tiny loader (`bootstrap.cjs`): if `src/` is present and newer
than `dist/`, it rebuilds the bundle before the editor loads it, so a window
reload cannot pick up yesterday's bundle by accident. While the window is
open it watches `src/`, `media/`, `syntaxes/`, and `snippets/`. A change does
not rebuild in the background — the launcher shows **Rebuild the local
extension**. While that runs it shows status, and only after the rebuild
finishes does **Reload this window** appear. Grammar and media changes follow
the same two-step flow so a half-written bundle is never the thing a reload
loads. If the editor does not pick up the symlink, copy the directory instead
of linking it — some builds scan for real directories.

Cursor's built-in npm task detector opens every `package.json` it finds and
toasts **Npm task detection: failed to parse the file** when that open
fails — the JSON is fine. A linked checkout makes that likely for
`editors/vscode` and the `packages/*` manifests. Exclude them with
`npm.exclude` (the detector matches the *directory* of the file). Root
scripts still show; those packages are run with `pnpm` from the repo root.

There is a `node --test` suite for the parts that do not need the editor —
config reading, toolchain lookup, the command each button runs, the
source-checkout rebuild, and the shape of the launcher page and the manifest
behind it — under `test/`; `pnpm test` from the repository root runs it along
with everything else. Remove the link with `rm` on the symlink; the checkout
is not touched.

## Publishing

A `.vsix` is built with `@vscode/vsce` and published to the Visual Studio
Marketplace and to Open VSX. The release workflow
(`.github/workflows/release.yml`) runs both. Locally, from `editors/vscode`:

```bash
pnpm package
```

That writes `dist/8bitscript-lang.vsix` (gitignored, same as the
minified bundle). CI publishes from `/tmp`; do not leave a `.vsix` in
this directory.

`vscode:prepublish` minifies the bundle. Diagnostics, hover, and completion
come from `8bs lsp` over a small stdio JSON-RPC client in this package, not
from Microsoft's `vscode-languageclient`. The remaining weight is the
launcher side bar, the grammar, and this README — not a second copy of the
compiler. See [Editor support](../../docs/language-server.md).
