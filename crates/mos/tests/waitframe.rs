//! Replays `fixtures/waitframe.json` (made by `gen/waitframe.mjs` in Node).

use mos::build::Machine;
use mos::startup::waitframe::{
    WAIT_FRAME_LABEL, WAIT_FRAME_ZP_BYTES, frame_edge_wait, wait_frame_keeps_interrupts,
    wait_frame_routine, wait_frame_setup,
};
use serde_json::Value;

fn machine(name: &str) -> Machine {
    serde_json::from_value(Value::String(name.to_string())).expect("machine name")
}

fn json(d: &[mos::asm::assemble::Directive]) -> String {
    serde_json::to_string(d).unwrap()
}

#[test]
fn wait_frame_matches_js_over_every_row() {
    let f: Value = serde_json::from_str(include_str!("fixtures/waitframe.json")).unwrap();
    assert_eq!(f["label"].as_str().unwrap(), WAIT_FRAME_LABEL);
    assert_eq!(f["zpBytes"].as_i64().unwrap(), WAIT_FRAME_ZP_BYTES);
    let rows = f["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 792);
    for r in rows {
        let m = machine(r["machine"].as_str().unwrap());
        let (acc, num) = (r["acc"].as_i64().unwrap(), r["num"].as_i64().unwrap());
        let rate = r["rate"].as_f64().unwrap();
        let hook = r["hook"].as_str();
        let want_setup = f["setups"][r["setup"].as_str().unwrap()].as_str().unwrap();
        let want_routine = f["routines"][r["routine"].as_str().unwrap()]
            .as_str()
            .unwrap();
        assert_eq!(
            json(&wait_frame_setup(rate, acc, num, m)),
            want_setup,
            "setup {r}"
        );
        assert_eq!(
            json(&wait_frame_routine(acc, num, m, hook)),
            want_routine,
            "routine {r}"
        );
    }
}

#[test]
fn edge_wait_and_interrupt_flags_match_js() {
    let f: Value = serde_json::from_str(include_str!("fixtures/waitframe.json")).unwrap();
    let edges = f["edges"].as_array().unwrap();
    assert_eq!(edges.len(), 18);
    for e in edges {
        let m = machine(e["machine"].as_str().unwrap());
        assert_eq!(
            wait_frame_keeps_interrupts(m),
            e["keeps"].as_bool().unwrap()
        );
        let got = frame_edge_wait(m, "tagx").map(|d| json(&d));
        assert_eq!(got.as_deref(), e["edge"].as_str(), "{e}");
    }
}
