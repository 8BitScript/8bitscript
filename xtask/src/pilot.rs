//! `cargo xtask pilot <js dump dir> --out <dir> [--toolchain <dir>] [--game <id>=<dir>]...`:
//! the native 6502 backend's stage dumps in the JS layout, for `xtask compare`.
//!
//! Every build folder of the JS dump that holds a `backend-input.json` is built from it, and
//! the folder of the same id under `--out` gets `link.json` (after a successful link),
//! `bytes.hex`, `size-report.json` (only when the build asked for a report) or `error.txt`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

/// What one pilot run did.
#[derive(Debug, Default)]
pub struct Summary {
    pub built: usize,
    pub refused: usize,
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

/// `link.json`: `{symbols: [[name, address], ...], layout, memory}`.
fn link_value(linked: &mos::link::Linked) -> Result<Value, String> {
    let symbols: Vec<Value> = linked.symbols.iter().map(|(n, a)| json!([n, a])).collect();
    Ok(json!({
        "symbols": symbols,
        "layout": serde_json::to_value(&linked.layout).map_err(|e| e.to_string())?,
        "memory": serde_json::to_value(linked.memory).map_err(|e| e.to_string())?,
    }))
}

/// Builds every `backend-input.json` of `js_dir` and writes the dumps under `out`.
///
/// # Errors
/// An unreadable input or an unwritable output; a build that refuses is not an error here, its
/// `error.txt` is the dump.
pub fn run(
    js_dir: &Path,
    out: &Path,
    toolchain: &Path,
    games: &BTreeMap<String, PathBuf>,
) -> Result<Summary, String> {
    let tree = oracle::read_tree(js_dir)?;
    let toolchain_text = toolchain.to_string_lossy().into_owned();
    let mut summary = Summary::default();
    for (rel, file) in &tree {
        if file.id.is_empty() || file.id == "fe" || file.id.starts_with("fe/") {
            continue;
        }
        if rel.rsplit('/').next() != Some("backend-input.json") {
            continue;
        }
        let text = fs::read_to_string(&file.path).map_err(|e| format!("{rel}: {e}"))?;
        let input = mos_ir::parse(&text).map_err(|e| format!("{rel}: {e}"))?;
        let project = file.id.split('/').next().unwrap_or("");
        let project_dir = games
            .get(project)
            .cloned()
            .unwrap_or_else(|| toolchain.join("packages").join(project));
        let project_text = project_dir.to_string_lossy().into_owned();
        let roots = oracle::Roots {
            toolchain: &toolchain_text,
            project: &project_text,
        };
        let dir = out.join(&file.id);
        match mos::build::build(&input, &roots) {
            Ok(built) => {
                write(
                    &dir.join("link.json"),
                    &oracle::canonical_json(&link_value(&built.link)?),
                )?;
                write(&dir.join("bytes.hex"), &oracle::hex_dump(&built.bytes))?;
                if let Some(report) = &built.size_report {
                    let value = serde_json::to_value(report).map_err(|e| e.to_string())?;
                    write(
                        &dir.join("size-report.json"),
                        &oracle::canonical_json(&value),
                    )?;
                }
                summary.built += 1;
            }
            Err(error) => {
                if let Some(linked) = &error.link {
                    write(
                        &dir.join("link.json"),
                        &oracle::canonical_json(&link_value(linked)?),
                    )?;
                }
                write(&dir.join("error.txt"), &format!("{}\n", error.message))?;
                summary.refused += 1;
            }
        }
    }
    Ok(summary)
}

/// The command.
///
/// # Errors
/// Bad usage or an unreadable input.
pub fn command(args: &[String]) -> Result<u8, String> {
    const USAGE: &str = "usage: cargo xtask pilot <js dump dir> --out <dir> [--toolchain <dir>] [--game <id>=<dir>]...\n       cargo xtask pilot --corpus <scratch dir>";
    let mut js_dir: Option<PathBuf> = None;
    let mut corpus: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut toolchain = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut games: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match arg.as_str() {
            "--corpus" => corpus = Some(PathBuf::from(value("--corpus")?)),
            "--out" => out = Some(PathBuf::from(value("--out")?)),
            "--toolchain" => toolchain = PathBuf::from(value("--toolchain")?),
            "--game" => {
                let v = value("--game")?;
                let (id, dir) = v.split_once('=').ok_or("--game needs <id>=<dir>")?;
                games.insert(id.to_string(), PathBuf::from(dir));
            }
            other if other.starts_with("--") => return Err(format!("{USAGE}\nunknown {other}")),
            other => js_dir = Some(PathBuf::from(other)),
        }
    }
    if let Some(scratch) = corpus {
        return check_corpus(&scratch, &toolchain, &games);
    }
    let (Some(js_dir), Some(out)) = (js_dir, out) else {
        return Err(USAGE.to_string());
    };
    let summary = run(&js_dir, &out, &toolchain, &games)?;
    println!(
        "pilot: {} built, {} refused",
        summary.built, summary.refused
    );
    Ok(u8::from(summary.built + summary.refused == 0))
}

/// `--corpus <scratch>`: dumps the JS corpus into `<scratch>/dump` (no tap), builds it into
/// `<scratch>/rust` and compares the backend stages, in one process.
fn check_corpus(
    scratch: &Path,
    toolchain: &Path,
    games: &BTreeMap<String, PathBuf>,
) -> Result<u8, String> {
    let scratch = std::path::absolute(scratch).map_err(|e| e.to_string())?;
    let dump = scratch.join("dump");
    if !toolchain.join("node_modules").exists() {
        let installed = std::process::Command::new("pnpm")
            .args(["install", "--frozen-lockfile"])
            .current_dir(toolchain)
            .status()
            .map_err(|e| format!("cannot run pnpm: {e}"))?;
        if !installed.success() {
            return Err(format!("pnpm install failed ({installed})"));
        }
    }
    let status = std::process::Command::new("node")
        .args(["scripts/oracle/corpus.mjs", "--dump", "--out"])
        .arg(&dump)
        .current_dir(toolchain)
        .status()
        .map_err(|e| format!("cannot run node: {e}"))?;
    if !status.success() {
        return Err(format!("the JS dump failed ({status})"));
    }
    let rust = scratch.join("rust");
    let summary = run(&dump, &rust, toolchain, games)?;
    println!(
        "pilot: {} built, {} refused",
        summary.built, summary.refused
    );
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../oracle/divergences.toml");
    let opts = oracle::Options {
        stages: Some(
            ["link", "bytes", "size-report", "error"]
                .map(str::to_string)
                .to_vec(),
        ),
        divergences: fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?,
        ..oracle::Options::default()
    };
    let report = oracle::compare(&dump, &rust, &opts)?;
    for line in report.lines.iter().take(60) {
        println!("{line}");
    }
    println!("{}", report.summary());
    Ok(report.exit_code())
}
