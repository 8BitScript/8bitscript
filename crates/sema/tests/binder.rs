//! Replays `fixtures/binder.json` (made by `gen/binder.mjs` in Node). Each row is a record of the
//! front tap: `bind` and `bindImportedComponents` go through the tap replays, `resolveSymbol` and
//! `componentOf` through the decoder of `sema::tap::decode`.

use front_replay::{Replay, compare};
use sema::binder::types::SymbolRef;
use sema::binder::{bind_imports, component_of, resolve_symbol};
use sema::tap::decode::World;
use sema::tap::graph::Encoder;
use sema::tap::{bind, bind_imported_components};
use serde_json::Value;

fn rows() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/binder.json")).unwrap()
}

fn name(row: &Value) -> &str {
    row["name"].as_str().unwrap_or("")
}

fn expect_match(row: &Value, got: Replay) {
    assert_eq!(got, Replay::Match, "{}", name(row));
}

#[test]
fn bind_matches_js() {
    let mut n = 0;
    for row in rows().iter().filter(|r| r["fn"] == "bind") {
        expect_match(row, bind::replay(row));
        n += 1;
    }
    assert!(n >= 40, "{n} bind rows");
}

#[test]
fn bind_imported_components_matches_js() {
    let mut n = 0;
    for row in rows()
        .iter()
        .filter(|r| r["fn"] == "bindImportedComponents")
    {
        expect_match(row, bind_imported_components::replay(row));
        // `bindImports` is the same function under its newer name.
        expect_match(
            row,
            bind_imported_components::replay_with(row, bind_imports),
        );
        n += 1;
    }
    assert!(n >= 10, "{n} bindImportedComponents rows");
}

#[test]
fn resolve_symbol_matches_js() {
    let mut n = 0;
    for row in rows().iter().filter(|r| r["fn"] == "resolveSymbol") {
        let args = row["args"].as_array().unwrap();
        let world = World::new(&[&args[0]], &[]).unwrap();
        let (module, scope) = world.scope_of(&args[0]).unwrap();
        let name_arg = args[1].as_str().unwrap();
        let hit = resolve_symbol(&world.modules[module], scope, name_arg);
        let got = hit.map_or(Value::Null, |id| {
            Encoder::new(&world.modules).symbol(module, id)
        });
        expect_match(row, compare(&row["result"], &got));
        n += 1;
    }
    assert!(n >= 80, "{n} resolveSymbol rows");
}

#[test]
fn component_of_matches_js() {
    let mut n = 0;
    for row in rows().iter().filter(|r| r["fn"] == "componentOf") {
        let args = row["args"].as_array().unwrap();
        let arg = args.first().unwrap_or(&Value::Null);
        let world = World::new(&[arg], &[]).unwrap();
        let sym: Option<SymbolRef> = world.link_of(arg).ok();
        let hit = component_of(&world.modules, sym);
        let got = hit.map_or(Value::Null, |r| {
            Encoder::new(&world.modules).symbol(r.module.0 as usize, r.symbol)
        });
        expect_match(row, compare(&row["result"], &got));
        n += 1;
    }
    assert!(n >= 20, "{n} componentOf rows");
}

#[test]
fn the_fixtures_cover_the_symbol_kinds_and_links() {
    let text = include_str!("fixtures/binder.json");
    for needle in [
        "\"kind\":\"Variable\"",
        "\"kind\":\"Constant\"",
        "\"kind\":\"Function\"",
        "\"kind\":\"Namespace\"",
        "\"kind\":\"Parameter\"",
        "\"kind\":\"Import\"",
        "\"kind\":\"Component\"",
        "\"kind\":\"State\"",
        "\"resolved\":true",
        "\"imported\":\"Menu\"",
    ] {
        assert!(text.contains(needle), "{needle}");
    }
}
