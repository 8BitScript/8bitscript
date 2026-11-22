//! The link's third pass against the JS oracle (crates/front/tests/gen/link-diagnostics.mjs
//! writes the golden file): an import no resolver knows reports 8BS3001 with the JS message,
//! byte for byte.

use std::fs;
use std::path::{Path, PathBuf};

use front::module::LinkOptions;
use xtask::front_dump::{Roots, dump_text};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/front/tests/fixtures/link-diagnostics")
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn an_unlinkable_import_reports_the_js_message() {
    let dir = std::env::temp_dir().join(format!("front-link-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let _scratch = Scratch(dir.clone());
    fs::copy(fixture().join("src/main.8bs"), dir.join("main.8bs")).unwrap();
    let dir_text = dir.to_string_lossy().into_owned();
    let roots = Roots::of("/nonexistent-toolchain", Some(&dir_text));
    let entry = dir.join("main.8bs").to_string_lossy().into_owned();
    let text = fs::read_to_string(&entry).unwrap();
    let mut link = LinkOptions::default();
    link.spec.base.machine = Some("pet".to_string());
    link.facts = Some(Default::default());
    let mut diagnostics = Vec::new();
    front::graph::load_graph(&text, &entry, &mut diagnostics, &link, None).unwrap();
    let got = dump_text(serde_json::to_value(&diagnostics).unwrap(), &roots);
    let want = fs::read_to_string(fixture().join("golden/diagnostics.json")).unwrap();
    assert_eq!(got, want);
}
