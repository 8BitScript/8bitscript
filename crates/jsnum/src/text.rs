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

/// `Number.parseInt(text, radix)` for a radix from 2 to 36: an optional sign,
/// then the longest prefix of digits valid in `radix`; no digit is NaN.
/// Radix 10 and the power-of-two radixes 2, 8 and 16 are correctly rounded,
/// as V8 does; other radixes accumulate in `f64`, which is V8's approximation
/// for long inputs.
#[must_use]
pub fn parse_int(digits: &str, radix: u32) -> f64 {
    use num_traits::ToPrimitive;
    let (negative, body) = match digits.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, digits.strip_prefix('+').unwrap_or(digits)),
    };
    let end = body
        .find(|c: char| c.to_digit(radix).is_none())
        .unwrap_or(body.len());
    let valid = &body[..end];
    if valid.is_empty() {
        return f64::NAN;
    }
    let value = match radix {
        10 => valid.parse::<f64>().unwrap_or(f64::NAN),
        2 | 8 | 16 => num_bigint::BigUint::parse_bytes(valid.as_bytes(), radix)
            .and_then(|n| n.to_f64())
            .unwrap_or(f64::NAN),
        _ => valid.chars().fold(0.0, |acc, c| {
            acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
        }),
    };
    if negative { -value } else { value }
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

/// JavaScript `Number(s)` on a string (StringToNumber): trimmed, empty is 0,
/// `0x`/`0o`/`0b` integers (no sign), `Infinity` with an optional sign, and
/// decimal literals; anything else, including `inf`, `nan` and digit
/// separators, is NaN.
#[must_use]
pub fn string_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = match t.get(..2) {
        Some("0x" | "0X") => 16,
        Some("0o" | "0O") => 8,
        Some("0b" | "0B") => 2,
        _ => 0,
    };
    if radix != 0 {
        let digits = &t[2..];
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        return parse_int(digits, radix);
    }
    let (negative, body) = match t.as_bytes()[0] {
        b'-' => (true, &t[1..]),
        b'+' => (false, &t[1..]),
        _ => (false, t),
    };
    let magnitude = if body == "Infinity" {
        f64::INFINITY
    } else if is_decimal_literal(body) {
        body.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        return f64::NAN;
    };
    if negative { -magnitude } else { magnitude }
}

/// `digits [. digits] [e [+-] digits]` or `. digits [e ...]`, digits ASCII.
fn is_decimal_literal(s: &str) -> bool {
    let b = s.as_bytes();
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let mut i = digits(0);
    let int_digits = i;
    let mut frac_digits = 0;
    if b.get(i) == Some(&b'.') {
        frac_digits = digits(i + 1);
        i += 1 + frac_digits;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp = digits(i);
        if exp == 0 {
            return false;
        }
        i += exp;
    }
    i == b.len()
}

#[cfg(test)]
mod tests {
    use super::string_to_number;

    #[test]
    fn string_to_number_follows_js() {
        let nan = [
            "", "x", "inf", "-inf", "nan", "NaN", "1_0", "0x", "0b2", "0o8", "-0x10", "+0x10", "+",
            "-", ".", "1e", "e5", "infinity", "1 2", "0x1g",
        ];
        for s in nan {
            let v = string_to_number(s);
            if s.is_empty() {
                assert_eq!(v, 0.0);
            } else {
                assert!(v.is_nan(), "{s:?} -> {v}");
            }
        }
        let cases = [
            (" 12 ", 12.0),
            ("\u{a0}\n7\t", 7.0),
            ("0x10", 16.0),
            ("0XfF", 255.0),
            ("0o17", 15.0),
            ("0b101", 5.0),
            ("+5", 5.0),
            ("-5", -5.0),
            ("1e3", 1000.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("1.5E-1", 0.15),
            ("Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("+Infinity", f64::INFINITY),
            ("1e400", f64::INFINITY),
            ("007", 7.0),
        ];
        for (s, want) in cases {
            assert_eq!(string_to_number(s), want, "{s:?}");
        }
    }
}
