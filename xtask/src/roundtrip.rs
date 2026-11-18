//! `cargo xtask roundtrip <dir>`: every `backend-input.json` of a dump tree is
//! read into the `mos-ir` types and written back; the bytes must match.

use std::fs;
use std::path::Path;

/// Output lines and counts of one run, in the style of `oracle::Report`.
#[derive(Debug, Default)]
pub struct Report {
    pub lines: Vec<String>,
    pub files: usize,
    pub errors: usize,
}

impl Report {
    pub fn summary(&self) -> String {
        format!("roundtrip: {} files, {} ERROR", self.files, self.errors)
    }

    pub fn exit_code(&self) -> u8 {
        u8::from(self.errors > 0)
    }
}

/// Round-trips every `backend-input` file under `dir`.
///
/// A tree with no such file is an ERROR: an empty run must never pass.
///
/// # Errors
/// Returns a message when the tree cannot be read.
pub fn run(dir: &Path) -> Result<Report, String> {
    let tree = oracle::read_tree(dir)?;
    let mut report = Report::default();
    for file in tree.values().filter(|f| f.stage == "backend-input") {
        report.files += 1;
        let result = fs::read_to_string(&file.path)
            .map_err(|e| format!("cannot read: {e}"))
            .and_then(|text| mos_ir::roundtrip(&text));
        if let Err(detail) = result {
            report.errors += 1;
            report
                .lines
                .push(format!("ERROR {} backend-input {detail}", file.id));
        }
    }
    if report.files == 0 {
        report.errors += 1;
        report.lines.push(format!(
            "ERROR {} backend-input none found: nothing to round-trip",
            dir.display()
        ));
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
        assert!(report.files >= 4);
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
        fs::write(build.join("linked.json"), "not json").unwrap();
        let report = run(&dir).unwrap();
        assert_eq!(report.errors, 1);
        assert_eq!(report.files, 1);
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
    fn an_empty_tree_is_an_error() {
        let dir = scratch("empty");
        let report = run(&dir).unwrap();
        assert_eq!((report.files, report.errors), (0, 1));
        assert_eq!(report.exit_code(), 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
