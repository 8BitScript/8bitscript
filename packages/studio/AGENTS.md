# Writing 8BitScript Studio

This file is for anyone — human or agent — touching `packages/studio`, the
`8bitscript.app` field in a package manifest, or the editor's Launch Studio
command. Read the root [`AGENTS.md`](../../AGENTS.md) first.

## What Studio is

Studio is the asset editor that ships with the toolchain and is meant to run
on the machines themselves. Today it is the **shell** and one module, the **DAW**: a dark screen
with a solid menu bar on top (sample labels, nothing opens), a solid status
bar along the bottom (sample text and the grid size), the pixel-8 mark in
the corner, and a short chime when it starts. The DAW is the music editor
and the first of Studio's modules; Studio opens straight into it, and other
modules (image and tile editing, sound files, the player) plug into the same
shell later. It is an ordinary 8BitScript program — `.8bs`, `.8bx`, `.8bg`,
`.8ba` — built and run like any other project. `@8bitscript/cli` depends on
`@8bitscript/studio`, so installing the toolchain installs Studio.

Studio is the first **app** (`8bitscript.app` in `package.json`). The VS
Code extension lists apps separately from projects and examples; **Launch
Studio** builds and runs this package.

## What exists today

Do not describe more than this as working:

1. **`src/studio.8bs`** — the shell: paints the screen, places the mark,
   starts the chime, runs the frame loop, and repaints the module when the
   grid changes size (the browser build's grid follows the window).
2. **`src/daw/`** — the DAW module. `daw.8bs` draws the module;
   `MenuBar.8bx` is the top row (reverse video across the grid, sample
   labels FILE EDIT SONG TRACK VIEW HELP); `StatusBar.8bx` is the bottom row
   (sample text and the live `columns X rows`). Both read `text.columns()`
   and `text.rows()` on every draw, so they fit any grid, fluid or fixed.
   Text stays on the portable character set and the portable `TextColor`s.
3. **`src/mark.8bg`** — the logo as media, drawn at the stage origin.
4. **`src/chime.8ba`** — a one-shot sample on start via `audio.play()`.
5. **Commander X16 baseline** — `baseline: 'cx16'` in the config, mouse as
   `input.primary`. Other machines are compared to that build.

There is **no** input loop, no menus that open, no tracks, and no sound from
the DAW yet. The layout for the rest of the DAW is the "Studio DAW Layout"
mock; the decisions behind it are on the Studio sheet.

## Release targets

This release builds for **five** machines, shared with
[`packages/examples/shared-release-targets.mjs`](../examples/shared-release-targets.mjs):

| Target | Why |
| --- | --- |
| `cx16` | Baseline flagship |
| `c64` | Commodore desk reference |
| `vic20` | 8K expanded (stock 3.5K is not a release target here) |
| `pet` | 4032 with 32K RAM |
| `web` | Headless and in-browser smoke tests |

`8bitscript.config.8bs` imports `releaseTargets` from `@8bitscript/examples` (a dependency, so it resolves where Studio is installed too) and spreads it into `targets` and names those five
in `systems`. Adding a machine to the release set is one edit in
`shared-release-targets.mjs` and matching tests.

## Tiers (direction, not implemented)

The tier table in older revisions of this file still describes the **goal**:
one program, different editor depth per machine's facts, chosen once in the
entry file from `Input.KEYBOARD`, `Memory.RAM`, `Video.GLYPHS`,
`Video.SPRITES`, and `Audio.VOICES`. The shell no longer reads a tier; when
editors return, `main.8bs` should pick the tier again before opening them.
Rules that must survive: the tier gates editors, not file formats; only
build-time facts pick the tier.

## What Studio needs from the language

Same list as before — nothing behind the shell is built:

- **Input** — `@8bitscript/input` exists; Studio does not use it yet.
- **Character and sprite access** — intent-level glyph and sprite APIs for
  editors.
- **Sound** — note-level API beyond one-shot samples (trackers).
- **Storage** — load/save and host mount routes for Launch in Studio.

Assets on disk should be **media source**: `.8bg` for pictures, `.8ba` for
audio — see [`docs/project/graphics.md`](../../docs/project/graphics.md) and
[`docs/project/audio.md`](../../docs/project/audio.md).

## Launching

The WebAssembly build is the primary way to run Studio, as it is for anything
here: our compiler to wasm, and our own model of each machine, with no vendor
emulator in the loop — which is also what makes a Studio you can share or
embed as a web page.

- VS Code **Open Studio** (the Studio row in the side bar, the 🚀 in the title
  bar, **Launch Studio**, **Open Studio in a Tab**) runs `8bs run web` in an
  editor tab: the modern responsive build in its high-resolution mode
  (`machine=hifi-hires`, set on the `web` target in this package's config),
  where a cell is a whole number of device pixels, text is about 16 CSS
  pixels on any display, and the window decides how many cells fit — about
  76x56 on a laptop, as on the X16. Not a native window, not x16emu.
- **Open Studio on the X16 (WebAssembly)** runs `8bs run cx16 --web` in the
  tab: our model of the Commander X16, the baseline machine.
- `8bs run web` or `8bs run cx16 --web` from this directory is the same
  without the editor.
- `8bs run` in this directory (X16), or `pnpm start` / `pnpm run start:<target>`,
  opens the native `x16emu`; so does **Open Studio in the Native Emulator**.
- `8bs run cx16 --web --x16emu` (**Open Studio in x16emu (in a Tab)**) is the
  vendored x16emu compiled to wasm: the real emulator's behaviour in a tab,
  chosen by name.

What the X16's wasm model shows of today's shell, checked pixel for pixel by
`packages/cli/test/web-cx16.test.mjs`: the blue border in VERA's own blue
(`#0000aa`), the black screen, and the 8×8 mark in its cell. What it does not:
the chime (a `.8ba` sample has no wasm driver, 8BS2211), the VERA sprite (the
mark is a glyph in one ink there, 8BS2111), and the mouse (the X16-only
modules read plain memory). Studio's shell reads no input yet, so none of that
changes what it does; when an editor needs the mouse, the wasm model needs a
mouse first — until then **x16emu in a tab** is the way, and the limits are in
`8bs targets --json` (`wasm.limits`).

Regenerate `src/mark.png` and `src/chime.wav` after changing the procedural
sources: `node generate-assets.mjs` from this package.

## Changing Studio

- Keep the shell buildable on every **release** target; `test/studio.test.mjs`
  links and builds those five.
- Keep strings on the portable character set when text returns to the UI.
- When the shell grows, re-measure with `8bs build --release` and record
  bytes in this file in the same commit.
- Touching `shared-release-targets.mjs` affects examples and Studio together.
