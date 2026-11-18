//! JavaScript number, string and sort semantics (rulebook R2, R3.4, R4).

mod fold;
mod nullable;
mod order;
mod text;

pub use fold::{fold_binop, wrap_unsigned};
pub use nullable::Nullable;
pub use order::{cmp_utf16, object_key_order};
pub use text::{JS_WS, hex_upper, is_js_whitespace, js_trim, math_round, parse_int, utf16_len};

const TWO_32: f64 = 4_294_967_296.0;

/// ECMAScript ToUint32 of a number.
#[must_use]
pub fn to_uint32(v: f64) -> u32 {
    if !v.is_finite() {
        return 0;
    }
    // `%` on f64 is exact, so this is ToUint32's modulo 2^32.
    let m = v.trunc().rem_euclid(TWO_32);
    // m is an integer in [0, 2^32), so the cast is exact.
    m as u32
}

/// ECMAScript ToInt32 of a number.
#[must_use]
pub fn to_int32(v: f64) -> i32 {
    to_uint32(v) as i32
}

/// What a store into a `Uint8Array` keeps: ToUint8 (truncate, modulo 256).
#[must_use]
pub fn to_uint8(v: f64) -> u8 {
    to_uint32(v) as u8
}

/// JavaScript `String(n)` (Number::toString, radix 10).
#[must_use]
pub fn number_to_string(v: f64) -> String {
    if v.is_nan() {
        return "NaN".to_string();
    }
    if v == 0.0 {
        return "0".to_string();
    }
    if v.is_infinite() {
        return if v < 0.0 { "-Infinity" } else { "Infinity" }.to_string();
    }
    let sign = if v < 0.0 { "-" } else { "" };
    // Rust prints the shortest digits that round-trip, as `d.ddde<exp>`.
    let sci = format!("{:e}", v.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exp: i32 = exp.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let n = exp + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let (int, frac) = digits.split_at(n as usize);
        format!("{int}.{frac}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e_sign = if e < 0 { '-' } else { '+' };
        let e_abs = e.abs();
        if k == 1 {
            format!("{digits}e{e_sign}{e_abs}")
        } else {
            format!("{}.{}e{e_sign}{e_abs}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}
