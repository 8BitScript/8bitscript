# @8bitscript/studio

8BitScript Studio: the asset editor that ships with the toolchain and runs
on the machines themselves — characters, sprites, and music, with the full
editor on the Commander X16 and a smaller one down to the PET, and a viewer
on the NES. It is an ordinary 8BitScript program: `8bs run <target>` here
starts it, and the VS Code extension's **Launch Studio** does the same from
the editor.

Today it is the desk and nothing behind it: a menu bar whose menus drop
down — the mark, FILE, and CHARACTERS, SPRITES and MUSIC (one EDIT menu
where the row is 22 cells) — driven by keys, a stick, a pad or a mouse,
and a screen per editor that shows what this machine has for it: the
characters screen draws the portable character set on the machine's own
font, the others their hardware's own numbers. It has a dark mode (blue border,
black screen, white ink) and a light one (white screen, black ink),
switched from the mark's menu on every machine with more than two
colors. Nothing edits, plays or
loads yet — there is still no glyph, sound or storage capability to build
an editor on, and each screen says so on its last line;
[`AGENTS.md`](AGENTS.md) has the tiers, the design, and what each editor
is waiting for. It is designed on the Commander X16 and builds for all
nine machines; `8bs build --release` says what each is short of.

```bash
pnpm start                 # the Commander X16
pnpm run start:pet         # the 32K PET, as a viewer
pnpm run start:nes         # the NES, as a viewer
8bs run c64 --screenshot studio.png
```

Studio's version is the toolchain's version; `test/studio.test.mjs` holds
it to that, builds it for every target, and drives the desk's menus on
the web build headlessly.
