# @8bitscript/random

Deterministic pseudo-random generators, the same code on every target —
VIC-20, C64, PET, C128, Atari 8-bit, NES, Commander X16, MEGA65, and web.
Two, at two import paths, with the same calls — and a third path,
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
| `range(bound)` | A value from 0 up to (not including) `bound`, **exactly uniform** — see [below](#range-and-bits-are-exactly-uniform) |
| `bits(count)` | The top `count` bits of `next()` (1 to 8): a value from 0 up to 2^`count`, exactly uniform, no rejection |

`table` adds one more call, since it has no reason not to: `at(index)`
reads the table directly with no state of its own, for a program that
already keeps its own running counter (frames elapsed is the usual one).

## Which one

| | `@8bitscript/random` | `@8bitscript/random/table` |
| --- | --- | --- |
| How `next()` works | `state = state * 25173 + 13849`, return the high byte | `TABLE[index]`, then `index++` |
| Cost per call | A 16-bit multiply and add | One indexed load |
| Period | 65536 | 256 |
| `next()` distribution | Every byte exactly 256 times per period | Every byte exactly once per 256 consecutive calls — the table is a permutation of 0-255 |
| `range()` / `bits()` | Exactly uniform | Exactly uniform |

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

## `range()` and `bits()` are exactly uniform

`next() % bound` is not. 256 is not a multiple of most bounds, so the first
`256 % bound` outcomes get one more byte than the rest. Measured over the
generator's whole period (every byte comes up exactly 256 times, so these
are counts, not samples):

| `bound` | likeliest outcome | least likely | ratio |
| --- | --- | --- | --- |
| 6 (a die) | 16.80% | 16.41% | 1.024 |
| 37 (a roulette wheel) | 2.734% (7 bytes in 256) | 2.344% (6 bytes) | 1.167 |
| 52 (a deck) | 1.953% | 1.563% | 1.250 |
| 100 | 1.172% | 0.781% | 1.500 |
| 150 and 200 | 0.781% | 0.391% | 2.000 |

A game that publishes its odds cannot ship that, so `range()` throws away
the bytes that would make the split uneven — the last `256 % bound` values,
the incomplete final block — and draws again. What is left is a whole number
of complete blocks, and every outcome is exactly as likely as every other.
The test costs one modulo (the same `%` the biased form used): a byte is
kept when `byte - byte % bound <= 256 - bound`. A bound that divides 256
never redraws; any other redraws fewer than half the time. The sequence is
still completely determined by the seed — only the number of bytes a call
takes is no longer fixed.

`bits(count)` is the call for a power-of-two choice (a coin, one of 8 reel
stops, one of 64 virtual stops): the top bits of one byte, no redraw. It
takes the *top* bits because that is where an LCG is best mixed.

**Behaviour change.** `range()` used to be `next() % bound`, and its
comment called the bias "under 1/256 of a percentage point"; 1/256 is an
absolute probability of 0.39 percentage points, and the table above is the
real size. A program that seeds the generator and uses `range()` now gets a
different sequence whenever a draw lands in the rejected block — `256 %
bound` bytes in 256, so 4 in 256 for a die and 34 in 256 for a wheel — and
the same sequence otherwise. `next()` and `seed()` are unchanged, so a
program that draws bytes itself sees no difference. Nothing in this
repository depended on the exact sequence (2048 pins an older CLI and is
unaffected until it moves).

**What it costs**, on a program with `seed()`, two `range()` calls and a
`next()` (`8bs build <target> --size`, program bytes and RAM, before →
after): C64 165 → 220 and 13 → 16, PET and VIC-20 204 → 262 and 13 → 16,
X16 168 → 223 and 13 → 16, web `.wasm` 153 → 216. That is the rejection loop
and its three locals, once, shared by every call site. `bits()` adds about 26 bytes of loop on top of `next()` (75 bytes
in a program that uses nothing else, `next()` included). The compiler does not
specialise `range()` per call site, so a constant bound still tests the
block limit at run time.

**Tested by counting.** `test/uniform.test.mjs` compiles the generator for
the web target and runs one whole period through `range(n)` — exactly
`256 × (256 − 256 % n)` accepted draws — and asserts every outcome came up
exactly `256 × ⌊256 / n⌋` times; the same over one pass of the table.
It also checks the compiled draws value for value against the algorithm,
and builds the whole surface for the PET, VIC-20, C64 and X16, because a
`link` does not reach the 6502 backend (it refuses a run-time shift, which
is why `bits()` shifts a bit at a time rather than by `8 - count`).

**What it does not fix: the state is 16 bits.** A seeded run repeats after
65,536 steps and only 65,536 distinct games exist, whatever the seed;
a 52-card shuffle can reach 65,536 of its 52! orderings. That is plenty
for slot-reel stops and nowhere near a statement about "every possible
deal". A wider generator — a 16-bit LCG and a 16-bit LFSR with coprime
periods, about 2^32 states — was built and measured and **not shipped**: it
cost +173 bytes of program over the default on the C64 (393 against 220 for
the same program) and +8 of RAM, and a hand-built combination has not been
through a statistical battery. If a game needs it, that is the number to
beat.

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

**`range()` and `bits()`: forwarded in software, written out on the two
hardware twins.** The software `entropy` calls `random.range()` and
`random.bits()` — one copy of the rejection loop. A forwarder used to cost 8
bytes a target; the compiler now folds a `return f(x);` delegate away
(measured again: 231 bytes of program on the PET either way). The C64 and
Atari twins read a register, so each carries its own loop over `random.byte()`
(`entropy_range` is 71 bytes on the C64, `entropy_bits` 30, each with its register read inlined). Reads a few cycles
apart are not independent samples of the noise — hardware entropy is for a
seed or a shuffle, not for statistics — but the arithmetic favours no
outcome. `entropy.test.mjs` checks the bodies.

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
