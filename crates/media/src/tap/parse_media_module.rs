//! Tap replay for `parseMediaModule` (`packages/compiler/src/media/index.mjs`).
//!
//! The call reads nothing from disk, so a record replays whether or not the path roots are known:
//! a path token in `file` or in a diagnostic comes back unchanged.
//!
//! `args` is `[file, text, diagnostics, sourceKind]` as they were before the call. `result` is
//! the module `{file, text, tokens, ast: null, bound, media}`, with `bound` an empty
//! `{symbols, diagnostics, imports}`. `after` is the diagnostics array the call appended to.

use front_replay::{Replay, compare};
use serde_json::{Value, json};

use crate::{MediaModule, parse_media_module};
use diagnostics::Diagnostic;
use resolver::tap::roots::{roots, tokenize, untokenize};

/// The module as the JS builds it: the port's fields plus `ast: null` and an empty `bound`.
#[must_use]
pub fn module_json(module: &MediaModule) -> Value {
    let mut v = serde_json::to_value(module).unwrap_or(Value::Null);
    v["ast"] = Value::Null;
    v["bound"] = json!({ "symbols": [], "diagnostics": [], "imports": [] });
    v
}

/// What the call returns and leaves in the diagnostics array, as JSON.
#[must_use]
pub fn run(
    file: &str,
    text: &str,
    source_kind: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> (Value, Value) {
    let module = parse_media_module(file, text, diagnostics, source_kind);
    (
        module_json(&module),
        serde_json::to_value(&*diagnostics).unwrap_or(Value::Null),
    )
}

#[must_use]
pub fn replay(record: &Value) -> Replay {
    let roots = roots();
    let Some(args) = record
        .get("args")
        .map(|a| untokenize(a, &roots))
        .and_then(|a| a.as_array().cloned())
    else {
        return Replay::Skip;
    };
    let text_of = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or_default();
    let mut diagnostics: Vec<Diagnostic> = args
        .get(2)
        .and_then(|d| serde_json::from_value(d.clone()).ok())
        .unwrap_or_default();
    let (result, after) = run(text_of(0), text_of(1), text_of(3), &mut diagnostics);
    let first = compare(
        record.get("result").unwrap_or(&Value::Null),
        &tokenize(&result, &roots),
    );
    if !matches!(first, Replay::Match) {
        return first;
    }
    compare(
        record.get("after").unwrap_or(&Value::Null),
        &tokenize(&after, &roots),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(file: &str, text: &str, kind: &str) -> Value {
        let mut before = Vec::new();
        let (result, after) = run(file, text, kind, &mut before);
        json!({
            "fn": "parseMediaModule",
            "args": [file, text, [], kind],
            "result": result,
            "after": after,
        })
    }

    #[test]
    fn a_graphics_record_replays() {
        let r = record("a.8bg", "sprite hero {}\n", ".8bg");
        assert_eq!(replay(&r), Replay::Match);
    }

    #[test]
    fn an_audio_record_with_diagnostics_replays() {
        let r = record("a.8ba", "@ \"open", ".8ba");
        assert!(!r["after"].as_array().unwrap().is_empty());
        assert_eq!(replay(&r), Replay::Match);
    }

    #[test]
    fn the_module_carries_ast_null_and_an_empty_bound() {
        let r = record("a.8bg", "", ".8bg");
        assert_eq!(r["result"]["ast"], Value::Null);
        assert_eq!(
            r["result"]["bound"],
            json!({ "symbols": [], "diagnostics": [], "imports": [] })
        );
    }

    #[test]
    fn a_wrong_diagnostic_is_a_mismatch() {
        let mut r = record("a.8bg", "@", ".8bg");
        r["after"] = json!([]);
        assert!(matches!(replay(&r), Replay::Mismatch(..)));
    }

    #[test]
    fn a_wrong_token_is_a_mismatch() {
        let mut r = record("a.8bg", "sprite", ".8bg");
        r["result"]["tokens"][0]["length"] = json!(99);
        assert!(matches!(replay(&r), Replay::Mismatch(..)));
    }
}
