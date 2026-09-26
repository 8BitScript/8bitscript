# Hello, BX

The same greeting as `hello-world`, drawn through `Hello.8bx` instead of a direct `text.print()`. On the release PET and C64 this build is byte-identical to `hello-world` once the component inlines. Neither carries media — see `hello-world`'s own source for why a program that draws once and returns can drive none.

Targets: [`../shared-release-targets.ts`](../shared-release-targets.ts).

## Run

```
8bs run c64
8bs run pet
8bs run web
```

## Size

| Target | `memory.program` |
| --- | ---: |
| C64 | 2230 |
| PET (4032 32K) | 1944 |

See `docs/compiler.md` for where 8BX elaboration sits in the pipeline.
