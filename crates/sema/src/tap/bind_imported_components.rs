//! Tap replay for `bindImportedComponents` (`packages/compiler/src/binder/index.mjs:248-261`).
//!
//! `args` is `[bound, {lookups: [[source, other], ...]}]`: the bound as it was when the call
//! began, and what `lookup` answered for each source (a `bind()` result, or `null`). `result` is
//! `null`, `after` the bound once linked.

use front_replay::{Replay, compare};
use serde_json::{Value, json};

use super::decode::{World, bound_root};
use super::graph::Encoder;
use crate::binder::{
    bind_imported_components,
    types::{Bound, ModuleId, ScopeId},
};

#[must_use]
pub fn replay(record: &Value) -> Replay {
    replay_with(record, bind_imported_components)
}

/// What a binder function over `bound`, its module and a `lookup` looks like.
pub type Linker = fn(&mut [Bound], ModuleId, &mut dyn FnMut(&str) -> Option<ModuleId>);

/// [`replay`] through `link`, which is `bind_imports` or its older name.
#[must_use]
pub fn replay_with(record: &Value, link: Linker) -> Replay {
    let Some(args) = record.get("args").and_then(Value::as_array) else {
        return Replay::Skip;
    };
    if record.get("throw").is_some() {
        return Replay::Skip;
    }
    let (Some(bound), Some(answers)) = (
        args.first(),
        args.get(1)
            .and_then(|a| a.get("lookups"))
            .and_then(Value::as_array),
    ) else {
        return Replay::Mismatch(
            "/args".into(),
            Value::Null,
            json!("expected [bound, {lookups}]"),
        );
    };
    let answers: Vec<(&str, &Value)> = answers
        .iter()
        .filter_map(|pair| Some((pair.get(0)?.as_str()?, pair.get(1)?)))
        .collect();
    let mut bounds = vec![bound];
    bounds.extend(
        answers
            .iter()
            .map(|(_, other)| *other)
            .filter(|o| !o.is_null()),
    );
    let mut world = match World::new(&[bound, &args[1]], &bounds) {
        Ok(world) => world,
        Err(error) => return Replay::Mismatch("/args".into(), Value::Null, json!(error)),
    };
    if world.modules.is_empty() {
        // A module with no scopes (no `bind()` result behind it) has no imports to link: it
        // comes back as it went in.
        let after = record.get("after").unwrap_or(&Value::Null);
        return match compare(after, bound) {
            Replay::Match => compare(record.get("result").unwrap_or(&Value::Null), &Value::Null),
            other => other,
        };
    }
    // A looked-up module with no scopes is a bare `{symbols, imports}` record: it has no
    // symbols to be a target, so it stands as an empty module after the decoded ones.
    let bare: Vec<&Value> = answers
        .iter()
        .map(|(_, other)| *other)
        .filter(|o| !o.is_null() && bound_root(o).is_none())
        .collect();
    let first_bare = world.modules.len();
    for _ in &bare {
        world.modules.push(Bound {
            scopes: Vec::new(),
            symbol_table: Vec::new(),
            module_scope: ScopeId(0),
            symbols: indexmap::IndexMap::new(),
            imports: Vec::new(),
            scope_of: indexmap::IndexMap::new(),
            file: String::new(),
        });
    }
    let module_of = |other: &Value| match bound_root(other) {
        Some(root) => bound_root_index(&bounds, root),
        None => bare
            .iter()
            .position(|b| std::ptr::eq(*b, other))
            .map(|i| first_bare + i),
    };
    let mut lookup = |source: &str| -> Option<ModuleId> {
        let (_, other) = answers.iter().find(|(s, _)| *s == source)?;
        module_of(other).map(|m| ModuleId(m as u32))
    };
    link(&mut world.modules, ModuleId(0), &mut lookup);
    let diagnostics = bound
        .get("diagnostics")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let got = Encoder::new(&world.modules).bound(0, diagnostics);
    let after = record.get("after").unwrap_or(&Value::Null);
    match compare(after, &got) {
        Replay::Match => compare(record.get("result").unwrap_or(&Value::Null), &Value::Null),
        other => other,
    }
}

/// The module number of the `bind()` result whose root scope is `root`: modules are numbered in
/// the order of the first appearance of their roots in `bounds`.
fn bound_root_index(bounds: &[&Value], root: u64) -> Option<usize> {
    let mut seen: Vec<u64> = Vec::new();
    for r in bounds.iter().filter_map(|b| bound_root(b)) {
        if !seen.contains(&r) {
            seen.push(r);
        }
    }
    seen.iter().position(|r| *r == root)
}
