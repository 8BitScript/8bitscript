//! Replays `fixtures/machine-media-c64.json` (made by `gen/machine-media.mjs c64`).

mod common;
mod machine_replay;

#[test]
fn every_row_matches_js() {
    let (graphics, audio) =
        machine_replay::replay("c64", include_str!("fixtures/machine-media-c64.json"));
    assert_eq!((graphics, audio), (92, 205));
}
