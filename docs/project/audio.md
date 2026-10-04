---
title: Portable audio
nav_order: 89
---

# Portable audio

A thin slice: one WAV/FLAC-backed sample plus a tiny song, compiled
through a `.8ba` file into target-native data. This is a new asset layer,
not a replacement for `@8bitscript/c64/sid` or `@8bitscript/atari8/pokey`.
Those stay the machine primitives. `.8ba` is how a sample or a tune becomes
data a chip driver can play.

Resource names (`song theme`, `sample blip`) are asset ids. `8BS1034` does
not apply to names elaborated from `.8ba`.

## What a file looks like

```8ba
instrument lead {
  waveform pulse
  polyphony 1
}

sample blip {
  source "./blip.wav"
  fallback { synth noise }
}

song theme {
  tempo 120
  speed 6
  order { main }
  pattern main length 16 {
    track lead {
      row 0 { note C4; instrument lead; }
      row 8 { note G4; }
    }
  }
}
```

A file that exports only an instrument is valid. WAV PCM is decoded
in-process (`@8bitscript/audio-tools`); FLAC goes through FFmpeg, which
`8bs doctor` reports the same way it reports an optional emulator. A
missing FFmpeg fails a FLAC source with `8BS2213` and leaves WAV working.

```8bs
import { blip, theme } from "./theme.8ba";
import { audio } from "@8bitscript/audio";

audio.play(blip);
audio.music(theme);
audio.update();
```

`audio.update()` once a frame steps the song.

## How the four stress machines differ

| Machine | Sample | Song |
| --- | --- | --- |
| C64 | Not a `$D418` digi. The declared `fallback { synth … }` plays (`8BS2210`). | Drives `@8bitscript/c64/sid`. |
| NES | DPCM when the encoder can represent the clip; otherwise the synth fallback (`8BS2210`). Saw is unroutable (`8BS2212`). | Pulse + noise through `@8bitscript/nes/apu`. |
| PET | Synth fallback only if the one VIA voice can play it; noise is omitted. Stock 2001 has `audio.voices` 0, so playback is omitted (`8BS2211`). | VIA CB2 square wave when a speaker is attached. |
| Atari 8-bit | Not volume-only PCM. Synth fallback (`8BS2210`). | Drives `@8bitscript/atari8/pokey`. |
| VIC-20 | The first note on the soprano voice (the synth fallback). | The soprano voice, one note at a time. |
| Commander X16 | The first note on PSG voice 0. | PSG voice 0, one note at a time. |
| Web | No driver: **no sample bytes**, `8BS2211`. | No driver: **no song bytes**, `8BS2211`. |
| every other machine | No driver: **no sample bytes**, `8BS2211`. | No driver: **no song bytes**, `8BS2211`. Silence is a declared fallback. |

## A single tone: `audio.tone`

A game's blips (a reel tick, a win jingle) do not need a `.8ba` file. The
same package plays one tone, and a game strings tones into a jingle:

```8bs
import { audio } from "@8bitscript/audio";

audio.tone(57, 30);   // A4 for thirty calls of update()
audio.update();       // once a frame; counts the tone down, then silence
audio.silence();      // stop now
```

