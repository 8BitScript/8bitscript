//! `cargo xtask wasm`: build `front.wasm` (port spec 4.1) reproducibly.
//!
//! The module is committed (`packages/compiler/wasm/front.wasm`). Without
//! options the build replaces it; `--out <file>` writes elsewhere; `--check`
//! rebuilds and fails when the committed file differs (the CI `cmp` job).

use std::path::{Path, PathBuf};
use std::process::Command;

const TARGET: &str = "wasm32-unknown-unknown";
const COMMITTED: &str = "packages/compiler/wasm/front.wasm";

enum Mode {
    Replace,
    Out(PathBuf),
    Check,
}

fn parse_args(args: &[String]) -> Result<Mode, String> {
    match args {
        [] => Ok(Mode::Replace),
        [flag] if flag == "--check" => Ok(Mode::Check),
        [flag, file] if flag == "--out" => Ok(Mode::Out(PathBuf::from(file))),
        _ => Err("usage: cargo xtask wasm [--out <file> | --check]".to_string()),
    }
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn home(var: &str, fallback: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(fallback)))
}

/// The flags that keep absolute paths out of the module, so two checkouts in
/// different places build the same bytes.
fn rustflags(root: &Path) -> String {
    let mut flags = vec![format!("--remap-path-prefix={}=/src", root.display())];
    if let Some(cargo) = home("CARGO_HOME", ".cargo") {
        flags.push(format!("--remap-path-prefix={}=/cargo", cargo.display()));
    }
    if let Some(rustup) = home("RUSTUP_HOME", ".rustup") {
        flags.push(format!("--remap-path-prefix={}=/rustup", rustup.display()));
    }
    flags.join(" ")
}

fn build(root: &Path) -> Result<Vec<u8>, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let status = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .current_dir(&root)
        .env("RUSTFLAGS", rustflags(&root))
        .args([
            "build",
            "--release",
            "--locked",
            "-p",
            "front-wasm",
            "--target",
            TARGET,
        ])
        .status()
        .map_err(|e| format!("cargo: {e}"))?;
    if !status.success() {
        return Err("cargo build failed".to_string());
    }
    let target_dir = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("target"));
    let built = target_dir.join(TARGET).join("release/front_wasm.wasm");
    std::fs::read(&built).map_err(|e| format!("{}: {e}", built.display()))
}

pub fn run(args: &[String]) -> Result<(), String> {
    let mode = parse_args(args)?;
    let root = root();
    let bytes = build(&root)?;
    let committed = root.join(COMMITTED);
    match mode {
        Mode::Check => {
            let have = std::fs::read(&committed).map_err(|e| format!("{COMMITTED}: {e}"))?;
            if have == bytes {
                println!("{COMMITTED} matches a rebuild ({} bytes)", bytes.len());
                Ok(())
            } else {
                Err(format!(
                    "{COMMITTED} differs from a rebuild ({} bytes committed, {} rebuilt); run `cargo xtask wasm` and commit it",
                    have.len(),
                    bytes.len()
                ))
            }
        }
        Mode::Replace => write(&committed, &bytes),
        Mode::Out(file) => write(&file, &bytes),
    }
}

fn write(file: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::write(file, bytes).map_err(|e| format!("{}: {e}", file.display()))?;
    println!("wrote {} ({} bytes)", file.display(), bytes.len());
    Ok(())
}
