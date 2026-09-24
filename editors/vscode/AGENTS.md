# Working on the VS Code extension

Most of this directory is ordinary extension work — commands, views, the
language client — and [`README.md`](README.md) describes what it does for a
person using it. This file is for the one thing that reliably wastes an
afternoon if you don't know it: **the file icons.**

## An icon only changes when its filename changes

> **The explorer fetches a file icon by URL and caches it under that URL.
> Editing an SVG in place changes nothing on screen — not after a window
> reload, not after reinstalling the extension, not ever.**

This is not a theory. It was established by instrumenting the running
extension: the activation log showed the theme file on disk had changed, the
icon paths resolved correctly, and the SHA of `8bx-dark.svg` matched the newly
written art — while the explorer kept drawing a version from *six redesigns
earlier*. Two separate experiments narrowed it down:

- Changing the SVG's **contents** alone: no change on screen.
- Changing the **theme file** alone (new `iconDefinitions` ids, same
  `iconPath` values): no change on screen either — so the theme is not the
  cache key.
- Changing the icon **filenames**: the new art appeared immediately.

The failure is silent and deeply misleading, because every check you can make
from inside the extension says the new art is loaded. Do not go looking for a
bug in the theme, the symlink, or the SVG. There isn't one.

## So the filename carries a content hash, and a script maintains it

Author icons in **`icons/src/`** under plain names (`8bx-dark.svg`). Never
point the theme at those files directly. Run:

```bash
pnpm run icons        # or pnpm run bundle, which runs it first
```

[`scripts/build-icons.cjs`](scripts/build-icons.cjs) hashes each source,
copies it to `icons/file/<name>.<sha8>.svg`, deletes any generated file no
longer named by a source, and rewrites
`themes/8bitscript-icon-theme.json` to match. New art is a new URL, so the
editor re-fetches it — the failure above cannot happen again.

Both generated outputs are committed, because `package.json` references the
theme and the VSIX ships the icons. Two tests in
[`test/grammar.test.cjs`](test/grammar.test.cjs) guard the arrangement: one
fails if the committed output has drifted from `icons/src/`, and one proves a
redesigned source lands under a new filename.

`contributes.languages[].icon` in `package.json` points at the stable
`icons/src/` files instead, since those paths live in a hand-edited manifest
and cannot be regenerated on every redesign. That surface is not the explorer,
so the cache behaviour doesn't apply.

## A file icon theme has no per-definition light variant

`iconPathLight` is **ignored** in a file icon theme — it belongs to
`contributes.languages[].icon`, which is a different contribution point.
Writing it costs you nothing visible and silently serves the dark icon to
light-theme users. Light overrides live in a top-level `light` section that
points the same extension at a *different definition*:

```json
"fileExtensions": { "8bx": "_8bx_dark" },
"light": { "fileExtensions": { "8bx": "_8bx_light" } }
```

Anything the `light` section leaves out falls back to the base entry, so an
icon drawn once needs no entry there at all. The generator handles this: list
a name in `THEMED` for a dark/light pair, or in `SHARED` for a single drawing.

## The theme replaces *every* icon, not only ours

Setting a file icon theme replaces the whole set. An extension that only
defines `.8bs`/`.8bx`/`.8bg`/`.8ba` leaves every `.png`, `.wav`, `.json` and
folder in the workspace with **no icon at all** — which is what happened here
before the generic set was added. So `BY_EXTENSION`, `BY_FILENAME`, `file`,
`folder` and `folderExpanded` in the generator are not decoration; they are
what keeps a project looking normal.

The colour convention: a supporting kind wears its pillar's accent exactly, in
whichever theme is showing — `.png` is the green of a `.8bg` badge, `.wav` the
amber of a `.8ba` one, `.ts` the silver of a `.8bx` one. Both sides of each
pair are drawn twice, brighter on dark and deeper on light, and a test asserts
the two stay in step.

## Drawing rules that come from the 16px render

- **Fills, not strokes, and no fine detail.** These are read at 16 pixels.
- **The 8 is the brand.** All four source kinds carry the same pixel 8, and
  the kind is told by a small badge set *beside* it, low and to the right like
  a subscript. The badge must not overlap the 8: at 16px an overlap turns both
  shapes to mush, which is the form this went through and came back from.
  `.8bs` is the flagship and is the only one with a filled purple box behind
  it (a white 8 on purple, centred); the other three are a violet 8 sitting
  left on the explorer's own background, so a row of them does not read as a
  wall of purple blocks.
- **Check it before asking anyone to reload.** `rsvg-convert` renders a sheet
  at both sizes in seconds, which is faster and more honest than a reload.
