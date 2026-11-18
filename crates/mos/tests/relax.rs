//! Replays `fixtures/relax.json` (made by `gen/relax.mjs` in Node).

mod common;

use common::{assembled_json, program};
use mos::asm::assemble::Directive;
use mos::asm::relax::assemble_relaxed;
use mos::build::Counters;
use mos::provenance::{Generated, Provenance, SourceSpan};
use serde_json::Value;

#[test]
fn every_row_matches_js() {
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/relax.json")).expect("fixtures parse");
    assert!(rows.len() >= 15);
    for row in &rows {
        let args = row["args"].as_array().unwrap();
        let mut c = Counters::default();
        let got = assemble_relaxed(&program(&args[0]), args[1].as_i64().unwrap(), &mut c);
        assert_eq!(assembled_json(&got), row["result"], "{}", row["name"]);
    }
}

#[test]
fn relaxed_pieces_carry_provenance_with_a_reason() {
    let prov = Provenance {
        source: Some(SourceSpan {
            file: "a.8bs".into(),
            start: 1,
            length: 2,
        }),
        function: Some("main".into()),
        origin: None,
        component: None,
        instance: None,
        generated: None,
    };
    let mut p: Vec<Directive> = serde_json::from_str(
        r#"[{"kind":"instruction","mnemonic":"BNE","mode":"relative","operand":{"kind":"label","name":"e"}}]"#,
    )
    .unwrap();
    if let Directive::Instruction { prov: slot, .. } = &mut p[0] {
        *slot = Some(prov.clone());
    }
    p.push(Directive::Byte {
        values: vec![0xea; 200],
        prov: None,
    });
    p.push(Directive::Label {
        name: "e".into(),
        prov: None,
    });
    let mut c = Counters::default();
    let done = assemble_relaxed(&p, 0x0801, &mut c).unwrap();
    assert_eq!(c.relax, 1);
    let with_reason = Provenance {
        generated: Some(Generated {
            reason: "branch-relaxation".into(),
        }),
        ..prov.clone()
    };
    // Inverted branch, JMP, and the skip label's line is not listed; both listed pieces carry the reason.
    assert_eq!(done.listing[0].prov.as_ref(), Some(&with_reason));
    assert_eq!(done.listing[1].prov.as_ref(), Some(&with_reason));
}

#[test]
fn counter_continues_across_calls() {
    let p: Vec<Directive> = serde_json::from_str(
        r#"[{"kind":"instruction","mnemonic":"BNE","mode":"relative","operand":{"kind":"label","name":"e"}},{"kind":"byte","values":[]},{"kind":"label","name":"e"}]"#,
    )
    .unwrap();
    let mut c = Counters { lower: 7, relax: 5 };
    assemble_relaxed(&p, 0x0801, &mut c).unwrap();
    assert_eq!(c, Counters { lower: 7, relax: 5 });
}
