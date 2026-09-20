# @8bitscript/examples

The example programs that ship with the toolchain. `@8bitscript/cli`
depends on this package, so installing the CLI installs the examples, and
the VS Code extension lists them in its launcher beside your own programs
and beside Studio. Each example is an ordinary project: a directory with an
`8bitscript.config.ts` and a `src/main.8bs`, run with `8bs run <target>` from
inside it.

The manifest is the `"8bitscript".examples` field of `package.json`: one
entry per example, with a title, a directory, and a sentence about it.
The launcher reads that field and nothing else, so adding an example is a
directory and an entry.

| Example | What it is | Targets |
| ------- | ---------- | ------- |
| `hello-world` | `screen.blank()` then `text.print(0, "Hello World!")` through the portable screen and text packages — the same few lines build for every machine. | all nine |
| `joystick` | The controller test app: a labelled map of everything `@8bitscript/input` exposes, with a lamp on each control that flashes when it is pressed. | all nine |
| `fancy` | The raster showpiece: a title wobbling on a sine wave inside colour bands, over `@8bitscript/raster`'s portable per-scanline surface. The two machines that answer `#fact(video.raster)` show the effect; the other seven show a static title, by design. | all nine |
| `hello-bx` | The same greeting as `hello-world`, drawn through one 8BX component: `Hello.8bx` declares it, `hello-bx.8bs` is the program that calls it — the smallest project that shows how a `.8bs` program and a `.8bx` component fit together. | all nine |
| `swarm` | The moving-objects showpiece: sixteen sprites bouncing round the picture on a frame timeline — through `@8bitscript/sprites` (sprites on the C64, sixteen from eight and out into the border; a glyph per sprite on the character grid elsewhere) and `@8bitscript/timeline`. The scene is one `.8bx` file that reads like a part list. | all nine |

## hello-world

From inside `hello-world/`:

```
8bs run pet              # the default 2001, in VICE
8bs run pet --profile 8032   # 80 columns, mixed case
8bs run web              # the browser
```

The program prints and returns, landing back at the BASIC `READY.` prompt
the way any program that falls off its own end does. On a PET that boots
into the upper-case/graphics character set — every model but the 8032 —
the greeting draws in capitals, because that set holds one case of the
alphabet; the 8032 shows real mixed case. See `@8bitscript/pet`'s own
notes for why nothing switches between them.

## joystick

The program to run first on a machine whose input layer is new or
suspect. From inside `joystick/`:

```
8bs run c64              # push a stick in port 2, or the cursor keys
8bs run nes              # a pad in port 1
8bs run pet              # the cursor keys, with SHIFT for left and up
```

It draws the six controls the portable surface exposes — `up`, `down`,
`left`, `right`, `confirm`, `cancel` — and flashes a reverse-video bar on
each one as it is pressed. Under them:

- **SEEN** — every press the program has ever been handed, never decaying.
  On a machine nobody is touching this must stay `00000`; a count that
  climbs on its own is a layer reporting presses that did not happen.
- **FRAME** — one per trip round the loop, so a frozen program and an idle
  one look different.
- **KEY / JOY / PAD** — what the *machine* declares it has
  (`#fact(input.keyboard)`, `#fact(input.joysticks)`, `#fact(input.pads)`),
  so a dark map can be read as "nothing was pressed" or as "this layer
  does not read what this machine has" rather than being ambiguous
  between them.

**A lamp is a press that was seen, not a control that is held.**
`@8bitscript/input` is edge-triggered by design and has no level query for
directions or buttons, so this app latches each edge for about a quarter
of a second and says so on screen. Holding a direction down flashes the
lamp once.

Two things follow from the state of the layers rather than from this
program, and are expected:

- On the **Commander X16** nothing will ever light. `@8bitscript/cx16/input`
  answers false to every direction, confirm and cancel — its SNES pads and
  its keyboard are not read yet — and its own header says so.
- On the **MEGA65** `SEEN` reads `00001` from the moment the program
  starts, and the press is `confirm`. Measured, not guessed: a scratch
  build read CIA1 itself on the first frame and found RETURN down and the
  stick clear, where the same probe on a C64 and a C128 found both clear.
  Every layer begins its edge detector with an empty previous-frame
  snapshot, so anything already held at the first `poll()` — the
  emulator's own autostart RETURN here, a player holding fire as the
  program loads on real hardware — reads as a press that just began.

