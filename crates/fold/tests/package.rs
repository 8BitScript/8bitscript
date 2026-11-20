//! Replays `fixtures/package.json` (made by `gen/package.mjs` in Node) over a
//! temp tree built from the fixture, plus the failure cases JS words with V8
//! text (the Rust wording differs, so those check the shape only).

use std::fs;
use std::path::{Path, PathBuf};

use fold::facts::Json;
use fold::package::{NearestPackage, PACKAGE_FIELDS, nearest_package};

struct Root(PathBuf);

impl Root {
    fn new(tag: &str) -> Root {
        let dir = std::env::temp_dir().join(format!("fold-package-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Root(dir)
    }

    fn write(&self, file: &str, text: &str) {
        let path = self.0.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn rel(&self, path: &str) -> String {
        Path::new(path)
            .strip_prefix(&self.0)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn field<'a>(row: &'a Json, name: &str) -> &'a Json {
    let Json::Object(map) = row else {
        panic!("{row:?}")
    };
    &map[name]
}

#[test]
fn nearest_package_matches_js() {
    let fixture = Json::parse(include_str!("fixtures/package.json")).unwrap();
    let root = Root::new("fixture");
    let Json::Object(tree) = field(&fixture, "tree") else {
        panic!("tree")
    };
    for (file, text) in tree {
        let Json::String(text) = text else {
            panic!("text")
        };
        root.write(file, text);
    }
    // The null rows need no package.json above the temp dir.
    assert!(nearest_package(root.0.to_str().unwrap()).is_none());
    let Json::Array(rows) = field(&fixture, "rows") else {
        panic!("rows")
    };
    for row in rows {
        let Json::String(name) = field(row, "fn") else {
            panic!("fn")
        };
        let Json::Array(args) = field(row, "args") else {
            panic!("args")
        };
        let got = match name.as_str() {
            "PACKAGE_FIELDS" => Json::Array(
                PACKAGE_FIELDS
                    .iter()
                    .map(|f| Json::String((*f).to_string()))
                    .collect(),
            ),
            "nearestPackage" => {
                let Json::String(rel) = &args[0] else {
                    panic!("dir")
                };
                let dir = root.0.join(rel);
                match nearest_package(dir.to_str().unwrap()) {
                    None => Json::Null,
                    Some(NearestPackage::Found { path, json }) => NearestPackage::Found {
                        path: root.rel(&path),
                        json,
                    }
                    .to_json(),
                    Some(NearestPackage::Failed { path, error }) => panic!("{path}: {error}"),
                }
            }
            other => panic!("unknown fn {other}"),
        };
        assert_eq!(
            got.stringify(),
            field(row, "result").stringify(),
            "{}",
            args[0].stringify()
        );
    }
}

#[test]
fn nearest_package_reports_unreadable_and_invalid_files() {
    let root = Root::new("errors");
    root.write("bad/package.json", "{ not json");
    root.write("bad/sub/x.txt", "x");
    match nearest_package(root.0.join("bad/sub").to_str().unwrap()) {
        Some(NearestPackage::Failed { path, error }) => {
            assert_eq!(root.rel(&path), "bad/package.json");
            assert!(!error.is_empty());
        }
        other => panic!("{other:?}"),
    }
    // A directory named package.json exists but cannot be read.
    fs::create_dir_all(root.0.join("dir/package.json")).unwrap();
    match nearest_package(root.0.join("dir").to_str().unwrap()) {
        Some(NearestPackage::Failed { error, .. }) => {
            assert_eq!(error, "EISDIR: illegal operation on a directory, read");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn relative_dir_resolves_against_the_working_directory() {
    // The crate directory has no package.json of its own above `tests`
    // other than Cargo's; the walk ends at the repo's package.json or None.
    let here = nearest_package("tests/../..");
    let there = nearest_package(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_str()
            .unwrap(),
    );
    assert_eq!(here, there);
}
