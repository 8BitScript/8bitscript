# Hello, World

`screen.blank()`, then `text.print(0, "Hello World!")`, then return. That is the whole program — see `hello-bx` for the same words through a component.

It carries no media. A program that draws once and returns has no frame to drive any: `audio.update()` is what releases the voice `audio.play()` arms, and `graphics.place()` leaves its drawing to the next update on every machine but the VIC-20 — so a chime here sticks on and an object here costs its whole pipeline to show nothing. Media lives in the examples with a frame loop: `fancy`, `swarm`, `joystick`, `media-walk`.

Targets come from [`../shared-release-targets.ts`](../shared-release-targets.ts) (PET **4032** 32K, VIC-20 8K, C64, CX16, web).

## Run

From this directory:

```
8bs run c64
8bs run pet
8bs run web
```

## Size

Measured with `8bs build` (2026-09-25):

| Target | `memory.program` |
| --- | ---: |
| C64 | 393 |
| PET (4032 32K) | 108 |

`node ../generate-shared-assets.mjs` from `packages/examples/` writes the shared `mark.*` / `chime.*` into the four looping examples; this one and `hello-bx` get none.
