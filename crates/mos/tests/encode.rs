//! Replays `fixtures/encode.json` (made by `gen/encode.mjs` in Node).

mod common;

use mos::asm::encode::{AddressingMode, OPCODES, encode};
use serde_json::Value;

fn mode(name: &str) -> AddressingMode {
    serde_json::from_value(Value::String(name.to_string())).expect("mode")
}

#[test]
fn every_row_matches_js() {
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/encode.json")).expect("fixtures parse");
    assert_eq!(rows.len(), 772);
    let mut good = 0;
    for row in &rows {
        let args = row["args"].as_array().unwrap();
        let (m, md) = (args[0].as_str().unwrap(), mode(args[1].as_str().unwrap()));
        let got = encode(m, md);
        let want = &row["result"];
        match got {
            Ok(opcode) => {
                good += 1;
                assert_eq!(want["ok"], true, "{m} {md:?}");
                assert_eq!(want["opcode"], opcode, "{m} {md:?}");
                assert_eq!(
                    want["bytes"].as_i64().unwrap(),
                    mos::asm::encode::instruction_bytes(md)
                );
            }
            Err(error) => {
                assert_eq!(want["ok"], false, "{m} {md:?}");
                assert_eq!(want["error"], error.as_str(), "{m} {md:?}");
            }
        }
    }
    assert_eq!(good, 154);
}

#[test]
fn table_has_the_js_shape() {
    assert_eq!(OPCODES.len(), 59);
    assert_eq!(OPCODES.iter().map(|(_, m)| m.len()).sum::<usize>(), 154);
    assert_eq!(OPCODES[0].0, "ADC");
    assert_eq!(OPCODES[58].0, "ST2");
    assert_eq!(common::modes().len(), 13);
}
