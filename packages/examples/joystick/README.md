# Joystick

The controller test app: a labelled map of `@8bitscript/input`, lamps on each control, SEEN/FRAME counters, and capability facts. Four pillars: `Mark.8bx`, `mark.8bg`, `chime.8ba` (startup blip only).

Targets: [`../shared-release-targets.ts`](../shared-release-targets.ts) — PET **4032** 32K, VIC-20 **8K**.

## Run

```
8bs run c64
8bs run pet
8bs run vic20
```

## Size

| Target | `memory.program` |
| --- | ---: |
| C64 | 5992 |
| PET (4032 32K) | 5301 |

Lamps use reverse video, not colour alone (three release targets have no per-cell colour).
