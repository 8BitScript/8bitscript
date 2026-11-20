//! Tap replay for `parseMediaModule` (`packages/compiler/src/media/index.mjs`).
//!
//! Skips for now (P3-19b): the record's `result` and `after` carry the token list, an empty
//! bound and the diagnostics array, which need their own encoder before `parse_media_module`
//! can be compared.

use front_replay::Replay;
use serde_json::Value;

/// Not replayed yet: the call proves nothing.
#[must_use]
pub fn replay(_record: &Value) -> Replay {
    Replay::Skip
}
