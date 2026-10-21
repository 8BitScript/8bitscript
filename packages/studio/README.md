# @8bitscript/studio

8BitScript Studio: the asset editor that ships with the toolchain and runs
on the machines themselves — characters, sprites, and music, with the full
editor on the Commander X16 and a smaller one down to the PET, and a viewer
on the NES. It is an ordinary 8BitScript program: `8bs run <target>` here
starts it, and the VS Code extension's **Open Studio** opens it in an editor
tab on our own WebAssembly build of the X16 (the same page you could share).

Today it opens into the DAW module, the music editor, and shows only its
frame: a solid menu bar (FILE, EDIT, SONG, TRACK, VIEW, HELP) and a solid
status bar with the grid size, over a black screen with the mark in the
corner. Nothing opens, edits, plays or loads yet; [`AGENTS.md`](AGENTS.md)
has the design and what the DAW is waiting for. It builds for the Commander
X16, C64, expanded VIC-20, PET 4032 and the browser, and **Open Studio** in
VS Code runs the modern responsive web build.

```bash
pnpm start                 # the Commander X16
pnpm run start:pet         # the 32K PET, as a viewer
pnpm run start:nes         # the NES, as a viewer
8bs run c64 --screenshot studio.png
```

Studio's version is the toolchain's version; `test/studio.test.mjs` holds
it to that, builds it for every target, and drives the desk's menus on
the web build headlessly.
