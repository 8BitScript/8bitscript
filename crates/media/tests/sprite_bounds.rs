//! Replays `fixtures/media-bounds.json` (made by `gen/media-bounds.mjs`).

use media::elaborate::sprite_bounds;
use media::machine::Frame;
use serde_json::Value;

fn frame_of(v: &Value) -> Frame {
    let hex = v["rgba"].as_str().expect("rgba hex");
    let rgba = (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("hex byte"))
        .collect();
    Frame {
        width: u32::try_from(v["width"].as_u64().expect("width")).expect("width fits"),
        height: u32::try_from(v["height"].as_u64().expect("height")).expect("height fits"),
        rgba,
    }
}

#[test]
fn every_row_matches_js() {
    let all: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/media-bounds.json")).expect("fixtures parse");
    for row in &all {
        let name = row["name"].as_str().expect("name");
        let frames: Vec<Frame> = row["frames"]
            .as_array()
            .expect("frames")
            .iter()
            .map(frame_of)
            .collect();
        let want: Vec<u32> = row["bounds"]
            .as_array()
            .expect("bounds")
            .iter()
            .map(|n| u32::try_from(n.as_u64().expect("bound")).expect("bound fits"))
            .collect();
        assert_eq!(sprite_bounds(&frames).to_vec(), want, "{name}");
    }
    assert!(all.len() >= 15, "{} rows", all.len());
}
