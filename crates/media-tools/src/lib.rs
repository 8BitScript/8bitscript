//! Port of `packages/graphics-tools/src/index.mjs` (decoders and frame
//! helpers, not `chunk`/`encodePng`/`contentHash`) and
//! `packages/audio-tools/src/index.mjs` (not `encodeWav`).
//!
//! Deviations from the JS are recorded in `oracle/divergences.toml` (R7.6, one
//! line per site, tagged `media-tools:`): the zlib data-error text of
//! [`png::decode_png`] and `resolve_ffmpeg` being compiled out on `wasm32`.
//! [`audio::decode_flac`] returns [`audio::AudioError`] `{ message, code }`
//! because the JS error carries `code = 'FLAC_NEEDS_FFMPEG'` (R7.4, exact).

// The JS walks flat byte arrays in steps of 4; keep that shape.
#![allow(clippy::chunks_exact_to_as_chunks)]

pub mod audio;
pub mod png;

/// `Math.round`: ties go toward +Infinity, NaN stays NaN.
pub(crate) fn js_round(x: f64) -> f64 {
    let r = x.floor();
    if x - r >= 0.5 { r + 1.0 } else { r }
}
