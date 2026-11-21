# Media walk

One PNG walk cycle (`player.8bg`), WAV blip and two-note song (`theme.8ba`), composed in `Walk.8bx`. Shared `mark.8bg` / `chime.8ba` sit beside the hero assets. PET build uses **4032** 32K with an attached speaker so the VIA song plays.

Targets: release five from [`../shared-release-targets.mjs`](../shared-release-targets.mjs), with `speaker: attached` on PET.

## Run

```
8bs run c64
8bs run pet
8bs run vic20
```

Regenerate `player.png` / `blip.wav` with `node generate-assets.mjs`; shared mark/chime via `node ../generate-shared-assets.mjs`.

## Size

| Target | `memory::program` |
| --- | ---: |
| C64 | 6309 |
| PET (4032 32K, speaker) | 4714 |
| VIC-20 (8K) | 3744 |
| Commander X16 | 5469 |
| Web (wasm module bytes) | 4040 |

See `docs/project/graphics.md` and `docs/project/audio.md` for adaptations and diagnostics.
