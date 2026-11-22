//! `front::analyze` against the JS oracle (crates/front/tests/gen/analyze.mjs writes the golden
//! files): the diagnostic order, import resolution on and off, a media file and the
//! `source_kind` override, all with the default link options (no frame rate, so the fold's 60).

use std::fs;
use std::path::{Path, PathBuf};

use front::{AnalyzeOptions, analyze};
use syntax::SourceKind;
use xtask::front_dump::{Roots, dump_text};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/front/tests/fixtures/analyze")
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The text of `analyze(file)` over a scratch copy of the sources, as the golden files write it.
fn run(name: &str, file: &str, options: &mut AnalyzeOptions) -> (String, String) {
    let dir = std::env::temp_dir().join(format!("front-analyze-{name}-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let _scratch = Scratch(dir.clone());
    for entry in fs::read_dir(fixture().join("src")).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), dir.join(entry.file_name())).unwrap();
    }
    let dir_text = dir.to_string_lossy().into_owned();
    let roots = Roots::of("/nonexistent-toolchain", Some(&dir_text));
    let path = dir.join(file).to_string_lossy().into_owned();
    let text = fs::read_to_string(&path).unwrap();
    let found = analyze(&text, &path, options).unwrap();
    let got = dump_text(serde_json::to_value(&found).unwrap(), &roots);
    let want = fs::read_to_string(fixture().join(format!("golden/{name}.json"))).unwrap();
    (got, want)
}

#[test]
fn diagnostics_come_in_source_order_without_import_resolution() {
    let (got, want) = run("imports-off", "main.8bs", &mut AnalyzeOptions::default());
    assert_eq!(got, want);
}

#[test]
fn import_resolution_adds_the_unresolved_module_in_order() {
    let mut options = AnalyzeOptions {
        resolve_imports: true,
        ..AnalyzeOptions::default()
    };
    let (got, want) = run("imports-on", "main.8bs", &mut options);
    assert_eq!(got, want);
}

#[test]
fn a_media_file_is_analyzed_by_the_media_front_end() {
    let (got, want) = run("media", "sprite.8bg", &mut AnalyzeOptions::default());
    assert_eq!(got, want);
}

#[test]
fn the_source_kind_option_overrides_the_file_name() {
    let mut options = AnalyzeOptions {
        source_kind: Some(SourceKind::Bs),
        ..AnalyzeOptions::default()
    };
    let (got, want) = run("kind-override", "Window.8bx", &mut options);
    assert_eq!(got, want);
}

#[test]
fn default_options_fold_frames_at_sixty() {
    let (got, _) = run("imports-off", "main.8bs", &mut AnalyzeOptions::default());
    assert!(got.contains("frameRate (60) — rounded to 60 frames"));
}
