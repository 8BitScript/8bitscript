---
title: "Not yet available"
nav_order: 9
---

# Not yet available

## §8.1 What doesn't exist yet — don't reach for these

Status: **planned**.

Proposed in the 8BX design spec, not present in compiler 0.11.0. Listed here so a reader doesn't spend time on syntax that will currently just fail to parse or check.

| Feature | Status |
| --- | --- |
| Array-typed component props | *planned* |
| Named slots (more than one per component) | *planned* |
| Repetition / list mapping (a JSX-style `.map()` over elements) | *planned* |
| Spread props | *planned* |
| `struct` declarations, and struct-backed component state | *planned* |
| Dynamic (heap or pooled) component instances | *planned* |
| A disk-image *writer* (`c1541` integration) — the config validates images today ([§4.3](project.md#43-package-a-cartridge-or-a-disk-image)) but does not write one | *planned* |

> **An .8bx file can never be a program entry** — that's not a gap, it's the rule in §3. `entry: 'src/main.8bx'` is refused by name before the linker runs.
