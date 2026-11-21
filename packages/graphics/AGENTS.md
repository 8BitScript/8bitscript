# @8bitscript/graphics — notes for whoever works on a twin

`@8bitscript/graphics` plays a `.8bg` sprite. It is a **contract**, not a
single implementation: `src/index.8bs` is the glyph path *and* the
reference for the contract, and every machine twin
(`index.pet.8bs`, `index.vic20.8bs`, `index.c64.8bs`, `index.cx16.8bs`,
`index.web.8bs`, `index.cx16.web.8bs` for `--target cx16 --web`,
`index.nes.8bs`) answers the same ten constants and exports eleven calls:
the eight a program makes (`place`, `hide`, `setFrame`, `animate`, `color`,
`update`, `hit`, `hitAny`) plus `bind`, `meta` and `bounds`. The table of what
each machine answers is in
[`docs/project/graphics.md`](../../docs/project/graphics.md#the-portable-contract)
and, as data, in `packages/compiler/test/graphics-contract.test.mjs`. Change
both together; the test fails if a twin and the table disagree.

## The rules a twin keeps

- **Constants first.** Answer all ten — `MAX`, `FRAMES`, `WIDTH`, `HEIGHT`,
  `COLORS`, `RECOLORS`, `STEP_X`, `STEP_Y`, `RESTORES`, `TRANSPARENT` — with
  the value this machine honestly has. The honest value is the degradation:
  never claim a capability so as to look like another machine. Derive a
  constant from the layer underneath where the twin sits on `@8bitscript/sprites`
  (`const WIDTH: utinyint = sprites::WIDTH;`), so the two cannot drift; write a
  literal where the twin owns the number. `FRAMES` is for a picture of
  `WIDTH`×`HEIGHT`.
- **Positions are playfield pixels.** `place(slot, 0, 0)` lands on text cell
  (0, 0). The twin adds the origin its hardware needs (the C64 adds
  `sprites::ORIGIN_X`/`ORIGIN_Y`; the X16 adds `DC_VSTART`). A cell machine's
  origin is 0 and the twin adds nothing. A position not on `STEP_X`/`STEP_Y`
  rounds down; one off the playfield clips and never wraps or writes outside
  the twin's own tables.
- **A call degrades, it never disappears.** A twin that cannot do a call
  exports it as a documented no-op (`color` on the PET and the NES),
  with a comment saying why and which constant says so
  (`RECOLORS` false). A program guards a call with the constant and the
  guarded branch costs the other machines nothing.
- **Nothing is worked out at run time that the build knew.** The lowering
  (`packages/<machine>/media/index.cjs`, or the compiler's
  `lower-default.mjs`) hands over bytes; `bind()` copies them and `meta()`
  records the picture's frame count, interval and size. The compiler then
  calls `bounds()` with the hit box it measured from the source picture
  (`packages/compiler/src/media/elaborate.mjs`). All three are called by the
  generated binders before `main()`; a program never calls them.
- **No `show()`.** Every layer underneath defines `hide` as "not drawn until
  placed again". A `show` would make each twin keep a position per slot. A
  program that hides and reshows an object calls `place` again.
- **A twin may add a call of its own, and a program that uses it is that
  machine's.** The C64's `graphics::step()` advances the animations and
  nothing else, so a program with raster entries of its own can build its
  frame (`docs/project/graphics.md`, "On the C64"). The contract test checks
  the calls above exist and ignores the rest; the portable `index.8bs` has no
  such call, and a portable program never writes one.
- **Hits are one block of source.** `hit(a, b)` and `hitAny(a)` sit between
  `// ---- hit ----` and `// ---- end hit ----`, identical in every twin
  (`packages/compiler/test/graphics-hit-block.test.mjs`); each twin only
  feeds it (`place` records the position, `hide` and `meta` mark the sprite
  not placed). The box is one per sprite: the union of its opaque pixels over
  all frames. The position is the one `place` gave, unrounded and unclipped,
  but a coordinate at or above 32768 never hits. `hitAny` answers the first
  slot that hits, or 255 when none does.
- **On the web the build sizes the sprites.** `index.web.8bs` and
  `index.cx16.web.8bs` draw a picture as a real pixel sprite the page shows
  from the agreement's sprite region; `MAX` is the `video.sprites` fact and
  the frames share a `video.spriteKib` pool. The web default is 16 sprites and
  16 KiB (`packages/web/package.json`); `cx16 --web` has 128 and 32 KiB. The
  two files share one body (a test pins it); only `SPRITE_TABLE` differs, and
  a test pins it to the layout in `packages/cli/src/web-layout.mjs` for each
  skin.
- **Private names don't collide with the public ones.** A twin's private slot
  count is `SLOTS`; `MAX` is the public constant inside `mod graphics`.

## Adding a call or a constant

It is a change to every twin in one commit: the generic `index.8bs` first
(it is the reference), then each twin (the two web twins share a body), then the table in the contract test and
`docs/project/graphics.md`. The contract test builds a probe against all
thirty-two targets, so a twin that misses it fails there, in CI, even though
the machine packages' own tests are not part of the CI gate.

## Verifying a twin

The contract test proves the twin links and answers consistently. It does not
prove it draws. Each machine's emulator test beside its package
(`packages/<machine>/test/graphics*.test.mjs`, headless `--screenshot`) does
that; the web's are in `packages/cli/test/web-graphics*.test.mjs` and
`web-pixel-sprites.test.mjs`. The hit check runs as wasm in
`packages/cli/test/graphics-hit.test.mjs` and natively on the C64 under VICE
in `packages/c64/test/graphics-hit.test.mjs`. The status
table in `docs/project/graphics.md` says which calls on which machine a
screenshot has verified and which only link — keep it honest when you verify
one.
