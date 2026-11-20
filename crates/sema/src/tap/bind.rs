//! Tap replay for `bind` (`packages/compiler/src/binder/index.mjs:88`).

use front_replay::Replay;
use serde_json::Value;

/// Not ported yet: the call proves nothing.
#[must_use]
pub fn replay(_record: &Value) -> Replay {
    Replay::Skip
}
