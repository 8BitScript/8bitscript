//! Port of packages/compiler/src/fold/package.mjs:1-37
//!
//! `#package("version")` reads the program's own package.json: the nearest
//! one above the file the call is written in, the way Node resolves a
//! module's package. Read every time, not cached: the language server lives
//! across a version bump.

use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::facts::Json;

/// The fields a program may read. Anything else is refused by name.
pub const PACKAGE_FIELDS: [&str; 2] = ["name", "version"];

/// What `nearestPackage` found: the parsed package.json, or the error from
/// reading or parsing it.
#[derive(Debug, Clone, PartialEq)]
pub enum NearestPackage {
    Found { path: String, json: Json },
    Failed { path: String, error: String },
}

/// Node's text for a failed `readFileSync` of the common cases (the path is
/// quoted for `ENOENT` and `EACCES`); anything else keeps the OS wording.
fn read_error(error: &std::io::Error, path: &str) -> String {
    match error.raw_os_error() {
        Some(2) => format!("ENOENT: no such file or directory, open '{path}'"),
        Some(13) => format!("EACCES: permission denied, open '{path}'"),
        Some(21) => "EISDIR: illegal operation on a directory, read".to_string(),
        _ => error.to_string(),
    }
}

impl NearestPackage {
    /// The JS object: `{path, json}` or `{path, error}`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut map = indexmap::IndexMap::new();
        match self {
            NearestPackage::Found { path, json } => {
                map.insert("path".to_string(), Json::String(path.clone()));
                map.insert("json".to_string(), json.clone());
            }
            NearestPackage::Failed { path, error } => {
                map.insert("path".to_string(), Json::String(path.clone()));
                map.insert("error".to_string(), Json::String(error.clone()));
            }
        }
        Json::Object(map)
    }
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
/// cannot be read is Node's for ENOENT, EACCES and EISDIR; a parse failure
/// gets the nearest V8 wording.
#[must_use]
pub fn nearest_package(dir: &str) -> Option<NearestPackage> {
    let mut current = resolve(dir);
    loop {
        let candidate = current.join("package.json");
        let path = candidate.to_string_lossy().into_owned();
        if candidate.exists() {
            let parsed = fs::read(&candidate)
                .map_err(|e| read_error(&e, &path))
                .and_then(|bytes| {
                    let text = String::from_utf8_lossy(&bytes);
                    Json::parse(&text)
                });
            return Some(match parsed {
                Ok(json) => NearestPackage::Found { path, json },
                Err(error) => NearestPackage::Failed { path, error },
            });
        }
        current = current.parent()?.to_path_buf();
    }
}

#[cfg(test)]
mod tests {
    use super::read_error;

    #[test]
    fn read_error_names_the_path_like_node() {
        let e = std::io::Error::from_raw_os_error(2);
        assert_eq!(
            read_error(&e, "/a/package.json"),
            "ENOENT: no such file or directory, open '/a/package.json'"
        );
        let e = std::io::Error::from_raw_os_error(13);
        assert_eq!(
            read_error(&e, "/a/package.json"),
            "EACCES: permission denied, open '/a/package.json'"
        );
        let e = std::io::Error::from_raw_os_error(21);
        assert_eq!(
            read_error(&e, "/a/package.json"),
            "EISDIR: illegal operation on a directory, read"
        );
    }
}
