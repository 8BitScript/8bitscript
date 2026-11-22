//! `xtask corpus-tap <out-dir> [--front] [--fn f]... [--jobs N]`: dump the JS corpus with
//! tap recording, then replay the tap in Rust, all in one process.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::tap::{Report, replay_dir};

pub const USAGE: &str =
    "usage: cargo xtask corpus-tap <out-dir> [--front] [--fn <name>]... [--jobs N]";

/// The parsed command line.
#[derive(Debug, PartialEq, Eq)]
pub struct Args {
    pub out: PathBuf,
    pub front: bool,
    pub only: Vec<String>,
    pub jobs: Option<usize>,
}

/// The programs the command runs; tests point them at stubs.
pub struct Programs<'a> {
    pub node: &'a str,
    pub pnpm: &'a str,
}

/// Parses the arguments after `corpus-tap`.
pub fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut out = None;
    let mut front = false;
    let mut only = Vec::new();
    let mut jobs = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--front" => front = true,
            "--fn" => only.push(it.next().cloned().ok_or("--fn needs a value")?),
            "--jobs" => {
                let value = it.next().ok_or("--jobs needs a value")?;
                match value.parse::<usize>() {
                    Ok(n) if n > 0 => jobs = Some(n),
                    _ => return Err(format!("--jobs needs a positive number, got `{value}`")),
                }
            }
            flag if flag.starts_with("--") => {
                return Err(format!("unknown option `{flag}`\n{USAGE}"));
            }
            path if out.is_none() => out = Some(PathBuf::from(path)),
            _ => return Err(USAGE.to_string()),
        }
    }
    Ok(Args {
        out: out.ok_or_else(|| USAGE.to_string())?,
        front,
        only,
        jobs,
    })
}

/// Runs `program` in `root` with its output streamed to ours; fails on a missing program or a bad exit.
fn child(program: &str, args: &[String], root: &Path) -> Result<(), String> {
    let status = Command::new(program)
        .args(args)
        .current_dir(root)
        .status()
        .map_err(|e| {
            if e.kind() == ErrorKind::NotFound {
                format!("`{program}` was not found on PATH; install it first")
            } else {
                format!("cannot run `{program}`: {e}")
            }
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("`{program}` failed ({status})"))
    }
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| (*p).to_string()).collect()
}

/// Installs dependencies if needed, then dumps the corpus with the tap into `<out>/dump`
/// and `<out>/tap` (or `<out>/front`). Returns the directory the tap was written to.
pub fn dump(args: &Args, root: &Path, programs: &Programs) -> Result<PathBuf, String> {
    let out = std::path::absolute(&args.out).map_err(|e| format!("{}: {e}", args.out.display()))?;
    if !root.join("node_modules").exists() {
        child(
            programs.pnpm,
            &strings(&["install", "--frozen-lockfile"]),
            root,
        )?;
    }
    let (flag, name) = if args.front {
        ("--front-tap", "front")
    } else {
        ("--tap", "tap")
    };
    let tap = out.join(name);
    let mut node_args = strings(&["scripts/oracle/corpus.mjs", "--out"]);
    node_args.push(out.join("dump").display().to_string());
    node_args.push(flag.to_string());
    node_args.push(tap.display().to_string());
    if let Some(jobs) = args.jobs {
        node_args.push("--jobs".to_string());
        node_args.push(jobs.to_string());
    }
    child(programs.node, &node_args, root)?;
    Ok(tap)
}

/// Replays `tap`, once per `--fn` (once over everything when none is given), into one report.
pub fn replay(args: &Args, tap: &Path) -> Result<Report, String> {
    let filters: Vec<Option<&str>> = if args.only.is_empty() {
        vec![None]
    } else {
        args.only.iter().map(|n| Some(n.as_str())).collect()
    };
    let mut total = Report::default();
    for only in filters {
        let report = replay_dir(tap, only, args.front)?;
        total.lines.extend(report.lines);
        total.calls += report.calls;
        total.errors += report.errors;
        total.skips += report.skips;
    }
    Ok(total)
}

/// The whole command with injectable programs and repo root.
pub fn run(args: &[String], root: &Path, programs: &Programs) -> Result<u8, String> {
    let args = parse_args(args)?;
    let tap = dump(&args, root, programs)?;
    let report = replay(&args, &tap)?;
    for line in &report.lines {
        println!("{line}");
    }
    println!("{}", report.summary());
    Ok(report.exit_code())
}

/// The command: the repo's own `node` and `pnpm`, run from the repo root.
pub fn command(args: &[String]) -> Result<u8, String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    run(
        args,
        &root,
        &Programs {
            node: "node",
            pnpm: "pnpm",
        },
    )
}
