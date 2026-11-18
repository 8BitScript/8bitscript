use crate::to_int32;

/// Max value of an unsigned primitive integer type, by any spelling.
/// `None` for signed types and unknown names (the JS returns `null` there).
fn unsigned_max(ty: &str) -> Option<f64> {
    match ty {
        "utinyint" | "u8" => Some(255.0),
        "usmallint" | "u16" => Some(65_535.0),
        "umediumint" | "u24" => Some(16_777_215.0),
        "uint" | "u32" => Some(4_294_967_295.0),
        _ => None,
    }
}

/// `wrapUnsigned` in `linker/optimize.mjs`: `None` for signed types.
#[must_use]
pub fn wrap_unsigned(v: f64, ty: &str) -> Option<f64> {
    let modulus = unsigned_max(ty)? + 1.0;
    Some(((v % modulus) + modulus) % modulus)
}

/// The arithmetic and bitwise arms of `constValue` in `linker/optimize.mjs`.
/// `None` is JS `null` (not folded). Comparisons and boolean operators are
/// not here.
#[must_use]
pub fn fold_binop(op: &str, left: f64, right: f64, ty: &str) -> Option<f64> {
    match op {
        "+" => wrap_unsigned(left + right, ty),
        "-" => wrap_unsigned(left - right, ty),
        "*" => wrap_unsigned(left * right, ty),
        "/" if right == 0.0 => None,
        "/" => wrap_unsigned((left / right).floor(), ty),
        "%" if right == 0.0 => None,
        "%" => wrap_unsigned(left % right, ty),
        "&" => wrap_unsigned(f64::from(to_int32(left) & to_int32(right)), ty),
        "|" => wrap_unsigned(f64::from(to_int32(left) | to_int32(right)), ty),
        "^" => wrap_unsigned(f64::from(to_int32(left) ^ to_int32(right)), ty),
        "<<" => wrap_unsigned(left * right.exp2(), ty),
        ">>" => wrap_unsigned((left / right.exp2()).floor(), ty),
        _ => None,
    }
}
