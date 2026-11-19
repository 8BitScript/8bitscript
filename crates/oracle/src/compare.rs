//! `compare`: walks two dump trees and reports the first difference per file.

use std::fs;

use serde_json::Value;

use crate::canon::parse_hex;
use crate::divergence::{Divergence, glob_match, parse};
use crate::tree::{DumpFile, read_tree};

/// Filters and the divergence file for one run.
#[derive(Default)]
pub struct Options {
    pub stages: Option<Vec<String>>,
    pub corpus: Option<String>,
    pub divergences: String,
}

/// The result of a run: output lines and the summary counts.
#[derive(Debug, Default)]
pub struct Report {
    pub lines: Vec<String>,
    pub files: usize,
    pub errors: usize,
    pub accepted: usize,
    pub stale: usize,
    pub invalid: usize,
}

impl Report {
    #[must_use]
    pub fn exit_code(&self) -> u8 {
        u8::from(self.errors + self.stale + self.invalid > 0)
    }

    #[must_use]
    pub fn summary(&self) -> String {
        let invalid = if self.invalid > 0 {
            format!(", {} invalid", self.invalid)
        } else {
            String::new()
        };
        format!(
            "compare: {} files, {} ERROR, {} accepted, {} stale{invalid}",
            self.files, self.errors, self.accepted, self.stale
        )
    }
}

struct Mismatch {
    locator: String,
    detail: String,
}

/// Compares two dump trees.
///
/// # Errors
/// Returns a message when a tree or the divergence file cannot be read or parsed.
pub fn compare(
    js: &std::path::Path,
    other: &std::path::Path,
    opts: &Options,
) -> Result<Report, String> {
    let divergences = parse(&opts.divergences)?;
    let (a, b) = (read_tree(js)?, read_tree(other)?);
    let mut report = Report::default();
    validate(&divergences, &mut report);
    let mut used = vec![false; divergences.len()];

    let mut keys: Vec<&String> = a
        .keys()
        .chain(b.keys().filter(|k| !a.contains_key(*k)))
        .collect();
    keys.sort();
    for key in keys {
        let meta = a.get(key).or_else(|| b.get(key));
        let Some(meta) = meta else { continue };
        if !selected(meta, opts) {
            continue;
        }
        report.files += 1;
        let all = match (a.get(key), b.get(key)) {
            (Some(x), Some(y)) => diff_files(x, y)?,
            (Some(_), None) => vec![Mismatch {
                locator: String::new(),
                detail: "missing in other".into(),
            }],
            _ => vec![Mismatch {
                locator: String::new(),
                detail: "missing in js".into(),
            }],
        };
        if all.is_empty() {
            continue;
        }
        let mut first_unmatched = None;
        for m in &all {
            let hit = divergences.iter().position(|d| {
                !d.reason.trim().is_empty() && d.matches(&meta.id, &meta.stage, &m.locator)
            });
            match hit {
                Some(i) => used[i] = true,
                None => {
                    first_unmatched.get_or_insert(m);
                }
            }
        }
        if let Some(m) = first_unmatched {
            report.errors += 1;
            report.lines.push(format!(
                "ERROR {} {} {}{}",
                meta.id,
                meta.label,
                m.detail,
                more(all.len())
            ));
        } else {
            report.accepted += 1;
        }
    }
    if opts.corpus.is_none() {
        for (d, used) in divergences.iter().zip(used) {
            // A subset run only judges the entries of the stages it compares.
            let in_subset = opts
                .stages
                .as_ref()
                .is_none_or(|s| s.iter().any(|st| glob_match(&d.stage, st)));
            if !used && in_subset {
                report.stale += 1;
                report.lines.push(format!("STALE {} matches nothing", d.id));
            }
        }
    }
    Ok(report)
}

fn validate(divergences: &[Divergence], report: &mut Report) {
    for (i, d) in divergences.iter().enumerate() {
        let problem = if d.reason.trim().chars().count() < 20 {
            Some("reason is missing or shorter than 20 characters")
        } else if d.pointer.is_none() {
            Some("pointer is missing")
        } else if d.id.trim().is_empty() {
            Some("id is empty")
        } else if divergences[..i].iter().any(|e| e.id == d.id) {
            Some("duplicate id")
        } else {
            None
        };
        if let Some(p) = problem {
            report.invalid += 1;
            report.lines.push(format!("INVALID {}: {p}", d.id));
        }
    }
}

fn selected(f: &DumpFile, opts: &Options) -> bool {
    opts.stages.as_ref().is_none_or(|s| s.contains(&f.stage))
        && opts.corpus.as_ref().is_none_or(|g| glob_match(g, &f.id))
}