## What this app wanted and the portable surface could not give it

Building it is the cheapest way to find the edges of `@8bitscript/input`,
so they are written down here rather than lost:

- **No level query.** `up()`…`cancel()` are all edge-triggered; `pointer()`
  is the only level-triggered call on the surface. A controller map cannot
  show a control as *held*, which is the thing a controller map is for.
  `held()` alongside the existing calls, not a redesign, is the ask.
- **`confirm()` is an OR the app cannot take apart.** On the NES it is A
  *or* START; on the C64, C128 and MEGA65 it is RETURN *or* joystick fire.
  So this app cannot tell a human "A works, START does not" or "your fire
  button works, RETURN does not" — the single most useful sentence a
  controller test could say. Two lamps is the ceiling on a machine with
  four physical buttons, and `SELECT` on the NES is not reachable at all.
- **No way to name where a direction came from.** The C64 ORs its cursor
  keys, joystick 2 and a 1351. A dark `LEFT` cannot separate "the stick is
  unplugged" from "the keyboard scan is broken".
- **No second port.** `#fact(input.joysticks)` is 2 on the C64, C128,
  MEGA65 and Atari 8-bit; every layer reads one of them. Port 1 cannot be
  tested at all through this surface.

Built and screenshotted on all nine targets plus the PET 8032's 80-column
profile. `--screenshot` cannot press anything, so a headless capture only ever shows
the idle screen. Live input still needs a human with a controller.

## fancy

The raster showpiece, and the program that exercises `@8bitscript/raster`
end to end before 2048 leans on it. From inside `fancy/`:

```
8bs run c64                                # the raster interrupt, for real
8bs run web --hardware machine=c64        # the same list, applied by the renderer
8bs run pet                                # no raster: the static title, by design
8bs run c64 --screenshot shot.png --frames 300   # headless: the band, mid-wobble
```

It prints `F A N C Y` inside a band of colour splits — background to red
and border to yellow a text row above the title, back to black a row
below — and wobbles the title's three text rows on a 32-step sine wave:
twelve `Slot.SCROLL_X` entries, one per **two** scanlines (the pitch the
C64's handler can actually keep — see `packages/c64/AGENTS.md`'s
wobble-band entry), their lines and slots written once with
`raster.at()` and only their value bytes rewritten each frame with
`raster.setValue()`. Under it:

- **FRAME** — one per trip round the loop, the liveness signal, same as
  joystick. On the machines with no raster it is the only thing that
  moves.
- **RASTER** — `#fact(video.raster)` for the machine this build was made
  for: `1` on the C64 and the web, `0` everywhere else.