`note` is the `.8ba` index, `octave * 12 + semitone` with C0 = 0 and A4 = 57
(the SID's `Note` index). `frames` is how many calls of `audio.update()` it
sounds for, so it is timed in the program's own frames, not in seconds; 0
is 1. A new tone replaces whatever is sounding. Nothing blocks.

Each machine can play a different range, and says which in two constants a
program folds on: `audio.NOTE_LOW` and `audio.NOTE_HIGH`. A note outside the
range is moved by whole octaves into it, so the pitch class survives and the
octave is what a small chip gives up. A machine with no driver answers 0 and
0, and `audio.tone` costs it nothing.

| Machine | Voice | Notes | Measured |
| --- | --- | --- | --- |
| C64 | SID voice 0, pulse | C0..B6 (0-83) | register dump: Fn 7218 → 440.0 Hz, 14436 → 879.9 Hz |
| VIC-20 | soprano, 7-bit divisor | C3..B5 (36-71) | WAV: 443.5 Hz, 887.6 Hz (+15 cents); the table is NTSC, a PAL machine plays about a semitone and a half sharp |
| PET | the VIA's CB2 square wave | C4..B5 (48-71) | WAV: 441.0 Hz, 880.5 Hz; needs `audio.voices` 1 (the CRTC models, or `speaker=attached`) to be heard |
| Commander X16 | VERA PSG voice 0, pulse | C3..B7 (36-95) | WAV: 439.9 Hz, 881.0 Hz |
| Web | one Web Audio oscillator, square | C2..B7 (24-95) | not heard: see below |
| every other machine | none | none (0-0) | — |

"Measured" is a headless run: VICE 3.10 and x16emu r50, 2026-10-04,
`packages/audio/test/tone.test.mjs`. The SID and the VIC-I are also read
register by register from VICE's `dump` sound device, which needs no audio
device. The PET and X16 are measured on a recorded WAV.

**The web.** The synthetic web host has no chip to be faithful to, so its
voice is four bytes in the program's memory — gate, note, wave, volume —
that the page reads at every paint and plays through one Web Audio
oscillator (`packages/web/src/voice.8bs`, `packages/cli/src/web-audio.mjs`).
What is tested is every step but the speaker: the program writes the right
bytes, the bytes map to the right frequency, waveform and level, and the page
drives an oscillator from them (with a stand-in `AudioContext`), and the
register timeline of a real compiled program renders to samples that measure
at the pitch and length it asked for. **A real browser tab was not
available, so the sound itself has not been heard.** The browser starts audio
only after a key press or a tap; until then the page's context is suspended
and resumes at the first paint after one. A tone shorter than one paint (about
16 ms) can fall between two paints and not be heard.

Voice assignment in this slice is one monophonic track, `polyphony 1`,
routed to the first channel that can play `pulse` or `noise`. No stealing.
A request the chip cannot satisfy is a diagnostic, not a dropped note.

Song bytes are `[tempo, speed, rows, count]` then events `row, note, wave, voice`.
Wave 0 pulse / 1 noise / 2 triangle / 3 saw.

## Volume and plucked tones: `audio.setLevel`, `audio.blip`

A game that plays a sound many times a second wants it quiet and short, and a
tone that is not told to stop must not drone. Two more calls and a constant:

```8bs
audio.setLevel(6);      // the volume every tone, blip and song plays at: 0 (silent) .. audio.LEVEL_MAX
audio.blip(48, 3);      // a plucked tone: starts at the level and dies away within 3 frames
audio.tone(57, 30);     // a plain tone holds its level for its frames
```

`audio.LEVEL_MAX` is the loudest level the machine takes: 15 on the C64, VIC-20,
X16 and web, 1 on the PET (a one-bit speaker has no volume: any level above 0 is
the square wave, and 0 mutes), 0 where there is no driver. A level above the
maximum is the maximum. `setLevel(0)` is silence for `tone`, `blip` and songs.

A **blip** is a tone that fades by itself. The SID has an envelope for that: the
note gets a decay and no sustain, so it is gone even if `update()` is never
called. The VIC-I, the PSG and the web oscillator have none, so `update()` walks
the volume down a step a frame to 0 on the note's last frame; the PET has no
volume, so a blip is a plain tone. `frames` is the length, as for `tone`.

## Diagnostics (`8BS22xx`)

| Code | Means |
| --- | --- |
| 8BS2201 | Audio syntax error |
| 8BS2202 | Unexpected character |
| 8BS2203 | Unterminated string |
| 8BS2204 | Missing or unreadable WAV/FLAC |
| 8BS2205 | Sample missing `fallback { synth … }` |
| 8BS2206 | Unknown waveform |
| 8BS2207 | Duplicate resource name |
| 8BS2208 | Unknown field |
| 8BS2209 | Unknown note |
| 8BS2210 | PCM replaced by the declared synth fallback |
| 8BS2211 | No audio driver; playback omitted |
| 8BS2212 | Waveform the target cannot route |
| 8BS2213 | FLAC source needs FFmpeg on PATH |
| 8BS2214 | Missing required field |
| 8BS2215 | Song names an unknown instrument |

## What it costs

Measured with the graphics slice on `packages/examples/media-walk` — see
[graphics.md](graphics.md#what-it-costs).

Later: full tracker effects, parts, voice groups, affinity and stealing,
cross-file `import`, MIDI and module import, Famicom expansion audio.
The AIR has empty slots (`parts`, `voiceGroups`) so those land without
reshaping the IR.
