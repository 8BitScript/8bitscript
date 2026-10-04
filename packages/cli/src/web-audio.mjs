// What the synthetic web host plays: one voice, read from the program's memory.
//
// The page (web-loader.mjs) reads four bytes at the layout's `audioBase` at
// every paint — gate, note, wave, volume (web-layout.mjs `AudioRegister`) —
// and drives one Web Audio oscillator from them. This module is the plain
// statement of that mapping, with nothing in it that needs a browser:
//
//   toneHz(note)         the frequency a note index plays (A4 = 57 = 440 Hz)
//   voiceState(mem, at)  the four registers as a voice: sounding or not, hz,
//                        the oscillator's waveform name, its level (0..0.5)
//   renderVoice(frames)  the samples that a run of per-frame register
//                        snapshots would sound, phase-continuous across
//                        frames, so a test can measure the pitch and the
//                        length of what a program asked for without a speaker
//
// `toneHz` and `voiceState` are dependency-free so the loader can carry a copy
// of them (it interpolates their source into the page, as it does userGlyph).
// A real browser tab was not available to check the page against: what the
// tests prove is that the registers a program writes map to the frequency,
// waveform and level below, and that the page applies exactly this mapping.

/**
 * @param {number} note the @8bitscript/audio note index, octave * 12 + semitone, C0 = 0
 * @returns {number} Hz, equal temperament, A4 (57) = 440
 */
export function toneHz(note) {
  return 440 * Math.pow(2, (note - 57) / 12);
}

/**
 * @param {Uint8Array} mem the program's memory
 * @param {number} audioBase the first register's address, or negative for a host with none
 * @returns {{ on: boolean, hz: number, wave: string, level: number }}
 */
export function voiceState(mem, audioBase) {
  if (audioBase < 0) return { on: false, hz: 0, wave: 'square', level: 0 };
  var waves = ['square', 'triangle', 'sawtooth'];
  var wave = waves[mem[audioBase + 2]] || 'square';
  var volume = mem[audioBase + 3] & 15;
  var on = mem[audioBase] !== 0 && volume !== 0;
  return { on: on, hz: toneHz(mem[audioBase + 1]), wave: wave, level: on ? (volume / 15) * 0.5 : 0 };
}

// One sample of a unit oscillator at `phase` (0..1).
function oscillator(wave, phase) {
  if (wave === 'triangle') return 4 * Math.abs(phase - 0.5) - 1;
  if (wave === 'sawtooth') return 2 * phase - 1;
  return phase < 0.5 ? 1 : -1;
}

/**
 * The audio a run of logical frames sounds: `frames` is one `voiceState` per
 * frame, each held for 1 / frameRate seconds. The phase carries over from a
 * frame to the next, so a held note is one unbroken wave and a change of note
 * is a change of pitch, not a restart.
 *
 * @param {{ on: boolean, hz: number, wave: string, level: number }[]} frames
 * @param {{ sampleRate?: number, frameRate?: number }} [options]
 * @returns {Float32Array}
 */
export function renderVoice(frames, { sampleRate = 48000, frameRate = 60 } = {}) {
  const out = new Float32Array(Math.round((frames.length * sampleRate) / frameRate));
  let phase = 0;
  for (let i = 0; i < out.length; i += 1) {
    const frame = frames[Math.min(frames.length - 1, Math.floor((i * frameRate) / sampleRate))];
    if (!frame.on) continue;
    out[i] = frame.level * oscillator(frame.wave, phase);
    phase = (phase + frame.hz / sampleRate) % 1;
  }
  return out;
}
