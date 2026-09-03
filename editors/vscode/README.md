# 8BitScript for VS Code and Cursor

Syntax highlighting, a real language server, and a project runner for `.8bs`
files. The extension itself is still a thin client: it finds the project's
`8bs` toolchain and runs `8bs lsp --stdio`, and every diagnostic, hover, and
completion it shows comes from `@8bitscript/compiler` through that server —
not from anything reimplemented here. The same goes for building and running:
the side bar's Run buttons only ever start the `8bs run` and `8bs build` commands you
would otherwise type. See [Editor support](../../docs/language-server.md) for
the split between the compiler, the language server, and this extension.

## What it does

- Registers `.8bs` as the language **8BitScript**
- Colours comments, strings, numbers, types, keywords, declarations, and calls
- `//` line comments and `/* */` blocks, so comment-toggling works
- Bracket matching, auto-closing pairs, and `// #region` folding
- Starts the language server (`8bs lsp --stdio`) when a `.8bs` file is open
  and the toolchain is installed, giving you:
  - **Diagnostics** — lexical, syntax, and range errors, as you type
  - **Hover** — documentation for built-in types (`utinyint`, `int`, ...) and
    constructs (`volatile`, `ptr`, `array`, `asm6502`, `@address`,
    `memory.read`/`memory.write`)
  - **Completion** — built-in type names in type position (after `:` or
    inside `ptr<...>`/`array<...>`/`volatile<...>`)

If no toolchain is found, the extension says so and falls back to syntax
highlighting alone — see "Installing it while developing" below.

## The side bar

The extension adds an **8BitScript** icon — the pixel "8" from the project
logo — to the Activity Bar, the strip of icons down the left edge where the
file explorer, search, and source control live. Clicking it opens a side bar
with two sections.

**Run Settings** is three dropdowns and a checkbox:

```
SYSTEM            REGION
[ vic20       ▾ ] [ NTSC ▾ ]
VIEW
[ Runnable on the selected system ▾ ]
☐ Show example projects
Run buttons use vic20 · NTSC
```

- **System** — `vic20`, `c64`, or `web`: the one every Run and Build button
  uses (`8bitscript.system`).
- **Region** — NTSC (60Hz) or PAL (50Hz) for the two Commodore machines
  (`8bitscript.region`); it is greyed out while the system is `web`, which
  has no region.
- **View** — how the Projects list below is laid out
  (`8bitscript.projectsView`); see the three layouts below.
- **Show example projects** — appears only when the toolchain in use comes
  from a checkout of this repository, and adds its `examples/` to the list
  (`8bitscript.showExamples`). This is how a project that depends on
  8BitScript gets to browse and run the examples without opening the
  repository separately. `8bitscript.examplesPath` names a different
  directory of examples if you have one.

Each choice is an ordinary setting, written at workspace level when a folder
is open, so it also appears in the Settings editor and survives a restart.
The same choices are on the command palette as **8BitScript: Select
System**, **Select Region**, and **Change Projects View**.

**Projects** lists what can be run, in one of three layouts:

```
PROJECTS  runnable on vic20 · NTSC          ⊞ 📖 ♥ ⟳
  borders         examples/borders           ▶ 🔧
  counter         examples/counter           ▶ 🔧
  hello-vic       examples/hello-vic         ▶ 🔧
```

- **Runnable on the selected system** (the default) — one row per project
  that targets the selected system. Run and Build on the row use that
  system and region, so it is one click from the dropdowns to the emulator.
  A project that does not target the system is left out; if none do, the
  view says so.
- **By project** — every project, expanded into the systems it targets,
  with Run and Build on each system row.
- **By system** — every system with at least one project, expanded into the
  projects that target it; the selected system starts expanded.

The ⊞ button in the title switches layout, 📖 toggles the example projects
(only shown when there are any), ♥ runs `8bs doctor`, and ⟳ rescans.

A project is any directory containing an `8bs.config.ts`; that file is
already the manifest the CLI reads for the entry file and the target list,
so the view uses it as the marker rather than a second list to maintain. A
`package.json` on its own does not count — every package in a monorepo has
one. The search covers every workspace folder, skips `node_modules`, `.git`,
and `.claude/worktrees`, and the view refreshes itself when a config file is
added, removed, or edited.

