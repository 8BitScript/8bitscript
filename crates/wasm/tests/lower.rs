//! Replays `fixtures/wasm-lower.json` (made by `gen/wasm-lower.mjs` in Node).

use mos_ir::Expr;
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
    assert_eq!(rows.len(), 15);
    for row in rows {
        let n = row["args"][0].as_f64().expect("n");
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
