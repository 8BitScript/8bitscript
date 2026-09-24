# Hello, BX

The same greeting as `hello-world`, drawn through `Hello.8bx` instead of a direct `text.print()`. Shared `mark.8bg` / `chime.8ba` match the other examples; on the release PET and C64 this build is byte-identical to `hello-world` once the component inlines.

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
