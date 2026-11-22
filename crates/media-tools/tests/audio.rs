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
                let samples: Vec<f32> = match a[0].as_array() {
                    Some(list) => list
                        .iter()
                        .map(|v| v.as_f64().map_or(f32::NAN, |x| x as f32))
                        .collect(),
                    // recipe: fround(((i * mul) % mod) / div + off)
                    None => {
                        let r = &a[0];
                        let (mul, m) = (r["mul"].as_u64().unwrap(), r["mod"].as_u64().unwrap());
                        let (div, off) = (r["div"].as_f64().unwrap(), r["off"].as_f64().unwrap());
                        (0..r["n"].as_u64().unwrap())
                            .map(|i| (((i * mul) % m) as f64 / div + off) as f32)
                            .collect()
                    }
                };
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

fn wav(channels: u16, bits: u16, data: &[u8]) -> Vec<u8> {
    let mut fmt = vec![1, 0];
    fmt.extend(channels.to_le_bytes());
    fmt.extend(8000u32.to_le_bytes());
    fmt.extend(8000u32.to_le_bytes());
    fmt.extend([1, 0]);
    fmt.extend(bits.to_le_bytes());
    let mut body = b"WAVE".to_vec();
    body.extend(b"fmt ");
    body.extend((fmt.len() as u32).to_le_bytes());
    body.extend(&fmt);
    body.extend(b"data");
    body.extend((data.len() as u32).to_le_bytes());
    body.extend(data);
    let mut out = b"RIFF".to_vec();
    out.extend((body.len() as u32).to_le_bytes());
    out.extend(body);
    out
}

// A WAV with zero channels is an error in both implementations.
#[test]
fn wav_with_zero_channels_is_an_error() {
    assert_eq!(
        decode_wav(&wav(0, 8, &[1, 2, 3])).unwrap_err(),
        "WAV has zero channels"
    );
    assert_eq!(
        decode_wav(&wav(0, 16, &[1, 2])).unwrap_err(),
        "WAV has zero channels"
    );
    // a format the JS rejects before any loop keeps its own message
    assert_eq!(
        decode_wav(&wav(0, 24, &[1, 2])).unwrap_err(),
        "WAV PCM 24-bit format 1 is not supported"
    );
}

#[test]
fn decoded_audio_serializes_with_the_js_field_names() {
    let v = serde_json::to_value(decode_wav(&wav(1, 8, &[128])).unwrap()).unwrap();
    assert_eq!(v["sampleRate"], 8000);
    assert!(v.get("sample_rate").is_none());
    assert_eq!(v["samples"], serde_json::json!([0.0]));
}

#[cfg(unix)]
#[test]
fn flac_output_past_the_buffer_limit_is_a_failure() {
    let dir = scratch("fake-big-stdout");
    let file = dir.join("a.flac");
    std::fs::write(&file, b"x").unwrap();
    let search = fake_ffmpeg(
        &dir,
        "[ \"$1\" = -version ] && exit 0\necho oops >&2\nhead -c 40000000 /dev/zero",
    );
    let err = decode_flac_in(file.to_str().unwrap(), Some(&search)).unwrap_err();
    assert_eq!(err.code, None);
    assert_eq!(
        err.message,
        format!("ffmpeg could not decode '{}': oops\n", file.display())
    );
}

#[cfg(unix)]
#[test]
fn flac_exactly_at_the_buffer_limit_is_accepted() {
    let dir = scratch("fake-limit-stdout");
    let file = dir.join("a.flac");
    std::fs::write(&file, b"x").unwrap();
    let search = fake_ffmpeg(
        &dir,
        "[ \"$1\" = -version ] && exit 0\nhead -c 33554432 /dev/zero",
    );
    let got = decode_flac_in(file.to_str().unwrap(), Some(&search)).unwrap();
    assert_eq!(got.samples.len(), 33554432 / 4);
}

#[cfg(unix)]
#[test]
fn flac_stderr_past_the_buffer_limit_is_a_failure() {
    let dir = scratch("fake-big-stderr");
    let file = dir.join("a.flac");
    std::fs::write(&file, b"x").unwrap();
    let search = fake_ffmpeg(
        &dir,
        "[ \"$1\" = -version ] && exit 0\nhead -c 40000000 /dev/zero >&2",
    );
    let err = decode_flac_in(file.to_str().unwrap(), Some(&search)).unwrap_err();
    assert!(
        err.message
            .starts_with(&format!("ffmpeg could not decode '{}': ", file.display()))
    );
}

#[cfg(unix)]
#[test]
fn flac_spawn_failure_is_a_decode_error() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("fake-spawn-fails");
    let file = dir.join("a.flac");
    std::fs::write(&file, b"x").unwrap();
    // passes the version probe, then makes itself unrunnable
    let search = fake_ffmpeg(
        &dir,
        "[ \"$1\" = -version ] && { chmod 644 \"$0\"; exit 0; }\nexit 0",
    );
    // the probe inside `decode_flac_in` passes; the real run then cannot start it
    let err = decode_flac_in(file.to_str().unwrap(), Some(&search)).unwrap_err();
    assert_eq!(
        std::fs::metadata(dir.join("ffmpeg"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
    assert_eq!(
        err.message,
        format!("ffmpeg could not decode '{}': ", file.display())
    );
    assert_eq!(err.code, None);
}
