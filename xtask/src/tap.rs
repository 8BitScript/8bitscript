//! `xtask tap <dir> [--fn f]`: replay the records the JS tap wrote.

use std::fs;
use std::path::{Path, PathBuf};

use mos::build::Counters;
use mos::tap::Replay;
use serde_json::Value;

pub const USAGE: &str = "usage: cargo xtask tap <dir> [--fn <name>]";

/// What a replay of a whole directory found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub lines: Vec<String>,
    pub calls: usize,
    pub errors: usize,
    pub skips: usize,
}

impl Report {
    #[must_use]
    pub fn summary(&self) -> String {
        format!(
            "tap: {} calls, {} ERROR, {} SKIP",
            self.calls, self.errors, self.skips
        )
    }

    #[must_use]
    pub fn exit_code(&self) -> u8 {
        u8::from(self.errors > 0)
    }
}

/// The replay function: the JS function name, its record and the build's counters.
pub type Replayer<'a> = &'a dyn Fn(&str, &Value, &mut Counters) -> Option<Replay>;

/// Parses the arguments after `tap` into the directory and the `--fn` filter.
pub fn parse_args(args: &[String]) -> Result<(PathBuf, Option<String>), String> {
    let mut dir = None;
    let mut only = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--fn" => only = Some(it.next().cloned().ok_or("--fn needs a value")?),
            flag if flag.starts_with("--") => {
                return Err(format!("unknown option `{flag}`\n{USAGE}"));
            }
            path if dir.is_none() => dir = Some(PathBuf::from(path)),
            _ => return Err(USAGE.to_string()),
        }
    }
    Ok((dir.ok_or_else(|| USAGE.to_string())?, only))
}

type Build = (String, Vec<PathBuf>);

/// Every directory under `base` that holds `.jsonl` files, as `(corpus id, files)`
/// sorted by id. The id is the path relative to `base`, with `/` separators.
fn builds(base: &Path) -> Result<Vec<Build>, String> {
    let mut out = Vec::new();
    collect(base, base, &mut out)?;
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

fn collect(base: &Path, dir: &Path, out: &mut Vec<Build>) -> Result<(), String> {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            dirs.push(path);
        } else if path.extension().is_some_and(|x| x == "jsonl") {
            files.push(path);
        }
    }
    if !files.is_empty() {
        files.sort();
        let relative = dir.strip_prefix(base).map_err(|e| e.to_string())?;
        let id: Vec<String> = relative
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        out.push((id.join("/"), files));
    }
    for sub in dirs {
        collect(base, &sub, out)?;
    }
    Ok(())
}

/// The records of one build, in `seq` order (files in name order, then a stable sort).
fn records(files: &[PathBuf]) -> Result<Vec<Value>, String> {
    let mut rows = Vec::new();
    for file in files {
        let text = fs::read_to_string(file).map_err(|e| format!("{}: {e}", file.display()))?;
        for (n, line) in text.lines().filter(|l| !l.trim().is_empty()).enumerate() {
            let row: Value = serde_json::from_str(line)
                .map_err(|e| format!("{}: record {}: {e}", file.display(), n + 1))?;
            rows.push(row);
        }
    }
    rows.sort_by_key(|r| r.get("seq").and_then(Value::as_u64).unwrap_or(u64::MAX));
    Ok(rows)
}

fn short(value: &Value) -> String {
    let text = value.to_string();
    match text.char_indices().nth(120) {
        Some((end, _)) => format!("{}...", &text[..end]),
        None => text,
    }
}

/// Replays every record under `base` (only function `only` when given).
pub fn run(base: &Path, only: Option<&str>, replay: Replayer) -> Result<Report, String> {
    let mut report = Report::default();
    for (id, files) in builds(base)? {
        let mut counters = Counters::default();
        for row in records(&files)? {
            let name = row.get("fn").and_then(Value::as_str).unwrap_or("");
            let seq = row.get("seq").and_then(Value::as_u64).unwrap_or(0);
            match name {
                "reset:lower" => counters.lower = 0,
                "reset:relax" => counters.relax = 0,
                _ if only.is_some_and(|f| f != name) => {}
                _ => {
                    report.calls += 1;
                    match replay(name, &row, &mut counters) {
                        Some(Replay::Match) => {}
                        Some(Replay::Skip) => report.skips += 1,
                        Some(Replay::Mismatch(pointer, js, rust)) => {
                            report.errors += 1;
                            report.lines.push(format!(
                                "ERROR {id} {name}#{seq} {pointer}: js={} rust={}",
                                short(&js),
                                short(&rust)
                            ));
                        }
                        None => {
                            report.errors += 1;
                            report
                                .lines
                                .push(format!("ERROR {id} {name}#{seq}: not a tapped function"));
                        }
                    }
                }
            }
        }
    }
    Ok(report)
}

/// The command: replay with the real ports, print, return the exit code.
pub fn command(args: &[String]) -> Result<u8, String> {
    let (dir, only) = parse_args(args)?;
    let report = run(&dir, only.as_deref(), &mos::tap::replay)?;
    for line in &report.lines {
        println!("{line}");
    }
    println!("{}", report.summary());
    Ok(report.exit_code())
}
