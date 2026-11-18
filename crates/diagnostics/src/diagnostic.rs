//! The diagnostic record (`diagnostics/index.mjs:267-269`, R5.1).

use serde::{Deserialize, Serialize};

/// `'error' | 'warning' | 'remark'`. `remark` is what a build's own
/// optimizer says it did; it is never produced by `8bs check`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Remark,
}

/// `{code, message, file, start, length, severity}`. `start` and `length`
/// are UTF-16 code units (R6.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub file: String,
    pub start: u32,
    pub length: u32,
    pub severity: Severity,
}

/// `diagnostic(code, message, file, start, length, severity = 'error')`.
#[must_use]
pub fn diagnostic(
    code: &str,
    message: impl Into<String>,
    file: &str,
    start: u32,
    length: u32,
    severity: Severity,
) -> Diagnostic {
    Diagnostic {
        code: code.to_string(),
        message: message.into(),
        file: file.to_string(),
        start,
        length,
        severity,
    }
}

/// A 1-based line and column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

/// `positionAt(text, offset)`: `offset` counts UTF-16 code units, and the
/// column is `offset - lastBreak` where `lastBreak` is the unit index of the
/// last `\n` before `offset` (or -1).
#[must_use]
pub fn position_at(text: &str, offset: u32) -> Position {
    let mut line = 1u32;
    let mut last_break: i64 = -1;
    for (i, unit) in text.encode_utf16().enumerate() {
        if i as u64 >= u64::from(offset) {
            break;
        }
        if unit == u16::from(b'\n') {
            line = line.saturating_add(1);
            last_break = i as i64;
        }
    }
    let column = (i64::from(offset) - last_break).clamp(0, i64::from(u32::MAX));
    Position {
        line,
        column: u32::try_from(column).unwrap_or(u32::MAX),
    }
}
