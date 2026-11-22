//! `cargo xtask roundtrip <dir>`: every `backend-input.json` and `linked.json` of a dump tree is
//! read into the `mos-ir` types and written back; the bytes must match.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// Output lines and counts of one run, in the style of `oracle::Report`.
#[derive(Debug, Default)]
pub struct Report {
    pub lines: Vec<String>,
    /// `backend-input.json`, `linked.json` and module `.ir.json` files read.
    pub files: usize,
    /// Of `files`, the linked programs (`linked.json`).
    pub linked: usize,
    /// Of `files`, the module IR dumps (`modules/**/*.ir.json`).
    pub module_ir: usize,
    pub ok: usize,
    pub errors: usize,
    /// Build folders whose `manifest.json` lists no `backend-input` stage
    /// (a web build writes `wasm-input` instead).
    pub not_expected: usize,
}

impl Report {
    pub fn summary(&self) -> String {
        format!(
            "roundtrip: {} files, {} OK, {} ERROR, {} without backend-input per manifest, {} module-ir, {} linked",
            self.files, self.ok, self.errors, self.not_expected, self.module_ir, self.linked
        )
    }

    pub fn exit_code(&self) -> u8 {
        u8::from(self.errors > 0)
    }

    fn error(&mut self, id: &str, detail: &str) {
        self.errors += 1;
        self.lines
            .push(format!("ERROR {id} backend-input {detail}"));
    }

    fn linked_error(&mut self, id: &str, detail: &str) {
        self.errors += 1;
        self.lines.push(format!("ERROR {id} linked {detail}"));
    }

    fn module_ir_error(&mut self, rel: &str, detail: &str) {
        self.errors += 1;
        self.lines.push(format!("ERROR {rel} module-ir {detail}"));
    }
}

/// Does `manifest.json` list the `backend-input` stage? `Err` when it cannot be read.
fn manifest_expects(path: &Path) -> Result<bool, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("manifest.json unreadable: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("manifest.json invalid: {e}"))?;
    let stages = value
        .get("stages")
        .and_then(serde_json::Value::as_array)
        .ok_or("manifest.json has no stages array")?;
    Ok(stages.iter().any(|s| s.as_str() == Some("backend-input")))
}

/// A module IR dump read into `lower::module::ModuleIr` and written back canonically.
fn module_ir_roundtrip(text: &str) -> Result<(), String> {
    let ir: lower::module::ModuleIr = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let value = serde_json::to_value(&ir).map_err(|e| e.to_string())?;
    let again = oracle::canonical_json(&value);
    if again == text {
        return Ok(());
    }
    let line = again
        .lines()
        .zip(text.lines())
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| again.lines().count().min(text.lines().count()))
        + 1;
    Err(format!("bytes differ at line {line}"))
}