**Run** starts `8bs run <target>` and **Build** starts `8bs build --target
<target>` as a task in its own terminal, from the project's directory with
the project's own `node_modules/.bin/8bs`, so what you see is exactly what
the CLI prints. A row's right-click menu offers *Run (NTSC)*, *Run (PAL)*,
*Build (NTSC)*, and *Build (PAL)* explicitly for the Commodore systems. A
running row shows a spinner and a **Stop** button, which terminates the task
(and with it the emulator).

Clicking a project opens its entry `.8bs` file. Its right-click menu has
*Open 8bs.config.ts*, *Reveal in Explorer*, and *Open in Integrated
Terminal*. From the command palette, **8BitScript: Run** and **8BitScript:
Build** ask which project and system, offering the selected system first.

Every run and build is also a task of type `8bs`, so **Tasks: Run Task**
lists them, and a favourite can be pinned in `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "8bs",
      "command": "run",
      "project": "examples/borders",
      "target": "c64",
      "pal": true,
      "label": "borders on a PAL C64"
    }
  ]
}
```

`project` is relative to the workspace folder and defaults to the folder
itself; `command` is `run`, `build`, or `doctor`; `pal` is optional.

A project whose dependencies have never been installed — it declares some
and has no `node_modules` of its own, which is how a freshly added example
looks — is listed with a warning icon and *not installed*, and gets an
**Install** button that runs `pnpm install` (or `npm`/`yarn`, whichever
lockfile is nearest) in the project as a task. Running such a project asks
first, because otherwise the compiler fails on the first import it cannot
resolve, with a message about the package rather than the install. A
project whose toolchain is missing altogether is marked *toolchain not
installed*; running it explains how to fix that.

The Commodore targets need the LLVM-MOS SDK, which the CLI finds through
`LLVM_MOS_HOME`. A task's shell is non-interactive and does not read
`~/.zshrc`, so an `export` there is invisible to it and `8bs doctor` from the
side bar reports the SDK missing while the terminal has it. The extension
sets `LLVM_MOS_HOME` on every task it starts: from the `8bitscript.llvmMosHome`
setting if given, else from the editor's own environment, else from the
install location the setup guide uses (`~/.local/opt/llvm-mos`) when the SDK
is there. The durable fix is to export the variable from `~/.zshenv` or
`~/.profile` instead — see [the SDK setup](../../docs/setup/llvm-mos.md).

## The grammar is provisional

8BitScript's syntax is not fully specified yet. `syntaxes/8bs.tmLanguage.json`
covers the TypeScript-derived surface the project documentation actually
shows, the primitive integer types (both the friendly spelling — `utinyint`,
`int`, ... — and the low-level `u8`/`i8`-style aliases), and the hardware
escape hatches that already exist: `@address` decorators,
`volatile`/`ptr`/`array`, and `asm6502` blocks. A keyword the language turns
out not to have simply never matches, so a wrong guess costs a word that does
not colour rather than a broken file.

This is still only lexical colouring — it has no idea what a name refers to.
The language server layers semantic information over it once it has a binder
to draw on; until then, hover and completion (see above) are the only
compiler-backed intelligence in the editor.

## Installing it while developing

Link this directory into the editor's extensions folder, then reload the window.

Cursor:

```bash
ln -s "$PWD/editors/vscode" ~/.cursor/extensions/8bitscript.8bitscript-lang-0.0.0
```

VS Code:

```bash
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/8bitscript.8bitscript-lang-0.0.0
```

Run either from the repository root. Then **Developer: Reload Window** from the
command palette, open a `.8bs` file, and check that the language indicator in
the status bar reads *8BitScript*.

A symlink is used rather than a copy so that editing the grammar and reloading
the window is the whole development loop. The projects view has a `node --test`
suite for the part that does not need the editor — config reading, toolchain
lookup, and the command each button runs — under `test/`; `pnpm test` from the
repository root runs it along with everything else. If the editor does not pick up the
symlink, copy the directory instead of linking it — some builds scan for real
directories. Remove it with `rm` on the link; nothing else is touched.

## Publishing it later

Distribution is a `.vsix` built with `@vscode/vsce` and either uploaded to the
marketplace or installed with `cursor --install-extension <file>.vsix`. That is
not set up yet, and it is not worth setting up until the grammar has settled.
