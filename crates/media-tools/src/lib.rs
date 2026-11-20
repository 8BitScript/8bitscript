//! Port of `packages/graphics-tools/src/index.mjs` (decoders and frame
//! helpers, not `chunk`/`encodePng`/`contentHash`) and
//! `packages/audio-tools/src/index.mjs` (not `encodeWav`).
//!
//! Deviations from the JS, each accepted:
//! - zlib data errors: `miniz_oxide` reports one generic failure for a bad
//!   deflate body, so [`png::decode_png`] words that case with a fixed
//!   message ("invalid block type"); the header ("incorrect header check",
//!   "unknown compression method", "invalid window size", "Missing
//!   dictionary"), checksum ("incorrect data check") and truncation
//!   ("unexpected end of file") messages match Node exactly.
//! - [`audio::decode_flac`] returns [`audio::AudioError`] `{ message, code }`
//!   because the JS error carries `code = 'FLAC_NEEDS_FFMPEG'`.
//! - A WAV with zero channels (in a sample format that reads samples) is an
//!   error here; accepted: JS does not terminate.
//! - [`png::slice_frames`] with a frame width or height of 0 returns no
//!   frames; accepted: JS does not terminate (the media check rejects a
//!   size below 1, so it is unreachable from the compiler).

// The JS walks flat byte arrays in steps of 4; keep that shape.
#![allow(clippy::chunks_exact_to_as_chunks)]

pub mod audio;
pub mod png;

/// `Math.round`: ties go toward +Infinity, NaN stays NaN.
pub(crate) fn js_round(x: f64) -> f64 {
    let r = x.floor();
    if x - r >= 0.5 { r + 1.0 } else { r }
}
