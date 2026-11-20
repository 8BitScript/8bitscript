//! Replays `fixtures/machine-media-nes.json` (made by `gen/machine-media.mjs nes`).

mod common;
mod machine_replay;

#[test]
fn every_row_matches_js() {
    let (graphics, audio) =
        machine_replay::replay("nes", include_str!("fixtures/machine-media-nes.json"));
    assert!(graphics >= 12, "{graphics} lowerGraphics rows");
    assert!(audio >= 24, "{audio} lowerAudio rows");
}
