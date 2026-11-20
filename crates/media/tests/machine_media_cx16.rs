//! Replays `fixtures/machine-media-cx16.json` (made by `gen/machine-media.mjs cx16`).

mod common;
mod machine_replay;

#[test]
fn every_row_matches_js() {
    let (graphics, audio) =
        machine_replay::replay("cx16", include_str!("fixtures/machine-media-cx16.json"));
    assert_eq!((graphics, audio), (92, 205));
}
