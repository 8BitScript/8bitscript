# Writing 8BitScript Studio

This file is for anyone — human or agent — touching `packages/studio`, the
`8bitscript.app` field in a package manifest, or the editor's Launch Studio
command. Read the root [`AGENTS.md`](../../AGENTS.md) first.

## What Studio is

Studio is the asset editor that ships with the toolchain and is meant to run
on the machines themselves. Today it is only the **shell**: a dark screen, a
cyan top bar, the pixel-8 mark in the corner, and a short chime when it
starts. It is an ordinary 8BitScript program — `.8bs`, `.8bx`, `.8bg`,
`.8ba` — built and run like any other project. `@8bitscript/cli` depends on
`@8bitscript/studio`, so installing the toolchain installs Studio.

Studio is the first **app** (`8bitscript.app` in `package.json`). The VS
Code extension lists apps separately from projects and examples; **Launch
Studio** builds and runs this package.

## Four pillars (what exists today)

Do not describe more than this as working:

1. **`src/Bar.8bx`** — the top row through `@8bitscript/ui/menubar`: `begin`
   and `end` with no menu items, so the bar is one blank row in the bar
   colors. Policy and input stay out of the component; see
   [`packages/ui/AGENTS.md`](../ui/AGENTS.md).
2. **`src/mark.8bg`** — the logo as media: an 8×8 PNG compiled through
   `@8bitscript/graphics` and drawn at the stage origin offset by a few
   pixels. Not `menubar.icon()` — the mark is allowed to become a real
   sprite on machines that have one.
3. **`src/chime.8ba`** — a one-shot sample on start via `audio.play()`. The
   main loop calls `audio.update()` so machines with a driver can finish the
   sound; elsewhere the call is empty.
4. **Commander X16 baseline** — `baseline: 'cx16'` in `8bs.config.ts`, mouse
   as `input.primary`, and `8bs run` with no target starting on the X16.
   Other machines in this release are compared to that build, not re-designed
   per target in Studio source.

`src/studio.8bs` wires the four pieces: `paint()`, `<StudioBar />`,
`graphics.place(mark, …)`, `audio.play(chime)`, then `waitFrame()` with
`graphics.update()` and `audio.update()`. There is **no** input loop, no
menus, and no editor screens yet.

## Release targets

This release builds for **five** machines, shared with
[`packages/examples/shared-release-targets.ts`](../examples/shared-release-targets.ts):

| Target | Why |
| --- | --- |
| `cx16` | Baseline flagship |
| `c64` | Commodore desk reference |
| `vic20` | 8K expanded (stock 3.5K is not a release target here) |
| `pet` | 4032 with 32K RAM |
| `web` | Headless and in-browser smoke tests |

`8bs.config.ts` spreads `releaseTargets` into `targets` and names those five
in `systems`. Adding a machine to the release set is one edit in
`shared-release-targets.ts` and matching tests.

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

- `8bs run` in this directory (X16), or `pnpm start` / `pnpm run start:<target>`.
- `8bs run cx16 --web` for the browser tab.
- VS Code **Launch Studio** runs the same command for a chosen system.

Regenerate `src/mark.png` and `src/chime.wav` after changing the procedural
sources: `node generate-assets.mjs` from this package.

## Changing Studio

- Keep the shell buildable on every **release** target; `test/studio.test.mjs`
  links and builds those five.
- Keep strings on the portable character set when text returns to the UI.
- When the shell grows, re-measure with `8bs build --release` and record
  bytes in this file in the same commit.
- Touching `shared-release-targets.ts` affects examples and Studio together.
