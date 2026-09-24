# Hello, World

`screen.blank()`, then `text.print(0, "Hello World!")`, plus the shared four-pillar baseline: `Mark.8bx` places `mark.8bg`, and `chime.8ba` plays once at start. The greeting itself stays a direct `text.print()` — see `hello-bx` for the same words through a component.

Targets come from [`../shared-release-targets.ts`](../shared-release-targets.ts) (PET **4032** 32K, VIC-20 8K, C64, CX16, web).

## Run

From this directory:

```
8bs run c64
8bs run pet
8bs run web
```

## Size

Measured with `8bs build` (2026-09-24):

| Target | `memory.program` |
| --- | ---: |
| C64 | 2230 |
| PET (4032 32K) | 1944 |

Regenerate `mark.*` / `chime.*` with `node ../generate-shared-assets.mjs` from `packages/examples/`.
