//! Replays `fixtures/machine-media-pet.json` (made by `gen/machine-media.mjs pet`).

mod common;
mod machine_replay;

#[test]
fn every_row_matches_js() {
    let (graphics, audio) =
        machine_replay::replay("pet", include_str!("fixtures/machine-media-pet.json"));
    assert!(graphics >= 30, "{graphics} lowerGraphics rows");
    assert!(audio >= 16, "{audio} lowerAudio rows");
}
