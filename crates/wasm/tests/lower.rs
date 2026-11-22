//! Replays `fixtures/wasm-lower.json` (made by `gen/wasm-lower.mjs` in Node).

use mos_ir::{Expr, Stmt};
use serde_json::Value;
use wasm::WasmError;
use wasm::encode::opcode;
use wasm::lower::*;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/wasm-lower.json")).expect("parse")
}

fn bytes(v: &Value) -> Vec<u8> {
    v.as_array()
        .expect("array")
        .iter()
        .map(|b| u8::try_from(b.as_u64().expect("byte")).expect("u8"))
        .collect()
}

fn check(want: &Value, got: Result<Vec<u8>, WasmError>, what: &str) {
    match got {
        Ok(code) => assert_eq!(bytes(want), code, "{what}"),
        Err(error) => {
            assert!(matches!(error, WasmError::Lower(_) | WasmError::Range(_)));
            assert_eq!(want["throw"].as_str(), Some(error.message()), "{what}");
        }
    }
}

#[test]
fn i32_const_matches_js() {
    let rows = fixture()["i32Const"].clone();
    let rows = rows.as_array().expect("rows");
    assert_eq!(rows.len(), 20);
    for row in rows {
        // JSON has no NaN: the gen writes it as `null`.
        let n = row["args"][0].as_f64().unwrap_or(f64::NAN);
        check(&row["result"], i32_const(n), &row.to_string());
    }
}

#[test]
fn mask_to_type_matches_js() {
    let rows = fixture()["maskToType"].clone();
    let rows = rows.as_array().expect("rows");
    assert_eq!(rows.len(), 21);
    let mut thrown = 0;
    for row in rows {
        let code = bytes(&row["args"][0]);
        let ty = row["args"][1].as_str();
        let got = mask_to_type(code, ty);
        thrown += usize::from(got.is_err());
        check(&row["result"], got, &row.to_string());
    }
    // tinyint, smallint, mediumint and their i8/i16/i24 spellings.
    assert_eq!(thrown, 6);
}

#[test]
fn operand_is_signed_matches_js() {
    let fx = fixture();
    let mut n = 0;
    for key in ["operandIsSigned", "operandIsSignedNodes"] {
        for row in fx[key].as_array().expect("rows") {
            let node: Expr = serde_json::from_value(row["node"].clone()).expect("node");
            assert_eq!(
                row["result"].as_bool(),
                Some(operand_is_signed(&node)),
                "{row}"
            );
            n += 1;
        }
    }
    assert_eq!(n, 22 + 4);
}

#[test]
fn binding_matches_js() {
    let fx = fixture();
    let mut ctx = Ctx::default();
    for (key, map) in [("locals", &mut ctx.locals), ("globals", &mut ctx.globals)] {
        for pair in fx["ctx"][key].as_array().expect("pairs") {
            map.insert(
                pair[0].as_str().expect("name").to_string(),
                u32::try_from(pair[1].as_u64().expect("index")).expect("u32"),
            );
        }
    }
    let rows = fx["binding"].as_array().expect("rows");
    assert_eq!(rows.len(), 4);
    for row in rows {
        let got = binding(&ctx, row["name"].as_str().expect("name"));
        let want = &row["result"];
        match got {
            Ok(b) => {
                assert_eq!(want["get"].as_u64(), Some(u64::from(b.get)), "{row}");
                assert_eq!(want["set"].as_u64(), Some(u64::from(b.set)), "{row}");
                assert_eq!(want["index"].as_u64(), Some(u64::from(b.index)), "{row}");
            }
            Err(error) => {
                assert!(matches!(error, WasmError::Lower(_)));
                assert_eq!(want["throw"].as_str(), Some(error.message()), "{row}");
            }
        }
    }
}

#[test]
fn operator_tables_match_js() {
    let fx = fixture();
    for (key, table) in [
        ("unsignedOrdering", &UNSIGNED_ORDERING[..]),
        ("equality", &EQUALITY[..]),
    ] {
        let want = fx["tables"][key].as_array().expect("pairs");
        assert_eq!(want.len(), table.len());
        for (pair, (op, code)) in want.iter().zip(table) {
            assert_eq!(pair[0].as_str(), Some(*op));
            assert_eq!(pair[1].as_u64(), Some(u64::from(*code)));
        }
    }
    assert_eq!(unsigned_ordering("<="), Some(opcode::I32_LE_U));
    assert_eq!(unsigned_ordering("=="), None);
    assert_eq!(equality("!="), Some(opcode::I32_NE));
    assert_eq!(equality("<"), None);
}

