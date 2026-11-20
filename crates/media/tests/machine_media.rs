//! Replays `fixtures/machine-media-<machine>.json` (made by
//! `gen/machine-media.mjs <machine>`): the machine's `lower_graphics` and
//! `lower_audio` against the JS module, every row compared exactly.

mod common;

use common::{json, norm, rows};
use indexmap::IndexMap;
use media::audio::Song;
use media::audio::song::encode_song;
use media::machine::{Facts, Frame, MachineMedia, MediaSlots};
use media::machines::{c64::C64, cx16::Cx16, vic20::Vic20};
use media::{parse_audio, parse_graphics, tokenize_media};
use serde_json::Value;

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).expect("hex"))
        .collect()
}

fn facts_of(v: &Value) -> Facts {
    serde_json::from_value(v.clone()).expect("facts")
}

/// Replays every row; returns the number of (graphics, audio) rows.
fn replay(machine: &dyn MachineMedia, src: &str) -> (usize, usize) {
    let (mut g, mut a) = (0, 0);
    for row in rows(src) {
        let name = row["name"].as_str().unwrap();
        let args = &row["args"];
        let text = args["text"].as_str().unwrap();
        let file = args["file"].as_str().unwrap();
        let facts = facts_of(&args["facts"]);
        let mut slots = MediaSlots::default();
        let mut got = match row["fn"].as_str().unwrap() {
            "lowerGraphics" => {
                g += 1;
                let (tokens, _) = tokenize_media(text, file, ".8bg");
                let (gir, _) = parse_graphics(&tokens, text, file);
                let sprite = &gir.sprites[args["sprite"].as_u64().unwrap() as usize];
                let frames: Vec<Frame> = args["frames"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| Frame {
                        width: f["width"].as_u64().unwrap() as u32,
                        height: f["height"].as_u64().unwrap() as u32,
                        rgba: unhex(f["rgba"].as_str().unwrap()),
                    })
                    .collect();
                json(&machine.lower_graphics(sprite, &frames, &facts, file, Some(&mut slots)))
            }
            "lowerAudio" => {
                a += 1;
                let (tokens, _) = tokenize_media(text, file, ".8ba");
                let (air, _) = parse_audio(&tokens, text, file);
                let encode = |s: &Song| encode_song(&air, s);
                let pcm = IndexMap::new();
                json(&machine.lower_audio(&air, &pcm, &facts, file, &encode))
            }
            other => panic!("unknown fn {other}"),
        };
        got["slots"] = serde_json::json!({
            "graphics": slots.graphics,
            "audio": slots.audio,
            "audioBytes": slots.audio_bytes,
        });
        assert_eq!(norm(&got), norm(&row["result"]), "{name}");
    }
    (g, a)
}

#[test]
fn c64_matches_js() {
    let (g, a) = replay(&C64, include_str!("fixtures/machine-media-c64.json"));
    assert_eq!((g, a), (92, 139), "graphics and audio rows");
}

#[test]
fn cx16_matches_js() {
    let (g, a) = replay(&Cx16, include_str!("fixtures/machine-media-cx16.json"));
    assert_eq!((g, a), (92, 139), "graphics and audio rows");
}

#[test]
fn vic20_matches_js() {
    let (g, a) = replay(&Vic20, include_str!("fixtures/machine-media-vic20.json"));
    assert_eq!((g, a), (92, 139), "graphics and audio rows");
}
