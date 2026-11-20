//! Tap replay for `elaborateMedia` (`packages/compiler/src/media/index.mjs`).
//!
//! Skips until the elaborate unit lands (P3-20).

use front_replay::Replay;
use serde_json::Value;

/// Not ported yet: the call proves nothing.
#[must_use]
pub fn replay(_record: &Value) -> Replay {
    Replay::Skip
}
