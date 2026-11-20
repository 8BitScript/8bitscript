//! The file system `i18n/index.mjs` reads (`existsSync`, `readdirSync`, `readFileSync`), behind
//! a trait so the tap and the fixture tests can map a path token (`<project>`) to a real
//! directory without the catalog code knowing.

use std::fs;
use std::path::PathBuf;

/// What the catalog code asks of the file system. Paths are the strings the JS passes.
pub trait CatalogFs {
    /// `existsSync`.
    fn exists(&self, path: &str) -> bool;
    /// `readdirSync`: the entry names, or `None` where JS throws.
    fn read_dir(&self, path: &str) -> Option<Vec<String>>;
    /// `readFileSync(path, 'utf8')`: invalid UTF-8 becomes U+FFFD, a failure is Node's
    /// `CODE: text` for it.
    fn read_to_string(&self, path: &str) -> Result<String, String>;
}

/// The real file system.
#[derive(Clone, Copy, Debug, Default)]
pub struct RealFs;

impl CatalogFs for RealFs {
    fn exists(&self, path: &str) -> bool {
        PathBuf::from(path).exists()
    }

    fn read_dir(&self, path: &str) -> Option<Vec<String>> {
        let mut names = Vec::new();
        for entry in fs::read_dir(path).ok()? {
            // A name that is not UTF-16 text cannot be a locale file either way.
            if let Ok(name) = entry.ok()?.file_name().into_string() {
                names.push(name);
            }
        }
        Some(names)
    }

    fn read_to_string(&self, path: &str) -> Result<String, String> {
        match fs::read(path) {
            Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
            Err(error) => Err(node_error(&error, path)),
        }
    }
}

/// Node's message for a failed read: `CODE: text, open 'path'`.
fn node_error(error: &std::io::Error, path: &str) -> String {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => format!("ENOENT: no such file or directory, open '{path}'"),
        ErrorKind::PermissionDenied => format!("EACCES: permission denied, open '{path}'"),
        ErrorKind::IsADirectory => "EISDIR: illegal operation on a directory, read".to_string(),
        _ => format!("{error}, open '{path}'"),
    }
}

/// The real file system seen through path tokens: a path that starts with a token (as a whole
/// first segment) is read under that token's directory. Other paths are read as they are.
#[derive(Clone, Debug, Default)]
pub struct RootedFs {
    roots: Vec<(String, PathBuf)>,
}

impl RootedFs {
    /// No tokens yet.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads `token/...` under `dir`.
    #[must_use]
    pub fn with(mut self, token: &str, dir: impl Into<PathBuf>) -> Self {
        self.roots.push((token.to_string(), dir.into()));
        self
    }

    fn map(&self, path: &str) -> String {
        for (token, dir) in &self.roots {
            if let Some(rest) = path.strip_prefix(token.as_str()) {
                if rest.is_empty() {
                    return dir.to_string_lossy().into_owned();
                }
                if let Some(rest) = rest.strip_prefix('/') {
                    return dir.join(rest).to_string_lossy().into_owned();
                }
            }
        }
        path.to_string()
    }

    /// Whether any token is set.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.roots.is_empty()
    }
}

impl CatalogFs for RootedFs {
    fn exists(&self, path: &str) -> bool {
        RealFs.exists(&self.map(path))
    }

    fn read_dir(&self, path: &str) -> Option<Vec<String>> {
        RealFs.read_dir(&self.map(path))
    }

    fn read_to_string(&self, path: &str) -> Result<String, String> {
        // The message names the path JS was given, not the mapped one.
        RealFs
            .read_to_string(&self.map(path))
            .map_err(|message| message.replace(&self.map(path), path))
    }
}
