# @8bitscript/random

Deterministic pseudo-random generators, the same code on every target —
VIC-20, C64, PET, C128, Atari 8-bit, NES, Commander X16, MEGA65, and web.
Two, so far, at two import paths, with the same three calls:

```bash
pnpm add @8bitscript/random
```

```
import { random } from "@8bitscript/random"; // the default: a 16-bit LCG
// or
import { table } from "@8bitscript/random/table"; // a precomputed lookup table

random.seed(1234);
let roll: utinyint = random.range(6) + 1; // 1..6
```

| Call | What it does |
| --- | --- |
| `seed(value)` | Replaces the generator's whole state |
| `next()` | One step of the generator; a byte, 0-255 |
| `range(bound)` | `next() % bound` — a value from 0 up to (not including) `bound` |

`table` adds one more call, since it has no reason not to: `at(index)`
reads the table directly with no state of its own, for a program that
already keeps its own running counter (frames elapsed is the usual one).

## Which one

| | `@8bitscript/random` | `@8bitscript/random/table` |
| --- | --- | --- |
| How `next()` works | `state = state * 25173 + 13849`, return the high byte | `TABLE[index]`, then `index++` |
| Cost per call | A 16-bit multiply and add | One indexed load |
| Period | 65536 | 256 |
| Distribution | Good, not exact | Exact over every 256 consecutive calls — the table is a permutation of 0-255 |

Reach for the default generator first. Reach for `/table` where a 6502
multiply is specifically the thing a piece of code cannot afford — several
picks in one frame, in a routine already fighting for cycles — and a
256-call period is not a problem for what it is picking. The two are
interchangeable at the call site: switching is one import line.

**Deterministic by default, explicitly seeded — never hardware entropy.**
The root [`AGENTS.md`](../../AGENTS.md) rule is that a program's ordinary
random numbers must come from a small, seeded, fixed-state generator, and
hardware entropy (a POKEY register, SID's oscillator 3, timing jitter)
belongs behind its own separate, explicitly optional import. Both
generators here are that default. Neither reads a register on any target —
a program that wants a less predictable seed reaches for a machine's own
entropy source (`@8bitscript/atari8/random`'s POKEY counter,
`@8bitscript/c64/random`'s SID voice 3) and hands the byte it reads to
either one's `seed()`.

**Not called until you call it.** A program that never calls `seed()` gets
the same sequence every run. That is a feature for testing and for
reproducing a bug from a screenshot, not an oversight — call `seed()` once,
from whatever the program wants unpredictable (elapsed frames before the
first key press is the usual shape on a machine with no hardware entropy at
all), and every run after that differs.

**Not cryptographic, on any target.** Public, fixed steps over small state
are exactly as guessable as they sound, table included. This is for game
boards, shuffles, and enemy behavior — nothing a program needs to keep
secret from the person playing it.

See [`src/index.8bs`](src/index.8bs) and [`src/table.8bs`](src/table.8bs)
for each generator and the reasoning behind it.
