# Swarm

Sixteen sprites on a frame timeline — `Scene.8bx` for cues, `flock.8bs` for motion, shape twins for C64/PET. Shared `mark.8bg` / `chime.8ba` in the program entry; primary composition stays in `Scene.8bx`.

Targets: [`../shared-release-targets.ts`](../shared-release-targets.ts).

## Run

```
8bs run c64
8bs run pet
```

## Size

| Target | `memory.program` |
| --- | ---: |
| C64 | 6475 |
| PET (4032 32K) | 4968 |

See `../README.md` and `docs/project/frame.md` for screenshot cues.