fn diff_files(x: &DumpFile, y: &DumpFile) -> Result<Vec<Mismatch>, String> {
    let read = |f: &DumpFile| fs::read(&f.path).map_err(|e| format!("{}: {e}", f.path.display()));
    let (ba, bb) = (read(x)?, read(y)?);
    if ba == bb {
        return Ok(Vec::new());
    }
    let (ta, tb) = (
        String::from_utf8_lossy(&ba).into_owned(),
        String::from_utf8_lossy(&bb).into_owned(),
    );
    if x.stage == "bytes"
        && let (Some(ha), Some(hb)) = (parse_hex(&ta), parse_hex(&tb))
    {
        let found = diff_bytes(&ha, &hb);
        if !found.is_empty() {
            return Ok(found);
        }
    }
    if let (Ok(ja), Ok(jb)) = (
        serde_json::from_str::<Value>(&ta),
        serde_json::from_str::<Value>(&tb),
    ) {
        let mut found = Vec::new();
        diff_json(&ja, &jb, &mut String::new(), &mut found);
        if !found.is_empty() {
            return Ok(found
                .into_iter()
                .map(|(ptr, l, r)| Mismatch {
                    detail: format!("{ptr}: js={l} other={r}"),
                    locator: ptr,
                })
                .collect());
        }
    }
    Ok(diff_text(&ta, &tb))
}

fn more(count: usize) -> String {
    if count > 1 {
        format!(" (+{} more)", count - 1)
    } else {
        String::new()
    }
}

fn diff_bytes(a: &[u8], b: &[u8]) -> Vec<Mismatch> {
    let n = a.len().max(b.len());
    let at = |v: &[u8], i: usize| {
        v.get(i)
            .map_or_else(|| "--".to_string(), |x| format!("{x:02x}"))
    };
    (0..n)
        .filter(|&i| a.get(i) != b.get(i))
        .map(|i| {
            let locator = format!("@0x{i:04x}");
            Mismatch {
                detail: format!("{locator}: js={} other={}", at(a, i), at(b, i)),
                locator,
            }
        })
        .collect()
}

fn diff_text(a: &str, b: &str) -> Vec<Mismatch> {
    let (la, lb): (Vec<&str>, Vec<&str>) = (a.split('\n').collect(), b.split('\n').collect());
    let show = |l: Option<&&str>| l.map_or_else(|| "<absent>".to_string(), |s| shorten(s));
    (0..la.len().max(lb.len()))
        .filter(|&i| la.get(i) != lb.get(i))
        .map(|i| {
            let locator = format!("line {}", i + 1);
            Mismatch {
                detail: format!(
                    "{locator}: js={} other={}",
                    show(la.get(i)),
                    show(lb.get(i))
                ),
                locator,
            }
        })
        .collect()
}

fn shorten(s: &str) -> String {
    let mut out: String = s.chars().take(60).collect();
    if s.chars().count() > 60 {
        out.push_str("...");
    }
    out
}

fn show(v: Option<&Value>) -> String {
    v.map_or_else(|| "<absent>".to_string(), |v| shorten(&v.to_string()))
}

fn push_diff(
    out: &mut Vec<(String, String, String)>,
    ptr: &str,
    l: Option<&Value>,
    r: Option<&Value>,
) {
    out.push((ptr.to_string(), show(l), show(r)));
}

fn diff_json(a: &Value, b: &Value, ptr: &mut String, out: &mut Vec<(String, String, String)>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let mut keys: Vec<&String> = x
                .keys()
                .chain(y.keys().filter(|k| !x.contains_key(*k)))
                .collect();
            keys.sort_by(|p, q| jsnum::cmp_utf16(p, q));
            for k in keys {
                let len = ptr.len();
                ptr.push('/');
                ptr.push_str(&k.replace('~', "~0").replace('/', "~1"));
                match (x.get(k), y.get(k)) {
                    (Some(l), Some(r)) => diff_json(l, r, ptr, out),
                    (l, r) => push_diff(out, ptr, l, r),
                }
                ptr.truncate(len);
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            for i in 0..x.len().max(y.len()) {
                let len = ptr.len();
                ptr.push_str(&format!("/{i}"));
                match (x.get(i), y.get(i)) {
                    (Some(l), Some(r)) => diff_json(l, r, ptr, out),
                    (l, r) => push_diff(out, ptr, l, r),
                }
                ptr.truncate(len);
            }
        }
        _ if a != b => push_diff(out, ptr, Some(a), Some(b)),
        _ => {}
    }
}
