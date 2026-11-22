//! `xtask corpus-tap`: argument parsing and the child error paths, with stub programs.

use std::fs;
use std::path::PathBuf;

use xtask::corpus_tap::{Args, Programs, parse_args, run};

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| (*p).to_string()).collect()
}

fn root(name: &str, with_modules: bool) -> PathBuf {
    let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("corpus-tap-{name}"));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    if with_modules {
        fs::create_dir_all(base.join("node_modules")).unwrap();
    }
    base
}

#[test]
fn parses_every_flag() {
    let args = parse_args(&strings(&[
        "out", "--front", "--fn", "a", "--fn", "b", "--jobs", "4",
    ]))
    .unwrap();
    assert_eq!(
        args,
        Args {
            out: PathBuf::from("out"),
            front: true,
            roundtrip: false,
            only: strings(&["a", "b"]),
            jobs: Some(4),
        }
    );
}

#[test]
fn defaults_are_mos_and_all_functions() {
    let args = parse_args(&strings(&["out"])).unwrap();
    assert!(!args.front && args.only.is_empty() && args.jobs.is_none());
}

#[test]
fn bad_arguments_are_errors() {
    for bad in [
        &[][..],
        &["a", "b"],
        &["a", "--fn"],
        &["a", "--jobs"],
        &["a", "--jobs", "0"],
        &["a", "--jobs", "x"],
        &["a", "--nope"],
        &["a", "--roundtrip", "--front"],
        &["a", "--roundtrip", "--fn", "x"],
    ] {
        assert!(parse_args(&strings(bad)).is_err(), "{bad:?}");
    }
}

#[test]
fn a_missing_node_is_named() {
    let dir = root("nonode", true);
    let programs = Programs {
        node: "no-such-node-program",
        pnpm: "no-such-pnpm-program",
    };
    let err = run(&strings(&["out"]), &dir, &programs).unwrap_err();
    assert!(
        err.contains("no-such-node-program") && err.contains("not found"),
        "{err}"
    );
}

#[test]
fn a_missing_pnpm_is_named_when_modules_are_absent() {
    let dir = root("nopnpm", false);
    let programs = Programs {
        node: "true",
        pnpm: "no-such-pnpm-program",
    };
    let err = run(&strings(&["out"]), &dir, &programs).unwrap_err();
    assert!(err.contains("no-such-pnpm-program"), "{err}");
}

#[test]
fn a_failing_child_is_an_error() {
    let dir = root("fail", true);
    let programs = Programs {
        node: "false",
        pnpm: "true",
    };
    let err = run(&strings(&["out"]), &dir, &programs).unwrap_err();
    assert!(err.contains("`false` failed"), "{err}");
}

#[test]
fn a_clean_dump_replays_to_a_zero_summary() {
    let dir = root("ok", true);
    let out = dir.join("out");
    fs::create_dir_all(out.join("tap")).unwrap();
    let programs = Programs {
        node: "true",
        pnpm: "true",
    };
    let code = run(&strings(&[out.to_str().unwrap()]), &dir, &programs).unwrap();
    assert_eq!(code, 0);
}

#[test]
fn the_roundtrip_flag_parses_with_jobs() {
    let args = parse_args(&strings(&["out", "--roundtrip", "--jobs", "2"])).unwrap();
    assert!(args.roundtrip && !args.front && args.only.is_empty());
    assert_eq!(args.jobs, Some(2));
}

#[test]
fn a_clean_dump_roundtrips_to_a_zero_summary() {
    let dir = root("roundtrip", true);
    let out = dir.join("out");
    let build = out.join("dump/p/c64");
    fs::create_dir_all(&build).unwrap();
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../crates/mos-ir/tests/fixtures/hello-world-c64/backend-input.json");
    fs::copy(fixture, build.join("backend-input.json")).unwrap();
    let programs = Programs {
        node: "true",
        pnpm: "true",
    };
    let code = run(
        &strings(&[out.to_str().unwrap(), "--roundtrip"]),
        &dir,
        &programs,
    )
    .unwrap();
    assert_eq!(code, 0);
}
