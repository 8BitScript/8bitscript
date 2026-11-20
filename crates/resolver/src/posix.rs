//! The few `node:path` (posix) operations the resolver port needs, over `/`-separated strings.

/// `path.basename(p)`.
#[must_use]
pub fn basename(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    match t.rfind('/') {
        Some(i) => &t[i + 1..],
        None => t,
    }
}

/// `path.dirname(p)`.
#[must_use]
pub fn dirname(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    if t.is_empty() {
        return if p.starts_with('/') { "/" } else { "." };
    }
    match t.rfind('/') {
        None => ".",
        Some(i) => {
            let head = t[..i].trim_end_matches('/');
            if head.is_empty() { "/" } else { head }
        }
    }
}

/// `path.resolve(dir, rel)`: joined, made absolute against the working directory, normalized.
#[must_use]
pub fn resolve(dir: &str, rel: &str) -> String {
    let joined = if rel.starts_with('/') || dir.is_empty() {
        rel.to_string()
    } else {
        format!("{dir}/{rel}")
    };
    let full = if joined.starts_with('/') {
        joined
    } else {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        format!("{cwd}/{joined}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in full.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basename_and_dirname_follow_node() {
        assert_eq!(basename("a/b.8bs"), "b.8bs");
        assert_eq!(basename("b.8bs"), "b.8bs");
        assert_eq!(basename("a/b/"), "b");
        assert_eq!(basename("/"), "");
        assert_eq!(dirname("a/b.8bs"), "a");
        assert_eq!(dirname("b.8bs"), ".");
        assert_eq!(dirname("/b"), "/");
        assert_eq!(dirname("a//b"), "a");
        assert_eq!(dirname("/"), "/");
        assert_eq!(dirname(""), ".");
    }

    #[test]
    fn resolve_normalizes() {
        assert_eq!(resolve("/p/q", "./a//b/"), "/p/q/a/b");
        assert_eq!(resolve("/p/q/../r", "x"), "/p/r/x");
        assert_eq!(resolve("/", "x"), "/x");
    }
}
