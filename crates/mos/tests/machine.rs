//! Replays `fixtures/machine.json` (made by `gen/machine.mjs` in Node).

use indexmap::{IndexMap, IndexSet};
use mos::asm::assemble::Directive;
use mos::build::Machine;
use mos::machine::{
    BORROWS_ZERO_PAGE, CPU, RASTER_MACHINES, SizePart, ZP_BUDGET_MACHINES, ZpBudget,
    chrget_zp_holes, clear_ram, collect_call_names, collect_string_indexes, copy_to_ram,
    directive_bytes, find_call_cycle, function_size_entries, output_extension, zp_budgets,
};
use mos_ir::{Function, HardwareBuild, Stmt};
use serde_json::{Value, json};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/machine.json")).expect("fixtures parse")
}

fn machine(name: &Value) -> Machine {
    serde_json::from_value(name.clone()).expect("machine name")
}

fn body(v: &Value) -> Vec<Stmt> {
    serde_json::from_value(v.clone()).expect("body parses")
}

fn directives(v: &Value) -> Vec<Directive> {
    serde_json::from_value(v.clone()).expect("directives parse")
}

fn as_json(ds: &[Directive]) -> Value {
    serde_json::to_value(ds).unwrap()
}

#[test]
fn cpu_table_matches_in_literal_order() {
    let f = fixtures();
    let rows = f["cpu"].as_array().unwrap();
    assert_eq!(rows.len(), CPU.len());
    for (row, (m, v)) in rows.iter().zip(CPU.iter()) {
        assert_eq!(row[0].as_str(), Some(m.as_str()));
        let want = &row[1];
        assert_eq!(want["core"], json!(v.core));
        assert_eq!(want["decimalMode"], json!(v.decimal_mode));
        assert_eq!(want["jmpIndirectPageBug"], json!(v.jmp_indirect_page_bug));
        assert_eq!(want["extraOpcodes"], json!(v.extra_opcodes));
        assert_eq!(want["undocumentedOpcodes"], json!(v.undocumented_opcodes));
        assert_eq!(mos::machine::cpu_of(*m), v);
    }
}

#[test]
fn budgets_and_machine_sets_match() {
    let f = fixtures();
    let rows = f["zpBudgets"].as_array().unwrap();
    assert_eq!(rows.len(), ZP_BUDGET_MACHINES.len());
    for (row, m) in rows.iter().zip(ZP_BUDGET_MACHINES) {
        assert_eq!(row[0].as_str(), Some(m.as_str()), "key order");
        let (polite, owned) = zp_budgets(m).expect("has a budget");
        for (want, got) in [(&row[1]["polite"], polite), (&row[1]["owned"], owned)] {
            assert_eq!(want["zpOrigin"], json!(got.zp_origin), "{m:?}");
            assert_eq!(want["zpCeiling"], json!(got.zp_ceiling), "{m:?}");
            let holes = json!(
                got.holes
                    .iter()
                    .map(|h| json!({"start": h.start, "end": h.end}))
                    .collect::<Vec<_>>()
            );
            assert_eq!(want.get("holes").cloned().unwrap_or(json!([])), holes);
        }
    }
    assert!(f["missingBudget"].as_array().unwrap().is_empty());
    let names = |ms: &[Machine]| json!(ms.iter().map(|m| m.as_str()).collect::<Vec<_>>());
    assert_eq!(f["borrows"], names(&BORROWS_ZERO_PAGE));
    assert_eq!(f["raster"], names(&RASTER_MACHINES));
}

#[test]
fn chrget_holes_match() {
    for c in fixtures()["chrget"].as_array().unwrap() {
        let facts: IndexMap<String, Value> = serde_json::from_value(c["facts"].clone()).unwrap();
        let budget = ZpBudget {
            zp_origin: c["budget"]["zpOrigin"].as_i64().unwrap(),
            zp_ceiling: c["budget"]["zpCeiling"].as_i64().unwrap(),
            holes: Vec::new(),
        };
        let got = chrget_zp_holes(&facts, &budget);
        let got: Vec<Value> = got
            .iter()
            .map(|h| json!({"start": h.start, "end": h.end}))
            .collect();
        assert_eq!(Value::Array(got), c["result"], "{c}");
    }
}

