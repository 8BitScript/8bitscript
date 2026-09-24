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
| VIC-20 | No driver: **no sample bytes**, `8BS2211`. | No driver: **no song bytes**, `8BS2211`. |
| Commander X16 | No driver: **no sample bytes**, `8BS2211`. | No driver: **no song bytes**, `8BS2211`. |
| every other machine | No driver: **no sample bytes**, `8BS2211`. | No driver: **no song bytes**, `8BS2211`. Silence is a declared fallback. |

Voice assignment in this slice is one monophonic track, `polyphony 1`,
routed to the first channel that can play `pulse` or `noise`. No stealing.
A request the chip cannot satisfy is a diagnostic, not a dropped note.

Song bytes are `[tempo, speed, rows, count]` then events `row, note, wave, voice`.
Wave 0 pulse / 1 noise / 2 triangle / 3 saw.

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
