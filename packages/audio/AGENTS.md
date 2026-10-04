# Working on `@8bitscript/audio`

[`docs/project/audio.md`](../../docs/project/audio.md) is the design and what
each call does; this file is what the next person touching a twin must keep
true, and how to listen without a speaker. Read the root
[`AGENTS.md`](../../AGENTS.md) first.

## The surface

`audio.bind` / `meta` (called by the `.8ba` lowering), `play`, `music`,
`update`, and the portable tone: `audio.tone(note, frames)`,
`audio.silence()`, and the two constants `audio.NOTE_LOW` / `audio.NOTE_HIGH`.
Every twin (`src/index.<machine>.8bs`, and the generic `src/index.8bs` for a
machine with no driver) exports every one of them, so a portable program links
anywhere and costs nothing where there is no sound. A machine with no driver
answers `0` and `0`; the NES and Atari 8-bit twins state those two and stub the
calls ("not written for the APU / POKEY yet": both machines are parked, and a
stub that says so is the honest answer). `packages/compiler/test/audio-tone.test.mjs`
is the gate: it links a probe on all thirty-two targets, checks each constant
folds to a literal, and holds every pitch table to the chip's formula.

**`note` is the `.8ba` index** — `octave * 12 + semitone`, C0 = 0, A4 = 57,
the SID's `Note` index — on every machine. A note outside a machine's range is
folded by whole octaves into it (`while (n < LOW) n += 12`), so the pitch class
survives. **`frames` counts calls of `audio.update()`**, not time. `tone`
replaces the tone sounding; `sfxLeft` is the shared countdown that
`play(slot)` already used.

## Pitch, per chip, as measured

Do not change a table without re-measuring: two of these were two octaves off
the notes they were indexed by for as long as nothing measured them.

| Machine | Formula | Range | Where it is checked |
| --- | --- | --- | --- |
| C64 | the SID's own `NOTE_PAL` / `NOTE_NTSC`; Fn · clock / 2^24 | C0..B6 | register dump: Fn 7218 → 440.0 Hz on NTSC. The first tone calls `sid.detectRegion()` (two frames, once), because the SID table defaults to PAL and plays NTSC 3.8% sharp |
| VIC-20 | soprano voice: Φ2 / (64 · a), a = 7-bit divisor, 1,022,727 Hz | C3..B5 | WAV: A4 443.5 Hz, A5 887.6 Hz. The table is NTSC; PAL's clock is 8% faster |
| PET | the VIA shifts a bit every 2 (T2 + 2) cycles, an 8-bit pattern: 1,000,000 / (16 (T2 + 2)) Hz | C4..B5 | WAV: A4 441.0, A5 880.5 Hz. The old table was labelled C3..B4 and played C4..B5 |
| X16 | VERA PSG frequency word = Hz · 2^17 / 48828.125; volume byte needs both channel bits `$C0`; waveform in bits 7:6 | C3..B7 | WAV: 439.9 and 881.0 Hz |
| Web | the page: `440 · 2^((note − 57) / 12)` | C2..B7 | the mapping and the program's register writes; **not heard** |

**The X16 PSG module used to play nothing.** It wrote the volume with no
channel-enable bits (`00` disables the voice whatever its volume) and computed
a falling pitch from the note. `packages/cx16/src/psg.8bs` now writes `$C0 |
volume * 4` and takes the frequency word from a table. The test that notices
is `tone.test.mjs`'s X16 run (peak 0 with the bits removed) and the source
check in `audio-tone.test.mjs`.

## Listening without a speaker

`test/capture.mjs` is the whole kit; read its header. In short:

- **VICE records a WAV only through a real output device** — `-sounddev dummy`
  and `-sounddev dump` both record nothing, whatever `-soundrecdev wav` says.
  So the capture plays through the host device at **2% volume** (`-soundvolume
  2`; 0 is recorded as silence), in `-console` mode so no window opens. That is
  the only way to get the PET's CB2 wave, which is not a register write.
- **The SID and the VIC-I** are also readable exactly from VICE's `dump` sound
  device: `-sounddev dump -soundarg file` writes `delta-clocks register value`
  lines, silent and platform-independent. `sidTones()` and `vicTones()` turn
  them into frequencies and lengths.
- **x16emu** records its own `-wav file`; `SDL_AUDIODRIVER=dummy` keeps it off
  the speakers and `SDL_VIDEODRIVER=dummy` keeps its window from opening.
  (`,auto` waits for the first non-zero sample and writes no file for a program
  that is silent, which is how a silent program looks like a crash.)
- A run must be long enough for the machine to boot **and** for the program to
  start: 3,000,000 cycles was still the BASIC banner on a C64. 9,000,000
  (C64) and 6,000,000-7,000,000 (the others) work.
- `-limitcycles` ends VICE with "Error - cycle limit reached" and exit code 1;
  that is the normal end of a capture here, not a failure.
- The machine packages' tests are not in the CI gate, and CI has no emulator;
  the emulator tests skip when the binary is missing and the WAV ones only run
  on macOS (they need the host sound device). Nothing about pitch is left to
  them alone: the formulas are checked in a compiler test.

## Web

Four bytes after the glyph table, read once a paint: see
[`docs/project/audio.md`](../../docs/project/audio.md#a-single-tone-audiotone)
and `packages/cli/src/web-audio.mjs`. The loader carries hand copies of
`toneHz` and `voiceState`; `packages/cli/test/web-audio.test.mjs` holds them
to the module for every note. A `.8ba` sample or song still has no web driver
(`8BS2211`).
