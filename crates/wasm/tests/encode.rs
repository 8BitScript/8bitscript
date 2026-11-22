//! Replays `fixtures/wasm-encode.json` (made by `gen/wasm-encode.mjs` in Node).

use serde_json::Value;
use wasm::WasmError;
use wasm::encode::*;

/// `brIf` to `BR_IF`, `i32Load8U` to `I32_LOAD8_U`.
fn upper_snake(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
        }
        out.push(c.to_ascii_uppercase());
    }
    out
}

fn bytes(v: &Value) -> Vec<u8> {
    v.as_array()
        .expect("array")
        .iter()
        .map(|b| u8::try_from(b.as_u64().expect("byte")).expect("u8"))
        .collect()
}

fn num(v: &Value) -> f64 {
    v.as_f64().expect("number")
}

fn run(row: &Value) -> Result<Vec<u8>, WasmError> {
    let a = row["args"].as_array().expect("args");
    match row["fn"].as_str().expect("fn") {
        "unsignedLEB128" => unsigned_leb128(num(&a[0])),
        "signedLEB128" => signed_leb128(num(&a[0])),
        "limits" => limits(
            num(&a[0]),
            a.get(1).and_then(Value::as_f64),
            a.get(2).and_then(Value::as_bool),
        ),
        "vector" => Ok(vector(
            &a[0]
                .as_array()
                .expect("items")
                .iter()
                .map(bytes)
                .collect::<Vec<_>>(),
        )),
        "encodeName" => Ok(encode_name(a[0].as_str().expect("name"))),
        "memarg" => memarg(num(&a[0]), num(&a[1])),
        "activeDataSegment" => active_data_segment(num(&a[0]), &bytes(&a[1])),
        "funcType" => Ok(func_type(&bytes(&a[0]), &bytes(&a[1]))),
        "importFunc" => import_func(
            a[0].as_str().expect("m"),
            a[1].as_str().expect("f"),
            num(&a[2]),
        ),
        "section" => Ok(section(
            u8::try_from(a[0].as_u64().expect("id")).expect("u8"),
            &bytes(&a[1]),
        )),
        "assembleModule" => Ok(assemble_module(
            &a[0]
                .as_array()
                .expect("sections")
                .iter()
                .map(bytes)
                .collect::<Vec<_>>(),
        )),
        "memoryCopy" => Ok(memory_copy()),
        other => panic!("unknown fn {other}"),
    }
}

#[test]
fn every_row_matches_js() {
    let fx: Value = serde_json::from_str(include_str!("fixtures/wasm-encode.json")).expect("parse");
    let rows = fx["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 50);
    let mut thrown = 0;
    for row in rows {
        let want = &row["result"];
        match run(row) {
            Ok(got) => assert_eq!(bytes(want), got, "{row}"),
            Err(error) => {
                thrown += 1;
                assert!(matches!(error, WasmError::Range(_)));
                assert_eq!(want["throw"].as_str(), Some(error.message()), "{row}");
            }
        }
    }
    assert_eq!(thrown, 5);
}

/// `(NAME, m::NAME)` for each listed constant.
macro_rules! pairs {
    ($m:ident: $($n:ident),* $(,)?) => {
        vec![$((stringify!($n), $m::$n)),*]
    };
}

#[test]
fn constants_match_js() {
    let fx: Value = serde_json::from_str(include_str!("fixtures/wasm-encode.json")).expect("parse");
    let consts = &fx["consts"];
    assert_eq!(bytes(&consts["MODULE_HEADER"]), MODULE_HEADER);
    let tables: Vec<(&str, Vec<(&str, u8)>)> = vec![
        ("ValType", pairs!(val_type: I32, I64, F32, F64)),
        (
            "SectionId",
            pairs!(section_id: TYPE, IMPORT, FUNCTION, TABLE, MEMORY, GLOBAL, EXPORT, START, ELEMENT, CODE, DATA),
        ),
        (
            "ExternalKind",
            pairs!(external_kind: FUNC, TABLE, MEMORY, GLOBAL),
        ),
        ("BlockType", pairs!(block_type: EMPTY, I32)),
        ("Mutability", pairs!(mutability: CONST, VAR)),
        (
            "Opcode",
            pairs!(
                opcode: UNREACHABLE, END, BLOCK, LOOP, IF, ELSE, BR, BR_IF, RETURN, CALL, DROP, LOCAL_GET,
                LOCAL_SET, I32_CONST, I32_EQZ, I32_EQ, I32_NE, I32_LT_S, I32_LT_U, I32_GT_S, I32_GT_U,
                I32_LE_S, I32_LE_U, I32_GE_S, I32_GE_U, I32_ADD, I32_SUB, I32_MUL, I32_DIV_U, I32_REM_U,
                I32_AND, I32_OR, I32_XOR, I32_SHL, I32_SHR_U, I32_LOAD8_U, I32_LOAD16_U, I32_STORE8,
                I32_STORE16, SELECT, GLOBAL_GET, GLOBAL_SET
            ),
        ),
    ];
    for (name, mut rust) in tables {
        let js = consts[name].as_object().expect("table");
        let mut want: Vec<(String, u8)> = js
            .iter()
            .map(|(k, v)| {
                (
                    upper_snake(k),
                    u8::try_from(v.as_u64().expect("n")).expect("u8"),
                )
            })
            .collect();
        want.sort();
        rust.sort_unstable();
        let rust: Vec<(String, u8)> = rust.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        assert_eq!(want, rust, "{name}");
    }
}
