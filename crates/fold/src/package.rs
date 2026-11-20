//! Port of packages/compiler/src/fold/package.mjs:1-37
//!
//! `#package("version")` reads the program's own package.json: the nearest
//! one above the file the call is written in, the way Node resolves a
//! module's package. Read every time, not cached: the language server lives
//! across a version bump.

use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::facts::Json;

/// The fields a program may read. Anything else is refused by name.
pub const PACKAGE_FIELDS: [&str; 2] = ["name", "version"];

/// What `nearestPackage` found: the parsed package.json, or the error from
/// reading or parsing it. Serializes as `{path, json}` or `{path, error}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum NearestPackage {
    Found { path: String, json: Json },
    Failed { path: String, error: String },
}

/// `path.resolve(dir)`: absolute against the working directory, `.` and `..`
/// folded away, no trailing separator.
fn resolve(dir: &str) -> PathBuf {
    let start = if Path::new(dir).is_absolute() {
        PathBuf::new()
    } else {
        env::current_dir().unwrap_or_default()
    };
    let mut out = start;
    for component in Path::new(dir).components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {
                out = PathBuf::new();
                out.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

/// The nearest package.json at or above `dir`, parsed, or `None` when there
/// is none up to the filesystem root. The error text of a package.json that
/// cannot be read or parsed is this side's own wording, not V8's.
#[must_use]
pub fn nearest_package(dir: &str) -> Option<NearestPackage> {
    let mut current = resolve(dir);
    loop {
        let candidate = current.join("package.json");
        let path = candidate.to_string_lossy().into_owned();
        if candidate.exists() {
            let parsed = fs::read(&candidate)
                .map_err(|e| e.to_string())
                .and_then(|bytes| {
                    let text = String::from_utf8_lossy(&bytes);
                    serde_json::from_str::<Json>(&text).map_err(|e| e.to_string())
                });
            return Some(match parsed {
                Ok(json) => NearestPackage::Found { path, json },
                Err(error) => NearestPackage::Failed { path, error },
            });
        }
        current = current.parent()?.to_path_buf();
    }
}
