//! Tap replay for `parseMediaModule` (`packages/compiler/src/media/index.mjs`).
//!
//! Skips for now (P3-19b): `.8ba` modules are not ported yet (`parse_media_module` returns
//! `Unported`), and the record's `result` and `after` carry the token list, an empty bound and
//! the diagnostics array, which need their own encoder.

use front_replay::Replay;
use serde_json::Value;

/// Not replayed yet: the call proves nothing.
#[must_use]
pub fn replay(_record: &Value) -> Replay {
    Replay::Skip
}
