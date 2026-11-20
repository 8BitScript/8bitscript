//! Replays `fixtures/png.json` (made by `gen/png.mjs` in Node).

use media_tools::png::{bitmask, brightness, decode_png, quantize, slice_frames};
use serde_json::Value;

fn bytes(v: &Value) -> Vec<u8> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_u64().unwrap() as u8)
        .collect()
}
fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn n(v: &Value) -> usize {
    v.as_u64().unwrap() as usize
}

#[test]
fn png_fixtures_match_js() {
    let rows: Vec<Value> = serde_json::from_str(include_str!("fixtures/png.json")).unwrap();
    let (mut decoded, mut errors, mut other) = (0, 0, 0);
    for row in &rows {
        let a = row["args"].as_array().unwrap();
        let name = row["name"].as_str().unwrap_or("");
        match row["fn"].as_str().unwrap() {
            "decodePng" => {
                let got = decode_png(&unhex(a[0].as_str().unwrap()));
                if let Some(msg) = row.get("error") {
                    assert_eq!(got.unwrap_err(), msg.as_str().unwrap(), "{name}");
                    errors += 1;
                } else {
                    let got = got.unwrap_or_else(|e| panic!("{name}: {e}"));
                    let want = &row["result"];
                    assert_eq!(got.width as u64, want["width"].as_u64().unwrap(), "{name}");
                    assert_eq!(
                        got.height as u64,
                        want["height"].as_u64().unwrap(),
                        "{name}"
                    );
                    assert_eq!(got.rgba, bytes(&want["rgba"]), "{name}");
                    decoded += 1;
                }
            }
            "sliceFrames" => {
                let got = slice_frames(&bytes(&a[0]), n(&a[1]), n(&a[2]), n(&a[3]), n(&a[4]));
                let want: Vec<Vec<u8>> = row["result"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(bytes)
                    .collect();
                assert_eq!(got, want);
                other += 1;
            }
            "quantize" => {
                let got = quantize(&bytes(&a[0]), n(&a[1]));
                let want = &row["result"];
                assert_eq!(got.indices, bytes(&want["indices"]));
                let pal: Vec<Vec<u8>> = want["palette"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(bytes)
                    .collect();
                assert_eq!(
                    got.palette.iter().map(|p| p.to_vec()).collect::<Vec<_>>(),
                    pal
                );
                assert_eq!(got.colors, n(&want["colors"]));
                other += 1;
            }
            "brightness" => {
                assert_eq!(
                    brightness(&bytes(&a[0])) as u64,
                    row["result"].as_u64().unwrap()
                );
                other += 1;
            }
            "bitmask" => {
                let got = bitmask(&bytes(&a[0]), n(&a[1]), n(&a[2]), n(&a[3]), n(&a[4]));
                let want: Vec<i32> = row["result"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_i64().unwrap() as i32)
                    .collect();
                assert_eq!(got, want, "bitmask {a:?}");
                other += 1;
            }
            f => panic!("unknown fn {f}"),
        }
    }
    assert!(
        decoded >= 25 && errors >= 20 && other >= 30,
        "{decoded} {errors} {other}"
    );
}
