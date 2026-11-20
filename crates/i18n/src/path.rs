//! The parts of Node's `path.posix` that `i18n/index.mjs` uses: `basename`, `dirname`, `join`
//! and `resolve`, ported from Node's own algorithms so odd inputs (`..`, doubled and trailing
//! slashes, the empty string) come out the same.

/// `path.normalize` for one string.
#[must_use]
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut out = normalize_segments(path, !absolute);
    if out.is_empty() {
        if absolute {
            return "/".to_string();
        }
        return if trailing { "./" } else { "." }.to_string();
    }
    if trailing {
        out.push('/');
    }
    if absolute { format!("/{out}") } else { out }
}

/// `normalizeString`: the segments of `path` without `.`, empty ones and the `..` that cancel a
/// segment before them; `..` at the front stays when `allow_above_root`.
fn normalize_segments(path: &str, allow_above_root: bool) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if stack.last().is_some_and(|last| *last != "..") {
                    stack.pop();
                } else if allow_above_root {
                    stack.push("..");
                }
            }
            other => stack.push(other),
        }
    }
    stack.join("/")
}

/// `path.join(a, b)`: empty parts are dropped, the rest is joined with `/` and normalized.
#[must_use]
pub fn join(a: &str, b: &str) -> String {
    let parts: Vec<&str> = [a, b].into_iter().filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return ".".to_string();
    }
    normalize(&parts.join("/"))
}

/// `path.dirname`.
#[must_use]
pub fn dirname(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.is_empty() {
        return ".".to_string();
    }
    let has_root = bytes[0] == b'/';
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    for i in (1..bytes.len()).rev() {
        if bytes[i] == b'/' {
            if !matched_slash {
                end = Some(i);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None => if has_root { "/" } else { "." }.to_string(),
        Some(1) if has_root => "//".to_string(),
        Some(end) => path[..end].to_string(),
    }
}

/// `path.basename` without an extension argument: the last segment, trailing slashes ignored.
#[must_use]
pub fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("").to_string()
}

/// `path.resolve(path)`: an absolute, normalized path with no trailing slash, relative paths
/// taken from the current directory.
#[must_use]
pub fn resolve(path: &str) -> String {
    let full = if path.starts_with('/') {
        path.to_string()
    } else {
        let cwd = std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".to_string());
        if path.is_empty() {
            cwd
        } else {
            format!("{cwd}/{path}")
        }
    };
    let out = normalize_segments(&full, false);
    format!("/{out}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_and_normalize_follow_node() {
        assert_eq!(join("a/b", "c"), "a/b/c");
        assert_eq!(join("a/b/", "c"), "a/b/c");
        assert_eq!(join("./a", "../b"), "b");
        assert_eq!(join("", ""), ".");
        assert_eq!(join("", "x"), "x");
        assert_eq!(join("/", "src/i18n"), "/src/i18n");
        assert_eq!(join("..", "x"), "../x");
        assert_eq!(join("/..", "x"), "/x");
        assert_eq!(join("a//b", "c/"), "a/b/c/");
        assert_eq!(normalize("a/.."), ".");
        assert_eq!(normalize("a/../"), "./");
        assert_eq!(normalize("//a"), "/a");
        assert_eq!(normalize("/"), "/");
    }

    #[test]
    fn dirname_follows_node() {
        assert_eq!(dirname("/a/b/c"), "/a/b");
        assert_eq!(dirname("/a/b/"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("/"), "/");
        assert_eq!(dirname("a"), ".");
        assert_eq!(dirname("a/b"), "a");
        assert_eq!(dirname(""), ".");
        assert_eq!(dirname("."), ".");
        assert_eq!(dirname("//a"), "//");
        assert_eq!(dirname("a//b"), "a/");
        assert_eq!(dirname("/a//b/"), "/a/");
    }

    #[test]
    fn basename_follows_node() {
        assert_eq!(basename("/a/b.8bs"), "b.8bs");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("b"), "b");
        assert_eq!(basename("/"), "");
        assert_eq!(basename(""), "");
    }

    #[test]
    fn resolve_is_absolute_and_clean() {
        assert_eq!(resolve("/a/./b/../c/"), "/a/c");
        assert!(resolve("x/y").ends_with("/x/y"));
        assert!(resolve("").starts_with('/'));
        assert_eq!(resolve("/"), "/");
    }
}
