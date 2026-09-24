# Fancy

Raster showpiece: title wobble and colour bands behind `#fact(video.raster)` on C64 and web; static title elsewhere. Four pillars: `Mark.8bx`, `mark.8bg`, `chime.8ba`.

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

On PET and VIC-20 the raster effect folds away; the frame counter still moves.
