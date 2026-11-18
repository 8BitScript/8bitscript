//! String and number helpers that reproduce JavaScript built-ins (rulebook R6).

/// A regex character class equal to JavaScript's `\s` (no `u` flag).
pub const JS_WS: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

/// Whether `c` is in the set `String.prototype.trim` and regex `\s` share.
#[must_use]
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// JavaScript `s.trim()`.
#[must_use]
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// JavaScript `s.length`: UTF-16 code units.
#[must_use]
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `v.toString(16).toUpperCase().padStart(width, '0')`. A negative value is
/// `-` plus digits, and the padding goes in front of the minus.
#[must_use]
pub fn hex_upper(v: i64, width: usize) -> String {
    let sign = if v < 0 { "-" } else { "" };
    let body = format!("{sign}{:X}", v.unsigned_abs());
    format!("{body:0>width$}")
}

/// `Number.parseInt(digits, radix)` on digits a regex already checked
/// (radix 2, 10 or 16), correctly rounded.
#[must_use]
pub fn parse_int(digits: &str, radix: u32) -> f64 {
    if radix == 10 {
        return digits.parse::<f64>().unwrap_or(f64::NAN);
    }
    let mut acc: u128 = 0;
    for c in digits.chars() {
        let Some(d) = c.to_digit(radix) else {
            return f64::NAN;
        };
        acc = acc
            .saturating_mul(u128::from(radix))
            .saturating_add(u128::from(d));
    }
    acc as f64
}

/// JavaScript `Math.round`: halves go toward positive infinity.
#[must_use]
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    let f = x.floor();
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    if r == 0.0 && x < 0.0 { -0.0 } else { r }
}
