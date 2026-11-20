//! Replays `fixtures/chr_nes.json` and `fixtures/image_nes.json` (made by
//! `gen/chr-nes.mjs` and `gen/image-nes.mjs` in Node).

use mos::build::Machine;
use mos::chr_nes::{NativeSource, assemble_chr_rom};
use mos::image::{ChrPatch, ImageExtras, image_for};
use serde_json::Value;
use std::path::PathBuf;

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

fn repo_file(rel: &str) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    std::fs::read_to_string(root.join(rel)).expect("repo file")
}

fn sources(v: &Value) -> Vec<NativeSource> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| NativeSource {
            path: s["path"].as_str().unwrap_or("native.s").to_string(),
            text: match s["file"].as_str() {
                Some(f) => repo_file(f),
                None => s["text"].as_str().unwrap().to_string(),
            },
        })
        .collect()
}

#[test]
fn assemble_chr_rom_matches_js() {
    let rows: Vec<Value> = serde_json::from_str(include_str!("fixtures/chr_nes.json")).unwrap();
    assert_eq!(rows.len(), 54);
    let (mut ok, mut err, mut threw) = (0, 0, 0);
    for row in &rows {
        let name = row["name"].as_str().unwrap();
        let got = assemble_chr_rom(&sources(&row["sources"]), row["size"].as_i64().unwrap());
        let want = &row["result"];
        if want["threw"].is_string() {
            assert!(got.is_err(), "{name}: JS threw, Rust returned Ok");
            threw += 1;
        } else if want["ok"] == true {
            let chr = got.unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(chr.bytes, unhex(want["bytes"].as_str().unwrap()), "{name}");
            assert_eq!(
                chr.defined as u64,
                want["defined"].as_u64().unwrap(),
                "{name}"
            );
            ok += 1;
        } else {
            assert_eq!(got.unwrap_err(), want["error"].as_str().unwrap(), "{name}");
            err += 1;
        }
    }
    assert!(ok > 30 && err > 10 && threw >= 1, "{ok} {err} {threw}");
}

#[test]
fn nes_file_matches_js() {
    let rows: Vec<Value> = serde_json::from_str(include_str!("fixtures/image_nes.json")).unwrap();
    assert_eq!(rows.len(), 25);
    let image = image_for(Machine::Nes).unwrap();
    let (mut ok, mut err, mut threw) = (0, 0, 0);
    for row in &rows {
        let name = row["name"].as_str().unwrap();
        let extras = ImageExtras {
            native_sources: sources(&row["sources"]),
            chr_patches: row["chrPatches"].as_array().map(|a| {
                a.iter()
                    .map(|p| ChrPatch {
                        tile: p["tile"].as_i64().unwrap(),
                        // JS stores through ToUint8, so 1.5 and 256 reach the port as numbers.
                        bytes: p["bytes"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|b| b.as_f64().unwrap() as i64)
                            .collect(),
                    })
                    .collect()
            }),
        };
        let body = unhex(row["body"].as_str().unwrap());
        let got = image.file(
            row["load"].as_i64().unwrap(),
            &body,
            row["codeStart"].as_i64().unwrap(),
            &extras,
        );
        let want = &row["result"];
        if want["threw"].is_string() {
            assert!(got.is_err(), "{name}: JS threw, Rust returned Ok");
            threw += 1;
        } else if want["ok"] == true {
            let out = got.unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(out.len() as u64, want["len"].as_u64().unwrap(), "{name}");
            assert_eq!(fnv(&out), want["fnv"].as_u64().unwrap(), "{name}");
            assert_eq!(
                out[..16],
                unhex(want["head"].as_str().unwrap())[..],
                "{name}"
            );
            assert_eq!(
                out[16 + 32768 - 16..16 + 32768],
                unhex(want["prgTail"].as_str().unwrap())[..],
                "{name}"
            );
            assert_eq!(
                out[16 + 32768..][..64],
                unhex(want["chrHead"].as_str().unwrap())[..],
                "{name}"
            );
            assert_eq!(
                out[out.len() - 64..],
                unhex(want["chrTail"].as_str().unwrap())[..],
                "{name}"
            );
            ok += 1;
        } else {
            assert_eq!(got.unwrap_err(), want["error"].as_str().unwrap(), "{name}");
            err += 1;
        }
    }
    assert!(ok > 10 && err > 5, "{ok} {err} {threw}");
}