/// Round-trips every `backend-input` file under `dir`, and checks that every
/// build folder has one.
///
/// A build folder is any folder of the tree outside `fe/` that holds a dump
/// file. Without `backend-input.json` it is an ERROR, unless its
/// `manifest.json` lists no `backend-input` stage. A tree with no build folder
/// at all is an ERROR: an empty run must never pass.
///
/// # Errors
/// Returns a message when the tree cannot be read.
pub fn run(dir: &Path) -> Result<Report, String> {
    let tree = oracle::read_tree(dir)?;
    let mut report = Report::default();
    let mut builds: BTreeMap<&str, (Option<&Path>, Option<&Path>)> = BTreeMap::new();
    let mut linked: Vec<(&str, &Path)> = Vec::new();
    for (rel, file) in &tree {
        if rel.contains("/modules/") && rel.ends_with(".ir.json") {
            report.files += 1;
            report.module_ir += 1;
            match fs::read_to_string(&file.path)
                .map_err(|e| format!("cannot read: {e}"))
                .and_then(|text| module_ir_roundtrip(&text))
            {
                Ok(()) => report.ok += 1,
                Err(detail) => report.module_ir_error(rel, &detail),
            }
        }
        // `fe/` is the front end's own dumps; a file at the root (`sha256.txt`) belongs to no build.
        if file.id.is_empty() || file.id == "fe" || file.id.starts_with("fe/") {
            continue;
        }
        let entry = builds.entry(file.id.as_str()).or_default();
        match rel.rsplit('/').next().unwrap_or(rel) {
            "backend-input.json" => entry.0 = Some(file.path.as_path()),
            "manifest.json" => entry.1 = Some(file.path.as_path()),
            "linked.json" => linked.push((file.id.as_str(), file.path.as_path())),
            _ => {}
        }
    }
    for (id, path) in linked {
        report.files += 1;
        report.linked += 1;
        match fs::read_to_string(path)
            .map_err(|e| format!("cannot read: {e}"))
            .and_then(|text| mos_ir::roundtrip_linked(&text))
        {
            Ok(()) => report.ok += 1,
            Err(detail) => report.linked_error(id, &detail),
        }
    }
    for (id, (input, manifest)) in builds {
        if let Some(path) = input {
            report.files += 1;
            let result = fs::read_to_string(path)
                .map_err(|e| format!("cannot read: {e}"))
                .and_then(|text| mos_ir::roundtrip(&text));
            match result {
                Ok(()) => report.ok += 1,
                Err(detail) => report.error(id, &detail),
            }
            continue;
        }
        match manifest.map(manifest_expects) {
            Some(Ok(false)) => report.not_expected += 1,
            Some(Ok(true)) => report.error(id, "missing: manifest.json lists the stage"),
            Some(Err(detail)) => report.error(id, &format!("missing, and {detail}")),
            None => report.error(id, "missing: no manifest.json to say it is not expected"),
        }
    }
    if report.files + report.not_expected + report.errors == 0 {
        report.error(
            &dir.display().to_string(),
            "none found: nothing to round-trip",
        );
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("xtask-roundtrip-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fixtures() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/mos-ir/tests/fixtures")
    }

    #[test]
    fn the_fixture_tree_round_trips() {
        let report = run(&fixtures()).unwrap();
        assert_eq!(report.errors, 0, "{:?}", report.lines);
        assert!(report.files >= 3);
        assert_eq!(report.exit_code(), 0);
    }

    #[test]
    fn an_unknown_field_is_one_error_line() {
        let dir = scratch("unknown");
        let build = dir.join("p/c64");
        fs::create_dir_all(&build).unwrap();
        let text =
            fs::read_to_string(fixtures().join("hello-world-c64/backend-input.json")).unwrap();
        let text = text.replacen("\"debug\"", "\"surprise\": 1,\n  \"debug\"", 1);
        fs::write(build.join("backend-input.json"), text).unwrap();
        // files of other stages are not read
        fs::write(build.join("diagnostics.json"), "not json").unwrap();
        let report = run(&dir).unwrap();
        assert_eq!(report.errors, 1);
        assert_eq!((report.files, report.ok), (1, 0));
        assert!(report.lines[0].starts_with("ERROR p/c64 backend-input "));
        assert!(report.lines[0].contains("surprise"));
        assert_eq!(report.exit_code(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_non_canonical_file_is_an_error() {
        let dir = scratch("format");
        let build = dir.join("p/c64");
        fs::create_dir_all(&build).unwrap();
        let text =
            fs::read_to_string(fixtures().join("hello-world-c64/backend-input.json")).unwrap();
        fs::write(
            build.join("backend-input.json"),
            text.replacen("\"debug\": false", "\"debug\":false", 1),
        )
        .unwrap();
        let report = run(&dir).unwrap();
        assert_eq!(report.errors, 1);
        assert!(report.lines[0].contains("bytes differ at line"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn module_ir_dumps_round_trip_and_a_stray_field_is_an_error() {
        let dir = scratch("module-ir");
        let golden = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../crates/front/tests/fixtures/front-dump/golden/modules/project");
        let text = fs::read_to_string(golden.join("Window.8bx.ir.json")).unwrap();
        write(&dir.join("p/c64/modules/project/Window.8bx.ir.json"), &text);
        write(&dir.join("sha256.txt"), "0\n");
        let report = run(&dir).unwrap();
        assert_eq!((report.module_ir, report.ok), (1, 1), "{:?}", report.lines);
        let bad = text.replacen("\"consts\"", "\"surprise\": 1,\n  \"consts\"", 1);
        write(&dir.join("p/c64/modules/project/Window.8bx.ir.json"), &bad);
        let report = run(&dir).unwrap();
        assert!(
            report.lines.iter().any(|l| l
                .starts_with("ERROR p/c64/modules/project/Window.8bx.ir.json module-ir ")
                && l.contains("surprise")),
            "{:?}",
            report.lines
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_tree_is_an_error() {
        let dir = scratch("empty");
        let report = run(&dir).unwrap();
        assert_eq!((report.files, report.errors), (0, 1));
        assert_eq!(report.exit_code(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn a_build_folder_without_backend_input_is_an_error_unless_the_manifest_says_so() {
        let dir = scratch("manifest");
        // no manifest at all
        write(&dir.join("a/c64/diagnostics.json"), "{}");
        // manifest lists the stage but the file is gone
        write(
            &dir.join("b/c64/manifest.json"),
            r#"{"stages": ["linked-ir", "backend-input"]}"#,
        );
        // a web build: no backend-input expected
        write(
            &dir.join("c/web/manifest.json"),
            r#"{"stages": ["linked-ir", "wasm-input"]}"#,
        );
        // a broken manifest
        write(&dir.join("d/pet/manifest.json"), "nope");
        // front-end dumps are not builds
        write(&dir.join("fe/toolchain/x/tokens.json"), "[]");
        // one good build
        let text =
            fs::read_to_string(fixtures().join("hello-world-c64/backend-input.json")).unwrap();
        write(&dir.join("e/c64/backend-input.json"), &text);
        let report = run(&dir).unwrap();
        assert_eq!(
            (report.files, report.ok, report.errors, report.not_expected),
            (1, 1, 3, 1),
            "{:?}",
            report.lines
        );
        assert!(
            report
                .lines
                .iter()
                .any(|l| l.starts_with("ERROR a/c64 backend-input missing: no manifest.json"))
        );
        assert!(
            report
                .lines
                .iter()
                .any(|l| l.starts_with("ERROR b/c64 backend-input missing: manifest.json lists"))
        );
        assert!(report.lines.iter().any(|l| {
            l.starts_with("ERROR d/pet backend-input missing, and manifest.json invalid")
        }));
        assert!(
            report
                .summary()
                .starts_with("roundtrip: 1 files, 1 OK, 3 ERROR")
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
