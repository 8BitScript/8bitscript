//! `xtask tap` over a directory of hand-written records, with a fake replay.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use mos::build::Counters;
use mos::tap::Replay;
use serde_json::{Value, json};
use xtask::tap::{parse_args, run};

fn dir(name: &str) -> PathBuf {
    let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("tap-{name}"));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    base
}

fn write(base: &Path, id: &str, file: &str, rows: &[Value]) {
    let target = base.join(id);
    fs::create_dir_all(&target).unwrap();
    let text: String = rows.iter().map(|r| format!("{r}\n")).collect();
    fs::write(target.join(file), text).unwrap();
}

/// `a` matches, `b` mismatches, `c` skips, anything else is not tapped.
fn fake(name: &str, record: &Value, counters: &mut Counters) -> Option<Replay> {
    match name {
        "a" => {
            counters.lower += 1;
            Some(Replay::Match)
        }
        "b" => Some(Replay::Mismatch(
            "/result/0".into(),
            record["args"].clone(),
            json!(7),
        )),
        "c" => Some(Replay::Skip),
        _ => None,
    }
}

#[test]
fn matches_and_skips_exit_zero() {
    let base = dir("ok");
    write(
        &base,
        "p/main/c64",
        "1-0.jsonl",
        &[
            json!({"seq": 1, "fn": "c"}),
            json!({"seq": 0, "fn": "a"}),
            json!({"seq": 2, "fn": "reset:lower"}),
        ],
    );
    let report = run(&base, None, &fake).unwrap();
    assert_eq!(report.summary(), "tap: 2 calls, 0 ERROR, 1 SKIP");
    assert_eq!(report.exit_code(), 0);
}

#[test]
fn a_mismatch_prints_one_error_line_and_exits_one() {
    let base = dir("bad");
    write(
        &base,
        "z/x/pet",
        "1-0.jsonl",
        &[json!({"seq": 0, "fn": "a"})],
    );
    write(
        &base,
        "p/main/c64",
        "1-0.jsonl",
        &[
            json!({"seq": 4, "fn": "b", "args": [1]}),
            json!({"seq": 5, "fn": "mystery"}),
        ],
    );
    let report = run(&base, None, &fake).unwrap();
    assert_eq!(
        report.lines,
        [
            "ERROR p/main/c64 b#4 /result/0: js=[1] rust=7",
            "ERROR p/main/c64 mystery#5: not a tapped function",
        ]
    );
    assert_eq!(report.summary(), "tap: 3 calls, 2 ERROR, 0 SKIP");
    assert_eq!(report.exit_code(), 1);
}

#[test]
fn the_fn_filter_limits_the_calls() {
    let base = dir("filter");
    write(
        &base,
        "p/main/c64",
        "1-0.jsonl",
        &[
            json!({"seq": 0, "fn": "a"}),
            json!({"seq": 1, "fn": "reset:relax"}),
            json!({"seq": 2, "fn": "b", "args": 0}),
        ],
    );
    let report = run(&base, Some("a"), &fake).unwrap();
    assert_eq!((report.calls, report.errors), (1, 0));
}

#[test]
fn counters_reset_at_reset_events_and_between_builds() {
    let base = dir("counters");
    let rows = [
        json!({"seq": 0, "fn": "a"}),
        json!({"seq": 1, "fn": "a"}),
        json!({"seq": 2, "fn": "reset:lower"}),
        json!({"seq": 3, "fn": "a"}),
    ];
    write(&base, "p/one/c64", "1-0.jsonl", &rows);
    write(&base, "p/two/c64", "2-0.jsonl", &rows);
    let seen = std::cell::RefCell::new(Vec::new());
    let spy = |_: &str, _: &Value, c: &mut Counters| {
        seen.borrow_mut().push(c.lower);
        c.lower += 1;
        Some(Replay::Match)
    };
    run(&base, None, &spy).unwrap();
    assert_eq!(*seen.borrow(), [0, 1, 0, 0, 1, 0]);
}

#[test]
fn bad_input_is_an_error() {
    let base = dir("garbage");
    write(&base, "p", "1-0.jsonl", &[]);
    fs::write(base.join("p").join("1-0.jsonl"), "{not json\n").unwrap();
    assert!(run(&base, None, &fake).unwrap_err().contains("record 1"));
    assert!(run(&base.join("missing"), None, &fake).is_err());
    assert!(parse_args(&[]).is_err());
    assert!(parse_args(&["a".into(), "b".into()]).is_err());
    assert!(parse_args(&["a".into(), "--fn".into()]).is_err());
    assert!(parse_args(&["a".into(), "--nope".into()]).is_err());
    let (path, only) = parse_args(&["a".into(), "--fn".into(), "lower".into()]).unwrap();
    assert_eq!((path, only), (PathBuf::from("a"), Some("lower".into())));
}

#[test]
fn the_binary_replays_with_the_real_stubs() {
    let base = dir("binary");
    write(
        &base,
        "p/main/c64",
        "1-0.jsonl",
        &[json!({"seq": 0, "fn": "allocate", "args": [], "result": {}})],
    );
    let out = Command::new(env!("CARGO_BIN_EXE_xtask"))
        .args(["tap", base.to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "tap: 1 calls, 0 ERROR, 1 SKIP"
    );
    let usage = Command::new(env!("CARGO_BIN_EXE_xtask"))
        .arg("tap")
        .output()
        .unwrap();
    assert_eq!(usage.status.code(), Some(2));
}

#[test]
fn front_dispatch_skips_every_stub_and_the_media_functions() {
    use xtask::front::replay;
    let mut counters = Counters::default();
    for name in [
        "bind",
        "bindImportedComponents",
        "check",
        "scanDeclaredTypes",
        "layoutTemplate",
        "checkBx",
        "elaborateBx",
        "applyCatalogCharset",
        "resolveCatalogSpecifier",
        "foldCompileTime",
        "lower",
        "findImports",
        "pathFormSpecifiers",
        "resolveSpecifier",
        "nativeSourcesBeside",
        "parseMediaModule",
        "elaborateMedia",
    ] {
        assert_eq!(
            replay(name, &json!({}), &mut counters),
            Some(Replay::Skip),
            "{name}"
        );
    }
    assert_eq!(replay("link", &json!({}), &mut counters), None);
}

#[test]
fn front_compare_outcomes_and_the_front_flag() {
    use front_replay::{Replay as Front, compare};
    let a = json!({"a": [1, 2]});
    let b = json!({"a": [1, 3]});
    assert_eq!(compare(&a, &a), Front::Match);
    assert_eq!(
        compare(&a, &b),
        Front::Mismatch("/a/1".into(), json!(2), json!(3))
    );
    let base = dir("front");
    write(
        &base,
        "p/main/c64",
        "1-0.jsonl",
        &[json!({"seq": 0, "fn": "bind", "args": [], "result": null})],
    );
    let out = Command::new(env!("CARGO_BIN_EXE_xtask"))
        .args(["tap", base.to_str().unwrap(), "--front"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "tap: 1 calls, 0 ERROR, 1 SKIP"
    );
}
