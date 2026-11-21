//! Replays `fixtures/machine-media-<machine>.json` (made by
//! `gen/machine-media.mjs <machine>`) against `media::machines::for_machine`.

use crate::common::{json, norm, rows};
use indexmap::IndexMap;
use media::analyze_media;
use media::audio::song::encode_song;
use media::machine::{Dpcm, Facts, Frame, MediaSlots, Pcm};
use media::machines::for_machine;
use serde_json::{Value, json as j};

fn facts_of(v: &Value) -> Facts {
    v.as_object()
        .expect("facts object")
        .iter()
        .map(|(k, x)| (k.clone(), x.clone()))
        .collect()
}

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

fn pcm_of(v: &Value) -> IndexMap<String, Pcm> {
    let mut map = IndexMap::new();
    for (name, entry) in v.as_object().expect("pcm object") {
        let dpcm = match &entry["dpcm"] {
            Value::Null => None,
            d => Some(Dpcm {
                bytes: d["bytes"]
                    .as_array()
                    .expect("bytes")
                    .iter()
                    .map(|b| u8::try_from(b.as_u64().expect("byte")).expect("byte fits"))
                    .collect(),
                rate: u8::try_from(d["rate"].as_u64().expect("rate")).expect("rate fits"),
                length: usize::try_from(d["length"].as_u64().expect("length"))
                    .expect("length fits"),
            }),
        };
        map.insert(
            name.clone(),
            Pcm {
                sample_rate: 0,
                samples: Vec::new(),
                dpcm,
            },
        );
    }
    map
}

fn count(v: &Value) -> u32 {
    u32::try_from(v.as_u64().expect("slot count")).expect("slot fits")
}

fn slots_of(v: &Value) -> Option<MediaSlots> {
    if v.is_null() {
        return None;
    }
    Some(MediaSlots {
        graphics: count(&v["graphics"]),
        audio: count(&v["audio"]),
        audio_bytes: count(&v["audioBytes"]),
        pet_shapes: v.get("petShapes").map(count),
        web_sprite_bytes: v.get("webSpriteBytes").map(count),
    })
}

fn slots_json(s: Option<&MediaSlots>) -> Value {
    let Some(s) = s else { return Value::Null };
    let mut v = j!({ "graphics": s.graphics, "audio": s.audio, "audioBytes": s.audio_bytes });
    if let Some(p) = s.pet_shapes {
        v["petShapes"] = j!(p);
    }
    if let Some(w) = s.web_sprite_bytes {
        v["webSpriteBytes"] = j!(w);
    }
    norm(&v)
}

/// Replays every row; returns `(lowerGraphics rows, lowerAudio rows)`.
pub fn replay(machine: &str, src: &str) -> (usize, usize) {
    let module = for_machine(machine).expect("machine module");
    let (mut gfx, mut aud) = (0, 0);
    for row in &rows(src) {
        let (name, args) = (row["name"].as_str().unwrap(), &row["args"]);
        let text = args["text"].as_str().unwrap();
        let file = args["file"].as_str().unwrap();
        let facts = facts_of(&args["facts"]);
        match row["fn"].as_str().unwrap() {
            "lowerGraphics" => {
                let analysis = analyze_media(text, file, ".8bg");
                let gir = analysis.gir.expect("gir");
                let sprite = &gir.sprites[args["sprite"].as_u64().unwrap() as usize];
                let frames: Vec<Frame> = args["frames"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(frame_of)
                    .collect();
                let mut slots = slots_of(&args["slots"]);
                let got = module.lower_graphics(sprite, &frames, &facts, file, slots.as_mut());
                assert_eq!(json(&got), norm(&row["result"]), "{machine}: {name}");
                assert_eq!(
                    slots_json(slots.as_ref()),
                    norm(&row["slotsAfter"]),
                    "{machine}: {name}: slots"
                );
                gfx += 1;
            }
            "lowerAudio" => {
                let analysis = analyze_media(text, file, ".8ba");
                let air = analysis.air.expect("air");
                let enc = |s: &media::audio::Song| encode_song(&air, s);
                let pcm = pcm_of(&args["pcm"]);
                let got = module.lower_audio(&air, &pcm, &facts, file, &enc);
                assert_eq!(json(&got), norm(&row["result"]), "{machine}: {name}");
                aud += 1;
            }
            other => panic!("unknown fn {other}"),
        }
    }
    (gfx, aud)
}