#[test]
fn output_extensions_match() {
    let rows = fixtures()["outputExtension"].as_array().unwrap().clone();
    assert!(rows.len() >= 72);
    for row in rows {
        let hardware: Option<HardwareBuild> = match &row["hardware"] {
            Value::Null => None,
            h => {
                let mut build = h["build"].clone();
                build["defsym"] = json!({});
                Some(serde_json::from_value(build).unwrap())
            }
        };
        let got = output_extension(machine(&row["machine"]), hardware.as_ref());
        assert_eq!(json!(got), row["result"], "{row}");
    }
}

#[test]
fn clear_ram_and_copy_to_ram_match() {
    let f = fixtures();
    let rows = f["clearRam"].as_array().unwrap();
    assert!(rows.len() >= 13);
    for row in rows {
        let got = clear_ram(
            row["origin"].as_i64().unwrap(),
            row["end"].as_i64().unwrap(),
        );
        assert_eq!(as_json(&got), row["result"], "{row}");
    }
    let rows = f["copyToRam"].as_array().unwrap();
    assert!(rows.len() >= 12);
    for row in rows {
        let got = copy_to_ram(
            row["from"].as_str().unwrap(),
            row["to"].as_i64().unwrap(),
            row["size"].as_i64().unwrap(),
            row["tag"].as_str().unwrap(),
        );
        assert_eq!(as_json(&got), row["result"], "{row}");
    }
}

#[test]
fn directive_bytes_and_size_entries_match() {
    let f = fixtures();
    for row in f["directiveBytes"].as_array().unwrap() {
        let program = directives(&row["program"]);
        assert_eq!(json!(directive_bytes(&program)), row["result"]);
    }
    for row in f["functionSizeEntries"].as_array().unwrap() {
        let owned: Vec<(Option<String>, Vec<Directive>)> = row["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["origin"].as_str().map(str::to_string),
                    directives(&p["program"]),
                )
            })
            .collect();
        let parts: Vec<SizePart<'_>> = owned
            .iter()
            .map(|(origin, program)| SizePart {
                origin: origin.as_deref(),
                program,
            })
            .collect();
        let got = function_size_entries(
            row["name"].as_str().unwrap(),
            &parts,
            row["isEntry"].as_bool().unwrap(),
        );
        assert_eq!(serde_json::to_value(&got).unwrap(), row["result"], "{row}");
    }
}

#[test]
fn ir_walks_match() {
    for row in fixtures()["walks"].as_array().unwrap() {
        let b = body(&row["body"]);
        let mut calls = IndexSet::new();
        collect_call_names(&b, &mut calls);
        assert_eq!(json!(calls.iter().collect::<Vec<_>>()), row["calls"]);
        let mut strings = IndexSet::new();
        collect_string_indexes(&b, &mut strings);
        assert_eq!(json!(strings.iter().collect::<Vec<_>>()), row["strings"]);
    }
}

#[test]
fn call_cycles_match() {
    let rows = fixtures()["callCycles"].as_array().unwrap().clone();
    let mut found = 0;
    for row in &rows {
        let fns: Vec<Function> = row["functions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                serde_json::from_value(json!({
                    "name": f["name"], "exported": false, "params": [], "returnType": "void",
                    "body": f["body"], "start": 0, "length": 0, "file": "t.8bs",
                }))
                .expect("function parses")
            })
            .collect();
        let got = find_call_cycle(&fns);
        assert_eq!(json!(got), row["result"], "{row}");
        found += usize::from(got.is_some());
    }
    assert!(found >= 5 && found < rows.len());
}
