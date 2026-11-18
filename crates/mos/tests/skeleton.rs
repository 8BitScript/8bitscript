//! Replays `fixtures/skeleton.json` (made by `gen/skeleton.mjs` in Node).

use mos::asm::assemble::{Directive, Half, Operand};
use mos::asm::encode::{AddressingMode, instruction_bytes, operand_bytes};
use mos::build::{Counters, Machine};
use mos::provenance::NO_PROVENANCE;
use mos::types::{resolve_integer_type, storage_bytes};
use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/skeleton.json")).expect("fixtures parse")
}

#[test]
fn directives_round_trip_against_js_json() {
    let f = fixtures();
    let rows = f["directives"].as_array().unwrap();
    assert!(!rows.is_empty());
    let (mut kinds, mut operands) = (Vec::new(), Vec::new());
    for row in rows {
        let text = row.as_str().unwrap();
        let d: Directive = serde_json::from_str(text).expect("parses");
        // Same JSON value after a Rust round trip, and the same key order.
        assert_eq!(serde_json::to_string(&d).unwrap(), text);
        match &d {
            Directive::Label { .. } => kinds.push("label"),
            Directive::Instruction { operand, .. } => {
                kinds.push("instruction");
                match operand {
                    Some(Operand::Value { .. }) => operands.push("value"),
                    Some(Operand::Label { .. }) => operands.push("label"),
                    None => {}
                }
            }
            Directive::Byte { .. } => kinds.push("byte"),
            Directive::Equate { .. } => kinds.push("equate"),
        }
    }
    for k in ["label", "instruction", "byte", "equate"] {
        assert!(kinds.contains(&k), "{k}");
    }
    assert!(operands.contains(&"value") && operands.contains(&"label"));
}

#[test]
fn label_operand_parts() {
    let d: Directive = serde_json::from_str(
        r#"{"kind":"instruction","mnemonic":"LDA","mode":"absolute,x","operand":{"kind":"label","name":"t","byte":"hi","offset":250}}"#,
    )
    .unwrap();
    let Directive::Instruction {
        operand: Some(Operand::Label { byte, offset, .. }),
        mode,
        ..
    } = d
    else {
        panic!("shape");
    };
    assert_eq!(
        (byte, offset, mode),
        (Some(Half::Hi), Some(250), AddressingMode::AbsoluteX)
    );
}

#[test]
fn mode_byte_counts_and_names() {
    for row in fixtures()["modes"].as_array().unwrap() {
        let name = row[0].as_str().unwrap();
        let mode: AddressingMode = serde_json::from_value(Value::String(name.into())).unwrap();
        assert_eq!(mode.as_str(), name);
        assert_eq!(operand_bytes(mode), row[1].as_i64().unwrap(), "{name}");
        assert_eq!(instruction_bytes(mode), row[2].as_i64().unwrap(), "{name}");
    }
}

#[test]
fn integer_types() {
    for row in fixtures()["types"].as_array().unwrap() {
        let name = row[0].as_str().unwrap();
        match (resolve_integer_type(name), row[1].as_array()) {
            (None, None) => {}
            (Some(t), Some(want)) => {
                assert_eq!(t.canonical_name, want[0].as_str().unwrap());
                assert_eq!(t.signed, want[1].as_bool().unwrap());
                assert_eq!(t.bits, want[2].as_i64().unwrap());
                assert_eq!(t.bytes, want[3].as_i64().unwrap());
                assert_eq!(t.min, want[4].as_i64().unwrap());
                assert_eq!(t.max, want[5].as_i64().unwrap());
            }
            other => panic!("{name}: {other:?}"),
        }
        assert_eq!(
            storage_bytes(Some(name)),
            row[2].as_i64().unwrap(),
            "{name}"
        );
    }
    assert_eq!(storage_bytes(None), 0);
}

#[test]
fn small_pieces() {
    assert_eq!(mos::unported("lower"), "unported: lower");
    assert_eq!(Machine::Atari7800.as_str(), "atari7800");
    let m: Machine = serde_json::from_str("\"c64\"").unwrap();
    assert_eq!(m, Machine::C64);
    assert_eq!(Counters::default(), Counters { lower: 0, relax: 0 });
    assert!(NO_PROVENANCE.source.is_none());
}