#[test]
fn every_expr_kind_has_a_type_reading() {
    let rd = |json: &str| operand_is_signed(&serde_json::from_str::<Expr>(json).expect("expr"));
    assert!(rd(
        r#"{"kind":"memoryRead","address":{"kind":"const","value":1},"type":"tinyint","start":0,"length":1}"#
    ));
    assert!(rd(r#"{"kind":"call","name":"f","args":[],"type":"int"}"#));
    assert!(rd(
        r#"{"kind":"stringByte","string":{"kind":"string","index":0},"index":{"kind":"const","value":0},"type":"smallint"}"#
    ));
    assert!(rd(
        r#"{"kind":"unop","operator":"-","argument":{"kind":"const","value":1},"type":"int"}"#
    ));
    assert!(rd(
        r#"{"kind":"index","array":{"kind":"ref","name":"a"},"index":{"kind":"const","value":0},"elementType":"int","type":"int"}"#
    ));
    assert!(rd(
        r#"{"kind":"cond","test":{"kind":"const","value":1},"consequent":{"kind":"const","value":1},"alternate":{"kind":"const","value":2},"type":"int"}"#
    ));
    assert!(rd(
        r#"{"kind":"portRead","port":{"kind":"const","value":1},"type":"int","start":0,"length":1}"#
    ));
    assert!(rd(
        r#"{"kind":"namespaceCall","namespace":"n","member":"m","args":[],"type":"int"}"#
    ));
    assert!(rd(
        r#"{"kind":"namespaceConst","namespace":"n","member":"m","type":"int","start":0,"length":1}"#
    ));
    assert!(rd(r#"{"kind":"string","index":0,"type":"int"}"#));
    assert!(!rd(r#"{"kind":"record","fields":[],"start":0,"length":0}"#));
}

fn u32_of(v: &Value) -> u32 {
    u32::try_from(v.as_u64().expect("u32")).expect("u32")
}

fn pairs(v: &Value) -> Vec<(String, &Value)> {
    v.as_array()
        .expect("entries")
        .iter()
        .map(|e| (e[0].as_str().expect("name").to_string(), &e[1]))
        .collect()
}

fn options_of(ctx: &Value, row: &Value) -> LowerOptions {
    LowerOptions {
        params: row["params"]
            .as_array()
            .expect("params")
            .iter()
            .map(|p| LowerParam {
                name: p["name"].as_str().expect("name").to_string(),
                ty: p["type"].as_str().expect("type").to_string(),
            })
            .collect(),
        globals: pairs(&ctx["globals"])
            .into_iter()
            .map(|(k, v)| (k, u32_of(v)))
            .collect(),
        functions: pairs(&ctx["functions"])
            .into_iter()
            .map(|(k, v)| {
                (
                    k,
                    FunctionInfo {
                        index: u32_of(&v["index"]),
                        param_count: u32_of(&v["paramCount"]),
                        returns_value: v["returnsValue"].as_bool().expect("bool"),
                    },
                )
            })
            .collect(),
        strings: ctx["strings"]
            .as_array()
            .expect("strings")
            .iter()
            .map(u32_of)
            .collect(),
        arrays: pairs(&ctx["arrays"])
            .into_iter()
            .map(|(k, v)| {
                (
                    k,
                    ArrayInfo {
                        address: u32_of(&v["address"]),
                        element_width: u32_of(&v["elementWidth"]),
                        mutable: v["mutable"].as_bool().expect("bool"),
                    },
                )
            })
            .collect(),
        pinned: pairs(&ctx["pinned"])
            .into_iter()
            .map(|(k, v)| {
                (
                    k,
                    PinnedInfo {
                        address: u32_of(&v["address"]),
                        width: u32_of(&v["width"]),
                    },
                )
            })
            .collect(),
        wait_frame_index: ctx["waitFrameIndex"]
            .as_u64()
            .map(|n| u32_of(&Value::from(n))),
    }
}

/// Replays `fixture()[key]`: same bytes and local count, or the same error. Returns (lowered, refused).
fn replay(key: &str) -> (usize, usize) {
    let fx = fixture();
    let ctxs = fx["corpusCtxs"].as_array().expect("ctxs");
    let rows = fx[key].as_array().expect("rows");
    let (mut ok, mut refused) = (0, 0);
    for row in rows {
        let body: Vec<Stmt> = serde_json::from_value(row["body"].clone()).expect("body");
        let ctx = &ctxs[usize::try_from(row["ctx"].as_u64().expect("ctx")).expect("ctx")];
        let got = lower(&body, options_of(ctx, row)).expect("no range error escapes lower");
        let want = &row["result"];
        match got {
            LowerOutcome::Ok(result) => {
                ok += 1;
                assert_eq!(want["ok"].as_bool(), Some(true), "{row}");
                assert_eq!(bytes(&want["code"]), result.code, "{row}");
                assert_eq!(
                    want["localCount"].as_u64(),
                    Some(u64::from(result.local_count)),
                    "{row}"
                );
            }
            LowerOutcome::Failure(failure) => {
                refused += 1;
                assert_eq!(want["ok"].as_bool(), Some(false), "{row}");
                assert_eq!(
                    want["error"].as_str(),
                    Some(failure.error.as_str()),
                    "{row}"
                );
            }
        }
    }
    assert_eq!(ok + refused, rows.len());
    (ok, refused)
}

/// Every function of every corpus `wasm-input` dump.
#[test]
fn lower_matches_js_on_the_corpus() {
    assert_eq!(replay("corpus"), (548, 0));
}

/// Hand-made bodies for the paths the corpus does not reach.
#[test]
fn lower_matches_js_on_synthetic_bodies() {
    assert_eq!(replay("synthetic"), (136, 112));
}
