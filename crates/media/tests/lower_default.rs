//! Replays `fixtures/lower-default.json` (made by `gen/lower-default.mjs`).

mod common;

use common::{json, norm, rows};
use indexmap::IndexMap;
use media::analyze_media;
use media::lower_default::{
    DEFAULT_MAX_STEPS, KIND_C64, KIND_GLYPH, KIND_NES, KIND_PET, WAVE_NOISE, WAVE_PULSE, WAVE_SAW,
    WAVE_TRIANGLE, encode_song, glyph_of, lower_audio_default, lower_graphics_default, song_events,
    wave_index,
};
use media::machine::Frame;
use serde_json::{Value, json as j};

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

fn index(v: &Value, key: &str) -> usize {
    usize::try_from(v[key].as_u64().expect(key)).expect("index fits")
}

#[test]
fn every_row_matches_js() {
    let all = rows(include_str!("fixtures/lower-default.json"));
    assert!(all.len() >= 100, "{} rows", all.len());
    let mut counts = std::collections::BTreeMap::new();
    for row in &all {
        let f = row["fn"].as_str().unwrap();
        let name = row["name"].as_str().unwrap();
        let args = &row["args"];
        let got: Value = match f {
            "constants" => j!({
                "KIND_GLYPH": KIND_GLYPH, "KIND_C64": KIND_C64, "KIND_NES": KIND_NES, "KIND_PET": KIND_PET,
                "WAVE_PULSE": WAVE_PULSE, "WAVE_NOISE": WAVE_NOISE, "WAVE_TRIANGLE": WAVE_TRIANGLE,
                "WAVE_SAW": WAVE_SAW, "DEFAULT_MAX_STEPS": DEFAULT_MAX_STEPS,
            }),
            "waveIndex" => j!(wave_index(args["name"].as_str().unwrap())),
            "glyphOf" => j!(glyph_of(&frame_of(&args["frame"]))),
            "lowerGraphicsDefault" => {
                let (text, file) = (
                    args["text"].as_str().unwrap(),
                    args["file"].as_str().unwrap(),
                );
                let gir = analyze_media(text, file, ".8bg").gir.expect("gir");
                let frames: Vec<Frame> = args["frames"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(frame_of)
                    .collect();
                json(&lower_graphics_default(
                    &gir.sprites[index(args, "sprite")],
                    &frames,
                    file,
                ))
            }
            "songEvents" | "encodeSong" | "lowerAudioDefault" => {
                let (text, file) = (
                    args["text"].as_str().unwrap(),
                    args["file"].as_str().unwrap(),
                );
                let air = analyze_media(text, file, ".8ba").air.expect("air");
                match f {
                    "songEvents" => {
                        let events = song_events(&air, &air.songs[index(args, "song")]);
                        j!({ "events": json(&events.events), "length": events.length })
                    }
                    "encodeSong" => {
                        let song = &air.songs[index(args, "song")];
                        let events = song_events(&air, song);
                        json(&encode_song(song, &events.events, events.length))
                    }
                    _ => {
                        let machine = args["machine"].as_str().unwrap_or("undefined");
                        json(&lower_audio_default(&air, &IndexMap::new(), file, machine))
                    }
                }
            }
            other => panic!("unknown fn {other}"),
        };
        assert_eq!(norm(&got), norm(&row["result"]), "{f}: {name}");
        *counts.entry(f.to_string()).or_insert(0) += 1;
    }
    assert!(counts["lowerAudioDefault"] >= 50, "{counts:?}");
    assert!(counts["lowerGraphicsDefault"] >= 10, "{counts:?}");
}
