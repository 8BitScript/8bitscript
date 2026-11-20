//! Replays `fixtures/audio.json` and `fixtures/flac.json` (made by
//! `gen/audio.mjs` in Node), and tests `decode_flac` against stand-in
//! `ffmpeg` scripts.

use media_tools::audio::{
    decode_flac, decode_flac_in, decode_wav, encode_dpcm, ffmpeg_available_in,
};
use serde_json::Value;
use std::ffi::OsString;
use std::path::PathBuf;

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn wav_and_dpcm_fixtures_match_js() {
    let rows: Vec<Value> = serde_json::from_str(include_str!("fixtures/audio.json")).unwrap();
    let (mut wavs, mut errors, mut dpcms) = (0, 0, 0);
    for row in &rows {
        let a = row["args"].as_array().unwrap();
        let name = row["name"].as_str().unwrap_or("");
        match row["fn"].as_str().unwrap() {
            "decodeWav" => {
                let got = decode_wav(&unhex(a[0].as_str().unwrap()));
                if let Some(msg) = row.get("error") {
                    assert_eq!(got.unwrap_err(), msg.as_str().unwrap(), "{name}");
                    errors += 1;
                } else {
                    let got = got.unwrap_or_else(|e| panic!("{name}: {e}"));
                    let want = &row["result"];
                    assert_eq!(
                        got.sample_rate as u64,
                        want["sampleRate"].as_u64().unwrap(),
                        "{name}"
                    );
                    let w: Vec<f32> = want["samples"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_f64().unwrap() as f32)
                        .collect();
                    assert_eq!(got.samples, w, "{name}");
                    wavs += 1;
                }
            }
            "encodeDpcm" => {
                let samples: Vec<f32> = a[0]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_f64().map_or(f32::NAN, |x| x as f32))
                    .collect();
                let got = encode_dpcm(&samples, a[1].as_f64().unwrap());
                match (&row["result"], got) {
                    (Value::Null, g) => assert!(g.is_none(), "dpcm {dpcms}"),
                    (w, Some(g)) => {
                        let want: Vec<u8> = w["bytes"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| v.as_u64().unwrap() as u8)
                            .collect();
                        assert_eq!(g.bytes, want, "dpcm {dpcms}");
                        assert_eq!(g.rate as u64, w["rate"].as_u64().unwrap());
                        assert_eq!(g.length as u64, w["length"].as_u64().unwrap());
                    }
                    (_, None) => panic!("dpcm {dpcms}: expected Some"),
                }
                dpcms += 1;
            }
            f => panic!("unknown fn {f}"),
        }
    }
    assert!(
        wavs >= 14 && errors >= 8 && dpcms >= 10,
        "{wavs} {errors} {dpcms}"
    );
}

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn flac_without_ffmpeg_has_the_named_code() {
    let dir = scratch("no-ffmpeg");
    let file = dir.join("a.flac");
    std::fs::write(&file, b"fLaC").unwrap();
    let search = OsString::from(dir.as_os_str());
    assert!(!ffmpeg_available_in(Some(&search)));
    assert!(!ffmpeg_available_in(None));
    let err = decode_flac_in(file.to_str().unwrap(), Some(&search)).unwrap_err();
    assert_eq!(err.message, "FLAC needs ffmpeg on PATH");
    assert_eq!(err.code.as_deref(), Some("FLAC_NEEDS_FFMPEG"));
    assert_eq!(err.to_string(), "FLAC needs ffmpeg on PATH");
}

#[test]
fn flac_missing_file_is_a_plain_error() {
    let dir = scratch("missing-file");
    let missing = dir.join("none.flac");
    let err = decode_flac(missing.to_str().unwrap()).unwrap_err();
    assert_eq!(err.message, format!("cannot read '{}'", missing.display()));
    assert_eq!(err.code, None);
}

#[cfg(unix)]
fn fake_ffmpeg(dir: &std::path::Path, body: &str) -> OsString {
    use std::os::unix::fs::PermissionsExt;
    let bin = dir.join("ffmpeg");
    std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    OsString::from(dir.as_os_str())
}

#[cfg(unix)]
#[test]
fn flac_decodes_through_the_ffmpeg_on_path() {
    let dir = scratch("fake-ok");
    let file = dir.join("a.flac");
    std::fs::write(&file, b"x").unwrap();
    // 1.0 and 0.5 as f32le
    let search = fake_ffmpeg(
        &dir,
        "[ \"$1\" = -version ] && exit 0\nprintf '\\000\\000\\200?\\000\\000\\000?\\000'",
    );
    assert!(ffmpeg_available_in(Some(&search)));
    let got = decode_flac_in(file.to_str().unwrap(), Some(&search)).unwrap();
    assert_eq!(got.sample_rate, 48000);
    assert_eq!(got.samples, vec![1.0, 0.5]); // the trailing partial float is dropped
}

#[cfg(unix)]
#[test]
fn flac_ffmpeg_failure_reports_the_stderr_tail() {
    let dir = scratch("fake-fail");
    let file = dir.join("a.flac");
    std::fs::write(&file, b"x").unwrap();
    let noise = "e".repeat(300);
    let search = fake_ffmpeg(
        &dir,
        &format!("[ \"$1\" = -version ] && exit 0\necho {noise}END >&2\nexit 1"),
    );
    let err = decode_flac_in(file.to_str().unwrap(), Some(&search)).unwrap_err();
    assert_eq!(err.code, None);
    let tail = format!("{}END\n", "e".repeat(196));
    assert_eq!(
        err.message,
        format!("ffmpeg could not decode '{}': {tail}", file.display())
    );
}

#[cfg(unix)]
#[test]
fn ffmpeg_that_fails_its_version_probe_is_unavailable() {
    let dir = scratch("fake-broken");
    let search = fake_ffmpeg(&dir, "exit 3");
    assert!(!ffmpeg_available_in(Some(&search)));
}

#[test]
fn real_flac_decode_matches_js() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/flac.json")).unwrap();
    if fixture["ffmpeg"] != Value::Bool(true) {
        eprintln!(
            "SKIP real_flac_decode_matches_js: fixture was made without ffmpeg (no FLAC recorded)"
        );
        return;
    }
    if !media_tools::audio::ffmpeg_available() {
        eprintln!("SKIP real_flac_decode_matches_js: ffmpeg is not on PATH");
        return;
    }
    let file = scratch("real-flac").join("sample.flac");
    std::fs::write(&file, unhex(fixture["flacHex"].as_str().unwrap())).unwrap();
    let got = decode_flac(file.to_str().unwrap()).unwrap();
    assert_eq!(
        got.sample_rate as u64,
        fixture["sampleRate"].as_u64().unwrap()
    );
    let want: Vec<f32> = fixture["samples"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap() as f32)
        .collect();
    assert_eq!(got.samples, want);
}
