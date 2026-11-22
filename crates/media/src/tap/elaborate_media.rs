//! Tap replay for `elaborateMedia` (`packages/compiler/src/media/elaborate.mjs`).
//!
//! `args` is `[module, diagnostics, options]` as they were before the call; `result` is the
//! module after it (the JS mutates it: `ir`, `ast`, `tokens`); `after` is
//! `{module, diagnostics, mediaSlots}`. The call reads the media sources and the machine
//! packages from disk, so a record that names a path token replays only when
//! `EIGHTBS_FRONT_TAP_ROOTS` is set.

use front_replay::{Replay, compare};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use super::roots::{missing_root, roots, tokenize, untokenize};
use crate::analyze_media;
use crate::elaborate::{ElaborateOptions, elaborate_media};
use crate::machine::{Facts, MediaSlots};
use diagnostics::Diagnostic;

fn count(v: &Value) -> u32 {
    u32::try_from(v.as_u64().unwrap_or(0)).unwrap_or(u32::MAX)
}

/// `mediaSlots` of an options object; `None` when the key is absent or null.
#[must_use]
pub fn slots_of(v: &Value) -> Option<MediaSlots> {
    if !v.is_object() {
        return None;
    }
    Some(MediaSlots {
        graphics: count(&v["graphics"]),
        audio: count(&v["audio"]),
        audio_bytes: count(&v["audioBytes"]),
        pet_shapes: v.get("petShapes").map(count),
        web_sprite_bytes: v.get("webSpriteBytes").map(count),
    })
}

/// `mediaSlots` as the JS object it mirrors.
#[must_use]
pub fn slots_json(s: Option<&MediaSlots>) -> Value {
    let Some(s) = s else { return Value::Null };
    let mut v = json!({ "graphics": s.graphics, "audio": s.audio, "audioBytes": s.audio_bytes });
    if let Some(p) = s.pet_shapes {
        v["petShapes"] = json!(p);
    }
    if let Some(w) = s.web_sprite_bytes {
        v["webSpriteBytes"] = json!(w);
    }
    v
}

/// The `options` argument of `elaborateMedia`.
#[must_use]
pub fn options_of(v: &Value) -> ElaborateOptions {
    let facts: Facts = v
        .get("facts")
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, x)| (k.clone(), x.clone())).collect())
        .unwrap_or_else(IndexMap::new);
    ElaborateOptions {
        machine: v.get("machine").and_then(Value::as_str).map(str::to_string),
        tags: v.get("tags").and_then(Value::as_array).map(|a| {
            a.iter()
                .filter_map(|t| t.as_str().map(str::to_string))
                .collect()
        }),
        facts,
        checkout: v
            .get("checkout")
            .and_then(Value::as_str)
            .map(str::to_string),
        media_slots: v.get("mediaSlots").and_then(slots_of),
    }
}

/// What the call leaves behind, as JSON: `(result, diagnostics added, slots after)`. A throw is
/// the `Err` message.
///
/// # Errors
/// The message the JS would throw.
pub fn run(
    module: &Value,
    options: &Value,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(Value, Value), String> {
    let file = module["file"].as_str().unwrap_or_default();
    let text = module["text"].as_str().unwrap_or_default();
    let kind = module["media"]["kind"].as_str().unwrap_or_default();
    let analysis = analyze_media(text, file, kind);
    let parsed = crate::MediaModule {
        file: file.to_string(),
        text: text.to_string(),
        tokens: analysis.tokens,
        media: crate::Media {
            kind: kind.to_string(),
            gir: analysis.gir,
            air: analysis.air,
        },
    };
    let mut opts = options_of(options);
    let ir = elaborate_media(&parsed, diagnostics, &mut opts)?;
    let mut result: Map<String, Value> = module.as_object().cloned().unwrap_or_default();
    result.insert(
        "ir".into(),
        serde_json::to_value(&ir).map_err(|e| e.to_string())?,
    );
    result.insert("ast".into(), Value::Null);
    Ok((Value::Object(result), slots_json(opts.media_slots.as_ref())))
}

#[must_use]
pub fn replay(record: &Value) -> Replay {
    let roots = roots();
    if missing_root(record, &roots) {
        return Replay::Skip;
    }
    let Some(args) = record
        .get("args")
        .map(|a| untokenize(a, &roots))
        .and_then(|a| a.as_array().cloned())
    else {
        return Replay::Skip;
    };
    let module = args.first().cloned().unwrap_or(Value::Null);
    let before: Vec<Diagnostic> = args
        .get(1)
        .and_then(|d| serde_json::from_value(d.clone()).ok())
        .unwrap_or_default();
    let options = args.get(2).cloned().unwrap_or(Value::Null);
    let mut diagnostics = before;
    let outcome = run(&module, &options, &mut diagnostics);
    if let Some(thrown) = record.get("throw") {
        return match outcome {
            Err(message) => compare(thrown, &Value::String(message)),
            Ok(_) => Replay::Mismatch("/throw".into(), thrown.clone(), Value::Null),
        };
    }
    let (result, slots) = match outcome {
        Ok(v) => v,
        Err(message) => {
            return Replay::Mismatch("/throw".into(), Value::Null, Value::String(message));
        }
    };
    let result = tokenize(&result, &roots);
    let first = compare(record.get("result").unwrap_or(&Value::Null), &result);
    if !matches!(first, Replay::Match) {
        return first;
    }
    let diag_json = serde_json::to_value(&diagnostics).unwrap_or(Value::Null);
    let mut after = json!({ "module": result, "diagnostics": diag_json });
    if !slots.is_null() {
        after["mediaSlots"] = slots;
    }
    compare(
        record.get("after").unwrap_or(&Value::Null),
        &tokenize(&after, &roots),
    )
}
