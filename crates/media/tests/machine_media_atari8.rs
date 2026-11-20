//! Replays `fixtures/machine-media-atari8.json` (made by `gen/machine-media.mjs atari8`).

mod common;
mod machine_replay;

#[test]
fn every_row_matches_js() {
    let (graphics, audio) =
        machine_replay::replay("atari8", include_str!("fixtures/machine-media-atari8.json"));
    assert!(graphics >= 12, "{graphics} lowerGraphics rows");
    assert!(audio >= 18, "{audio} lowerAudio rows");
}
