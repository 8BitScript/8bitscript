//! Repo automation entry point. `roundtrip` arrives in a later unit.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "usage: cargo xtask compare <js-dir> <other-dir> [--stages a,b] [--corpus <glob>] [--divergences <file>]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("compare") => match compare(&args[1..]) {
            Ok(code) => ExitCode::from(code),
            Err(message) => {
                eprintln!("xtask: {message}");
                ExitCode::from(2)
            }
        },
        Some(command) => {
            eprintln!("xtask: unknown command `{command}`");
            ExitCode::from(2)
        }
        None => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn compare(args: &[String]) -> Result<u8, String> {
    let mut dirs = Vec::new();
    let mut opts = oracle::Options::default();
    let mut divergences: Option<PathBuf> = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match arg.as_str() {
            "--stages" => {
                let v = value("--stages")?;
                opts.stages = Some(v.split(',').map(str::to_string).collect());
            }
            "--corpus" => opts.corpus = Some(value("--corpus")?),
            "--divergences" => divergences = Some(PathBuf::from(value("--divergences")?)),
            flag if flag.starts_with("--") => {
                return Err(format!("unknown option `{flag}`\n{USAGE}"));
            }
            dir => dirs.push(PathBuf::from(dir)),
        }
    }
    let [js, other] = dirs.as_slice() else {
        return Err(USAGE.to_string());
    };
    let file = divergences.unwrap_or_else(|| {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../oracle/divergences.toml")
    });
    opts.divergences =
        std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
    let report = oracle::compare(js, other, &opts)?;
    for line in &report.lines {
        println!("{line}");
    }
    println!("{}", report.summary());
    Ok(report.exit_code())
}
