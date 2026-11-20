//! Replays `fixtures/machine-media-vic20.json` (made by `gen/machine-media.mjs vic20`).

mod common;
mod machine_replay;

#[test]
fn every_row_matches_js() {
    let (graphics, audio) =
        machine_replay::replay("vic20", include_str!("fixtures/machine-media-vic20.json"));
    assert_eq!((graphics, audio), (92, 205));
}
