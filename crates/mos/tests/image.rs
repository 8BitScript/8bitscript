//! Replays `fixtures/image.json` (made by `gen/image.mjs` in Node).

use indexmap::IndexSet;
use mos::asm::assemble::Directive;
use mos::basic_stub::basic_stub;
use mos::build::Machine;
use mos::data::{DataArrayGlobal, IrString, build_data_section};
use mos::image::{ImageExtras, image_for};
use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/image.json")).expect("fixtures parse")
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn fnv(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .fold(0x811c_9dc5u32, |h, &b| {
            (h ^ u32::from(b)).wrapping_mul(0x0100_0193)
        })
        .into()
}

#[test]
fn prelude_and_file_match_js_for_every_machine() {
    let f = fixtures();
    let rows = f["images"].as_array().unwrap();
    assert_eq!(rows.len(), 18);
    let mut files = 0;
    for row in rows {
        let name = row["machine"].as_str().unwrap();
        let machine: Machine = serde_json::from_value(Value::String(name.into())).unwrap();
        assert_eq!(machine.as_str(), name);
        let image = image_for(machine).unwrap();
        let load = row["load"].as_i64().unwrap();
        assert_eq!(image.entry_is_vectored, row["entryIsVectored"], "{name}");
        assert_eq!(
            image.writable_image,
            row["writableImage"].as_bool(),
            "{name}"
        );
        assert_eq!(
            image.ends_by_halting,
            row["endsByHalting"].as_bool(),
            "{name}"
        );
        let prelude = image.prelude(load).unwrap();
        assert_eq!(
            prelude.bytes,
            unhex(row["prelude"]["bytes"].as_str().unwrap())
        );
        assert_eq!(
            prelude.code_start,
            row["prelude"]["codeStart"].as_i64().unwrap()
        );
        for file in row["files"].as_array().unwrap() {
            let body = unhex(file["body"].as_str().unwrap());
            let out = image
                .file(load, &body, prelude.code_start, &ImageExtras::default())
                .unwrap();
            assert_eq!(
                out.len() as u64,
                file["fileLen"].as_u64().unwrap(),
                "{name}"
            );
            assert_eq!(fnv(&out), file["fileFnv"].as_u64().unwrap(), "{name}");
            assert_eq!(
                out[..16.min(out.len())],
                unhex(file["fileHead"].as_str().unwrap())[..],
                "{name}"
            );
            assert_eq!(
                out[out.len().saturating_sub(16)..],
                unhex(file["fileTail"].as_str().unwrap())[..],
                "{name}"
            );
            files += 1;
        }
    }
    assert_eq!(files, 17 * 3);
}

#[test]
fn basic_stub_matches_js() {
    let f = fixtures();
    for row in f["stubs"].as_array().unwrap() {
        let s = basic_stub(row["load"].as_i64().unwrap()).unwrap();
        assert_eq!(s.bytes, unhex(row["bytes"].as_str().unwrap()));
        assert_eq!(s.code_start, row["codeStart"].as_i64().unwrap());
    }
}

#[test]
fn data_section_matches_js_json() {
    let f = fixtures();
    for case in f["dataCases"].as_array().unwrap() {
        let strings: Vec<IrString> = serde_json::from_value(case["strings"].clone()).unwrap();
        let arrays: Vec<DataArrayGlobal> = serde_json::from_value(case["arrays"].clone()).unwrap();
        let used: Option<IndexSet<i64>> = case["usedIndexes"]
            .as_array()
            .map(|a| a.iter().map(|v| v.as_i64().unwrap()).collect());
        let out = build_data_section(&strings, &arrays, used.as_ref());
        let want: Vec<Directive> = serde_json::from_value(case["result"].clone()).unwrap();
        assert_eq!(out, want);
        assert_eq!(
            serde_json::to_value(&out).unwrap(),
            case["result"],
            "JSON shape and key order"
        );
    }
}
