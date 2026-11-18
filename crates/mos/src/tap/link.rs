//! Tap replay for `link`, filled in by the unit that ports it.

use serde_json::Value;

use super::Replay;
use crate::build::Counters;

/// Replays one `link` record. The unit that ports it replaces this body.
#[must_use]
pub fn replay(_record: &Value, _counters: &mut Counters) -> Replay {
    Replay::Skip
}
