//! Reads a dump directory into a flat list of files with corpus id and stage.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// One file of a dump tree.
#[derive(Debug, Clone)]
pub struct DumpFile {
    /// Corpus id: the directory of the build (or `fe/<tokpath>`).
    pub id: String,
    /// Stage id (`link`, `bytes`, `tokens`, ...).
    pub stage: String,
    /// Display form of the stage: module files carry their token path.
    pub label: String,
    pub path: PathBuf,
}

/// Reads every file under `root`, keyed by its relative path.
///
/// # Errors
/// Returns the I/O error text when a directory cannot be read.
pub fn read_tree(root: &Path) -> Result<BTreeMap<String, DumpFile>, String> {
    let mut out = BTreeMap::new();
    walk(root, "", &mut out)?;
    Ok(out)
}

fn walk(dir: &Path, rel: &str, out: &mut BTreeMap<String, DumpFile>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let path = entry.path();
        if path.is_dir() {
            walk(&path, &child, out)?;
        } else {
            out.insert(child.clone(), classify(&child, path));
        }
    }
    Ok(())
}

fn file_stage(name: &str) -> String {
    let stage = match name {
        "linked.json" => "linked-ir",
        "bytes.hex" => "bytes",
        "error.txt" => "error",
        "ir.json" => "module-ir",
        other => other.split('.').next().unwrap_or(other),
    };
    stage.to_string()
}

fn classify(rel: &str, path: PathBuf) -> DumpFile {
    let parts: Vec<&str> = rel.split('/').collect();
    let name = parts[parts.len() - 1];
    if let Some(i) = parts[..parts.len() - 1].iter().position(|p| *p == "modules") {
        let module = parts[i + 1..].join("/");
        let (tokpath, stage) = [(".tokens.json", "tokens"), (".ast.json", "ast"), (".ir.json", "module-ir")]
            .iter()
            .find_map(|(suffix, stage)| module.strip_suffix(suffix).map(|t| (t.to_string(), (*stage).to_string())))
            .unwrap_or_else(|| (module.clone(), file_stage(name)));
        return DumpFile {
            id: parts[..i].join("/"),
            label: format!("{stage}({tokpath})"),
            stage,
            path,
        };
    }
    let stage = file_stage(name);
    DumpFile {
        id: parts[..parts.len() - 1].join("/"),
        label: stage.clone(),
        stage,
        path,
    }
}
