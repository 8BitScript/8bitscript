//! The module driver against the JS oracle on the slotted-component fixture
//! (crates/front/tests/gen/front-dump.mjs writes the golden files).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use front::module::{LinkOptions, Stage};
use serde_json::Value;
use xtask::front_dump::{Roots, dump_text};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/front/tests/fixtures/front-dump")
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn link_fixture() -> (BTreeMap<String, String>, String, Scratch) {
    let dir = std::env::temp_dir().join(format!("front-dump-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let scratch = Scratch(dir.clone());
    for name in ["Window.8bx", "main.8bs"] {
        fs::copy(fixture().join("src").join(name), dir.join(name)).unwrap();
    }
    let dir_text = dir.to_string_lossy().into_owned();
    let roots = Roots::of("/nonexistent-toolchain", Some(&dir_text));
    let entry = dir.join("main.8bs").to_string_lossy().into_owned();
    let text = fs::read_to_string(&entry).unwrap();
    let mut link = LinkOptions::default();
    link.spec.base.machine = Some("pet".to_string());
    link.frame_rate = 60.0;
    link.facts = Some(Default::default());
    link.bx_strict = true;
    let mut files = BTreeMap::new();
    let mut dump = |stage: Stage, key: &str, value: Value| {
        let suffix = match stage {
            Stage::Tokens => ".tokens.json",
            Stage::Ast => ".ast.json",
            Stage::ModuleIr => ".ir.json",
        };
        files.insert(
            format!("modules/{}{suffix}", roots.stem(key)),
            dump_text(value, &roots),
        );
    };
    let mut diagnostics = Vec::new();
    front::graph::load_graph(&text, &entry, &mut diagnostics, &link, Some(&mut dump)).unwrap();
    let fold: Vec<&_> = diagnostics
        .iter()
        .filter(|d| d.file.ends_with("Window.8bx"))
        .collect();
    let fold_text = dump_text(serde_json::to_value(&fold).unwrap(), &roots);
    (files, fold_text, scratch)
}

#[test]
fn module_dumps_match_the_js_golden() {
    let (files, _, _scratch) = link_fixture();
    let golden = fixture().join("golden");
    assert_eq!(files.len(), 6);
    for (rel, text) in &files {
        let want = fs::read_to_string(golden.join(rel)).unwrap();
        assert_eq!(text, &want, "{rel}");
    }
}

#[test]
fn the_fold_reports_each_let_once_and_a_parameter_default_three_times() {
    let (_, fold, _scratch) = link_fixture();
    let want = fs::read_to_string(fixture().join("golden/diagnostics.json")).unwrap();
    assert_eq!(fold, want);
    let rows: Vec<Value> = serde_json::from_str(&fold).unwrap();
    let at = |start: u64| rows.iter().filter(|d| d["start"] == start).count();
    assert_eq!((at(266), at(311), at(354)), (3, 1, 1));
}
