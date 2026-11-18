//! Repo automation entry point. `compare` and `roundtrip` arrive in later units.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some(command) => {
            eprintln!("xtask: unknown command `{command}`");
            ExitCode::from(2)
        }
        None => {
            eprintln!("usage: cargo xtask <command>");
            ExitCode::from(2)
        }
    }
}
