//! Tap replay for `pathFormSpecifiers` (`packages/compiler/src/resolver/index.mjs:384`).

use front_replay::{Replay, compare};
use serde_json::Value;

use super::find_imports::tokens_of;
use crate::imports::path_form_specifiers;

#[must_use]
pub fn replay(record: &Value) -> Replay {
    let tokens = match tokens_of(record) {
        Ok(Some(tokens)) => tokens,
        Ok(None) => return Replay::Skip,
        Err(mismatch) => return mismatch,
    };
    let rust = serde_json::to_value(
        path_form_specifiers(&tokens)
            .into_iter()
            .collect::<Vec<_>>(),
    )
    .unwrap_or(Value::Null);
    compare(record.get("result").unwrap_or(&Value::Null), &rust)
}
