//! Tap replay for `checkBx` (`packages/compiler/src/bx/check.mjs:28`).

use front_replay::Replay;
use serde_json::Value;

/// Not ported yet: the call proves nothing.
#[must_use]
pub fn replay(_record: &Value) -> Replay {
    Replay::Skip
}
