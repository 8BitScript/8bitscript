//! `oracle/divergences.toml`: accepted differences, each with a reason.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Divergence {
    pub id: String,
    pub corpus: String,
    pub stage: String,
    #[serde(default = "any")]
    pub pointer: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub issue: Option<u32>,
}

fn any() -> String {
    "*".to_string()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct File {
    #[serde(default)]
    pub divergence: Vec<Divergence>,
}

pub(crate) fn parse(text: &str) -> Result<Vec<Divergence>, String> {
    toml::from_str::<File>(text)
        .map(|f| f.divergence)
        .map_err(|e| e.message().to_string())
}

impl Divergence {
    pub(crate) fn matches(&self, id: &str, stage: &str, locator: &str) -> bool {
        glob_match(&self.corpus, id) && glob_match(&self.stage, stage) && glob_match(&self.pointer, locator)
    }
}

/// Glob with `*` (any run, slashes included) and `?` (one character).
#[must_use]
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}
