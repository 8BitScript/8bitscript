//! Parity with the JS diagnostics table and `source/index.mjs`, from the
//! Node-made `fixtures.json` (`make-fixtures.mjs`).

use diagnostics::{
    CPU_FAMILY, Diagnostic, MACHINES, SOURCE_EXTENSIONS, cpu_family, is_locale_name,
    is_source_file, position_at, source_kind_of, strip_source_extension,
};
use oracle::canonical_json;
use serde_json::Value;

fn fixtures() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixtures.json")).expect("json")
}

fn s(v: &Value) -> &str {
    v.as_str().expect("string")
}

#[test]
fn every_code_name_and_value_matches_js() {
    let f = fixtures();
    let js = f["codes"].as_array().expect("codes");
    assert_eq!(js.len(), diagnostics::codes::ALL.len());
    for (row, (name, value)) in js.iter().zip(diagnostics::codes::ALL) {
        assert_eq!((s(&row[0]), s(&row[1])), (*name, *value));
    }
}

#[test]
fn code_values_are_unique_and_shaped() {
    let mut seen = std::collections::HashSet::new();
    for (name, value) in diagnostics::codes::ALL {
        assert!(seen.insert(*value), "{name} repeats {value}");
        assert!(value.starts_with("8BS") && value.len() == 7, "{name}");
    }
}

#[test]
fn diagnostic_records_round_trip_through_the_dump_writer() {
    let f = fixtures();
    for d in f["diagnostics"].as_array().expect("diagnostics") {
        let parsed: Diagnostic = serde_json::from_value(d.clone()).expect("diagnostic");
        let rebuilt = diagnostics::diagnostic(
            &parsed.code,
            parsed.message.clone(),
            &parsed.file,
            parsed.start,
            parsed.length,
            parsed.severity,
        );
        assert_eq!(rebuilt, parsed);
        let back = serde_json::to_value(&rebuilt).expect("value");
        assert_eq!(canonical_json(&back), canonical_json(d));
    }
}

#[test]
fn position_at_matches_js() {
    let f = fixtures();
    let rows = f["positions"].as_array().expect("positions");
    assert!(rows.len() > 40);
    for row in rows {
        let offset = u32::try_from(row["offset"].as_u64().expect("offset")).expect("u32");
        let got = position_at(s(&row["text"]), offset);
        assert_eq!(
            u64::from(got.line),
            row["line"].as_u64().expect("line"),
            "{row}"
        );
        assert_eq!(
            u64::from(got.column),
            row["column"].as_u64().expect("column"),
            "{row}"
        );
    }
}

#[test]
fn source_kind_table_matches_js() {
    let f = fixtures();
    let js: Vec<&str> = f["sourceExtensions"]
        .as_array()
        .expect("ext")
        .iter()
        .map(s)
        .collect();
    assert_eq!(SOURCE_EXTENSIONS, js.as_slice());
    for row in f["sourceKinds"].as_array().expect("rows") {
        let path = s(&row["path"]);
        let kind = source_kind_of(path).map(|k| k.as_str());
        assert_eq!(kind, row["kind"].as_str(), "{path}");
        assert_eq!(
            is_source_file(path),
            row["isSource"].as_bool().expect("bool"),
            "{path}"
        );
        assert_eq!(strip_source_extension(path), s(&row["stripped"]), "{path}");
    }
}

#[test]
fn machines_and_cpu_families_match_js() {
    let f = fixtures();
    let machines: Vec<&str> = f["machines"].as_array().expect("m").iter().map(s).collect();
    assert_eq!(MACHINES, machines.as_slice());
    let table: Vec<(&str, &str)> = f["cpuFamily"]
        .as_array()
        .expect("t")
        .iter()
        .map(|r| (s(&r[0]), s(&r[1])))
        .collect();
    let mut got: Vec<(&str, &str)> = CPU_FAMILY.to_vec();
    let mut want = table;
    got.sort_unstable();
    want.sort_unstable();
    assert_eq!(got, want);
    for row in f["cpuFamilyLookups"].as_array().expect("l") {
        assert_eq!(cpu_family(s(&row[0])), s(&row[1]), "{row}");
    }
}

#[test]
fn locale_names_match_js() {
    let f = fixtures();
    for row in f["localeNames"].as_array().expect("rows") {
        let name = s(&row["name"]);
        assert_eq!(
            is_locale_name(name),
            row["isLocale"].as_bool().expect("bool"),
            "{name:?}"
        );
    }
}