**On the other seven machines the title stands still, and that is the
point, not a bug.** `#fact(video.raster)` is false on the PET, VIC-20,
C128, X16, MEGA65, Atari 8-bit and NES — their rasterline layers are
honest zero-answer stubs — so every raster call in this program sits
behind that fact and folds away to nothing: the folded build is
byte-identical to one with the raster code deleted outright (measured in
`fancy/src/main.8bs`'s header). What those machines show is the static
title, the caption saying so, and the climbing frame counter.

The test in `test/` checks that the manifest names a real project and that
each program links clean for every one of its targets.

## swarm

The moving-objects showpiece, and the program that exercises
`@8bitscript/sprites` and `@8bitscript/timeline` end to end — the two
packages `docs/project/frame.md` (the frame, across nine machines) ships
first. From inside `swarm/`:

```
8bs run c64                                # sixteen sprites from eight, through the border
8bs run pet                                # eight quadrant-block rings, at 4-pixel steps, over the title
8bs run vic20                              # sixteen glyphs on the grid, in colour, on 22 columns
8bs run c64 --screenshot shot.png --frames 700   # headless, mid-scene
```

Five files, each one kind of thing:

- `src/swarm.8bs` — the program: the frame loop, and nothing else.
- `src/Scene.8bx` — *when*: the cues, composed. `{timeline.at(60) &&
  <Release />}`, `{timeline.at(180) && <Open />}`, `{timeline.every(32)
  && <Recolor />}` — the conditional the language already has, folded
  like any other, so it reads like a demo's part list and costs a 16-bit
  compare a cue.
- `src/flock.8bs` — *how*: where every sprite is and which way it goes,
  in stage pixels (`sprites.ORIGIN_X`/`ORIGIN_Y` are the playfield's
  top-left: 24, 50 on the C64, 0, 0 on a cell machine), bouncing off
  `sprites.left()`/`right()`/`top()`/`bottom()`, which widen on the C64
  when the scene opens the border.
- `src/counter.8bs` — *the count on screen*: five digits kept in place,
  one `text.putChar` a frame (a five-digit `printNumber` every frame was
  ~2,800 cycles on the C64 under the compiler's code, a sixth of the
  frame; ~1,265 through `native/6502/text.s`, still more than one poke).
- `src/shapes.8bs`, `src/shapes.c64.8bs` and `src/shapes.pet.8bs` — *what
  a sprite looks like*: an `O` on seven machines, a 24 × 21 ring drawn
  into a sprite block on the C64, a 4 × 4 pseudo-pixel ring defined
  through the PET twin's `defineShape`. The compiler's twin rule picks
  the `.c64.8bs` or `.pet.8bs` file for those builds; the program never
  names either.

What a screenshot shows: before frame 60 the title and the counter;
from 60 the sprites bouncing; from 180 to 420 on the C64, rings above
line 50 and below 250 — in the border, which no C64 draws in without
`sprites.extend(true)`; every 32 frames the colours step along white,
yellow, cyan, green. `SPRITES` prints what the machine gave (the program
asks for 16; `sprites.MAX` is 24 on the C64, 16 in cells, 8 on the PET,
whose quadrant objects cost ~2,600 cycles a redraw), `FRAME` climbs once
an iteration. The flock keeps off the two text rows everywhere but the
C64, whose sprites are an overlay the text shows through; a PET quadrant
object restores what it covered when it leaves, which is not the same
thing — a counter reprinted under a standing ring would come back stale.

**What it costs**, program bytes then RAM (`8bs build <target> --size`,
2026-09-19): pet 4162 / 84 — past the stock 2001's 3071 by the quadrant
twin's tables (252 bytes of shape patterns, 72 of save-under, the
merge), so the config's PET is the 32K 3032; vic20 2881 / 70 of the
unexpanded 3583; c128 2882; mega65 2947; atari8 2941; cx16 3553; c64
4744 / 71 — the one machine that carries the multiplexer (native now),
the raster handler, the border, and the native text routines (the
title's print and the number routine, 275 of the bytes; 4622 before
them); nes a fixed ROM; web 23 bytes of constants.

**What it costs in time**, measured with each machine's own timer around
each stage of the loop (`swarm.8bs`'s header has the C64 numbers): one
hardware frame an iteration on the VIC-20 — after the cell layer learned
to redraw only what changed, count the sprites on each row so its "is
another sprite in the cell I am leaving" scan runs only where it can
matter, and build a cell number from folded shifts instead of the
generic multiply; **one or two on the PET** by how many of its eight
rings overlap that frame (a quadrant sprite is ~2,600 cycles to erase
and redraw, and one that touches a mover is redrawn with it — frame 367
at hardware frame 515 in a 700-frame screenshot); and **one on the
C64**, ~15,300 cycles of the frame's 17,095 with the VIC's own steal
inside — a frame lost on about half the frames that recolour all
sixteen (FRAME 776 at `--frames 1000`, 789 being every frame). It was
two the same morning: `multiplex.update()` alone was ~16,000 cycles in
the compiler's generic code, and is native assembly now
(`packages/c64/native/6502/multiplex.s`); the counter and the recolour
each gave back a call a sprite, as the header records. The program's own
habits are the budget's: X in half pixels, half the flock moved a frame,
digits kept as digits.

## hello-bx

The `hello-world` greeting again, this time as a component. From inside
`hello-bx/`:

```
8bs run pet               # the 2001, in VICE
8bs run web                # the browser
```

Two files. `src/Hello.8bx` declares the component and nothing else:

```
export component Hello() {
    text.print(0, "Hello World!");
}
```

`src/hello-bx.8bs` is the program — a program always starts from a
`.8bs` file — and reaches the component by importing it and calling it:
`Hello();` is `<Hello />` the way `.8bs` can spell it. The component
elaborates to the same `text.print(0, "Hello World!")` call
`hello-world/src/hello-world.8bs` writes by hand, and the two PET builds
are byte-identical (108 bytes each; `packages/cli/test/hello-bx.test.mjs`
checks). The point isn't that this one program needed a component; it's
the smallest possible proof that a component costs nothing a hand-written
call wouldn't. See `docs/compiler.md` for where 8BX elaboration sits in
the pipeline.
