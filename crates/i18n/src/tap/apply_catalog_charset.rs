//! Tap replay for `applyCatalogCharset` (`packages/compiler/src/i18n/index.mjs:166`).

use front_replay::Replay;
use serde_json::Value;

/// Not ported yet: the call proves nothing.
#[must_use]
pub fn replay(_record: &Value) -> Replay {
    Replay::Skip
}
