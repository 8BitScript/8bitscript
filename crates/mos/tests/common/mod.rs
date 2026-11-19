//! Shared by the PR-A replay tests.
#![allow(dead_code)]

use mos::asm::assemble::{Assembled, Directive};
use mos::asm::encode::AddressingMode;
use serde_json::{Value, json};

/// The JSON shape `gen/util.mjs` `encodeAssembled` writes (listing without `prov`).
pub fn assembled_json(r: &Result<Assembled, String>) -> Value {
    match r {
        Err(error) => json!({ "ok": false, "error": error }),
        Ok(a) => json!({
            "ok": true,
            "bytes": a.bytes,
            "listing": a.listing.iter().map(|l| json!({
                "address": l.address, "bytes": l.bytes, "text": l.text,
            })).collect::<Vec<_>>(),
            "labels": a.labels.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
        }),
    }
}

pub fn program(v: &Value) -> Vec<Directive> {
    serde_json::from_value(v.clone()).expect("directives parse")
}

pub fn modes() -> Vec<AddressingMode> {
    use AddressingMode::*;
    vec![
        Implied,
        Accumulator,
        Immediate,
        Zeropage,
        ZeropageX,
        ZeropageY,
        Absolute,
        AbsoluteX,
        AbsoluteY,
        Indirect,
        IndirectX,
        IndirectY,
        Relative,
    ]
}
