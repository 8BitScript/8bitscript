//! Replays `fixtures/zp.json` (made by `gen/zp.mjs` in Node).

use mos::zp::{Budget, IrGlobal, PlaceZp, ZpHole, allocate, place_zp};
use serde_json::{Value, json};

fn rows() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/zp.json")).expect("fixtures parse")
}

#[test]
fn place_zp_matches_js() {
    let mut n = 0;
    for row in rows().iter().filter(|r| r["fn"] == "placeZp") {
        let a = row["args"].as_array().unwrap();
        let holes: Vec<ZpHole> = a
            .get(3)
            .map_or_else(Vec::new, |h| serde_json::from_value(h.clone()).unwrap());
        let got = match place_zp(
            a[0].as_i64().unwrap(),
            a[1].as_i64().unwrap(),
            a[2].as_i64().unwrap(),
            &holes,
        ) {
            PlaceZp::Placed { address, next } => {
                json!({"ok": true, "address": address, "next": next})
            }
            PlaceZp::Full { remaining, cursor } => {
                json!({"ok": false, "remaining": remaining, "cursor": cursor})
            }
        };
        assert_eq!(got, row["result"], "{}", row["args"]);
        n += 1;
    }
    assert!(n >= 20);
}

#[test]
fn allocate_matches_js() {
    let (mut ok, mut err) = (0, 0);
    for row in rows().iter().filter(|r| r["fn"] == "allocate") {
        let globals: Vec<IrGlobal> = serde_json::from_value(row["args"][0].clone()).unwrap();
        let budget: Budget = serde_json::from_value(row["args"][1].clone()).unwrap();
        let got = match allocate(&globals, &budget) {
            Ok(a) => {
                ok += 1;
                let mut v = serde_json::to_value(a).unwrap();
                v["ok"] = json!(true);
                v
            }
            Err(error) => {
                err += 1;
                json!({"ok": false, "error": error})
            }
        };
        assert_eq!(got, row["result"], "{}", row["args"]);
    }
    assert!(ok > 10 && err > 10, "{ok} {err}");
}

#[test]
fn ir_global_keeps_null_and_absent_init_apart() {
    let g: IrGlobal =
        serde_json::from_str(r#"{"name":"a","type":"u8","address":null,"init":null}"#).unwrap();
    assert!(!g.init.is_absent());
    let g: IrGlobal = serde_json::from_str(r#"{"name":"a","type":"u8","address":null}"#).unwrap();
    assert!(g.init.is_absent());
}
