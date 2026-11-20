//! Tap replay for `findImports` (`packages/compiler/src/resolver/index.mjs:400`).

use crate::imports::ScanToken;
use front_replay::{Replay, compare};
use serde_json::Value;

use crate::imports::find_imports;

/// The token array of a record's first argument; `Err` is the mismatch to report.
pub(super) fn tokens_of(record: &Value) -> Result<Option<Vec<ScanToken>>, Replay> {
    if record.get("throw").is_some() {
        return Ok(None);
    }
    let Some(arg) = record.get("args").and_then(|a| a.get(0)) else {
        return Ok(None);
    };
    match serde_json::from_value::<Vec<ScanToken>>(arg.clone()) {
        Ok(tokens) => Ok(Some(tokens)),
        Err(e) => Err(Replay::Mismatch(
            "/args/0".into(),
            arg.clone(),
            Value::String(e.to_string()),
        )),
    }
}

#[must_use]
pub fn replay(record: &Value) -> Replay {
    let tokens = match tokens_of(record) {
        Ok(Some(tokens)) => tokens,
        Ok(None) => return Replay::Skip,
        Err(mismatch) => return mismatch,
    };
    let rust = serde_json::to_value(find_imports(&tokens)).unwrap_or(Value::Null);
    compare(record.get("result").unwrap_or(&Value::Null), &rust)
}
