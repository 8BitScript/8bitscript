# @8bitscript/random

Deterministic pseudo-random generators, the same code on every target —
VIC-20, C64, PET, C128, Atari 8-bit, NES, Commander X16, MEGA65, and web.
Two, at two import paths, with the same three calls — and a third path,
[`/entropy`](#entropy-hardware-where-a-machine-has-it), that is one of the
machine's own entropy sources where it has one:

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
either one's `seed()`. A program that has decided it wants the register on
every draw, not just for a seed, says so with the import below.

## `/entropy`: hardware where a machine has it

```
import { entropy } from "@8bitscript/random/entropy";

entropy.begin();                      // first statement of main() — see below
// every frame:
entropy.tick();
// when a number is wanted:
let cell: utinyint = entropy.range(16);
```

| Call | C64 | Atari 8-bit | The other seven |
| --- | --- | --- | --- |
| `begin()` | Claims SID voice 3 for noise, silenced (`@8bitscript/c64/random`'s own `begin()`) | Nothing | Nothing |
| `tick()` | Nothing — the oscillator free-runs | Nothing — POKEY's counter free-runs | One step of the default generator |
| `next()` | A byte of the oscillator | A byte of POKEY's `RANDOM` | The default generator's `next()` |
| `range(bound)` | that `% bound` | that `% bound` | that `% bound` |

One import; the compiler picks the file. `src/entropy.8bs` is the portable
generator, and `entropy.c64.8bs` and `entropy.atari8.8bs` beside it are
the machine twins the resolver takes for those two builds on its own — the
same rule that makes `screen.nes.8bs` the NES's `screen.8bs`. A program
never names them.

**What it is for.** A game that wants every spawn, every shuffle, to be
unpredictable on the machines that can offer it, without carrying its own
twin file per machine to say so. 2048 is where this was extracted from: its
three `rng.8bs` files became this one import, and all nine of its builds
are byte-identical to before — 2763 bytes on the 4K PET 2001, 3490 on the
unexpanded VIC-20, 4599 on the C64, 3720 on the Atari 8-bit (0.11.0).
The two hardware builds are *smaller* than the software generator would
make them (40 and 70 bytes at 0.6.2, by 2048's own measurement), which is
the whole case for reading hardware inside game logic rather than once at
start-up.

**What it costs.** Replay. On the C64 and the Atari every `range()` reads a
register, so a game cannot be reproduced from its start state or from a
screenshot — a program that needs that keeps the bare import and seeds it
once instead. And on the C64, `begin()` writes `$D418` as a whole known
byte (the SID's low registers are write-only), so it must run before
anything else touches the chip; a program that also plays sound has to read
`@8bitscript/c64/random`'s header, not just add notes.

**`tick()` once a frame.** On the seven software targets a generator that
only advances when asked plays the same game every run; stepping it every
frame makes the sequence depend on the player's timing too, which is as
much unpredictability as a machine with no entropy source can offer. The
hardware twins make it empty, so the call inlines away to nothing there.

**`range()` computes; it does not delegate.** Each file writes `range()` as
`next-or-byte % bound` rather than forwarding to `random.range()`: the
forwarding form measured +8 bytes on every 6502 target (PET, VIC-20, C128,
CX16, MEGA65 alike), because a call whose only job is to pass an argument
on does not inline away. `entropy.test.mjs` checks the bodies stay that
way.

**Not yet on the C128 or MEGA65.** Both have a SID and answer
`#fact(audio.entropy)` true, but neither machine package has a `./random`
module yet, so `/entropy` is the software generator there until one exists
— one more twin each, once it does.

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

See [`src/index.8bs`](src/index.8bs), [`src/table.8bs`](src/table.8bs) and
[`src/entropy.8bs`](src/entropy.8bs) for each generator and the reasoning
behind it.
