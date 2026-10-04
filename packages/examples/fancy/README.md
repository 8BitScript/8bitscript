# Fancy

Raster showpiece: title wobble and colour bands behind `#fact(video.raster)` on C64, X16 and web; the colour bands without the wobble on VIC-20 (`raster.FINE_SCROLL` is false there); static title elsewhere. Four pillars: `Mark.8bx`, `mark.8bg`, `chime.8ba`.

Targets: [`../shared-release-targets.ts`](../shared-release-targets.ts).

## Run

```
8bs run c64
8bs run web
8bs run pet
```

## Size

| Target | `memory.program` |
| --- | ---: |
| C64 | 5374 |
| PET (4032 32K) | 4027 |

On the PET the raster effect folds away; the frame counter still moves. The X16 shows the bands and the wobble through VERA's line interrupt: 5206 bytes against 3692 without it (measured 2026-10-03). The VIC-20 (8K) shows the colour bands and folds the wobble away: 3654 bytes, 851 of them the raster list (2803 without it, measured 2026-09-29).

On the C64 the sprite layer's `graphics.update()` rebuilds the whole raster
list each call, which would erase this example's bands and wobble, so `Mark` is
published once before the list is built and the loop leaves `update()` alone
there (`packages/c64/AGENTS.md`, "graphics.update() and a raster list of your
own"). Every other machine calls it each frame.
