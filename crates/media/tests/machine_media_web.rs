//! Replays `fixtures/machine-media-web.json` (made by `gen/machine-media.mjs web`).

mod common;
mod machine_replay;

#[test]
fn every_row_matches_js() {
    let (graphics, audio) =
        machine_replay::replay("web", include_str!("fixtures/machine-media-web.json"));
    assert!(graphics >= 20, "{graphics} lowerGraphics rows");
    assert!(audio >= 10, "{audio} lowerAudio rows");
}
