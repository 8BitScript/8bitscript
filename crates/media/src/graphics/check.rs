//! Port of `media/graphics/check.mjs:1-32`: required fields, unique names,
//! size sanity. Host decode happens later, in the linker.

use super::Gir;
use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use indexmap::IndexSet;
use jsnum::number_to_string;

/// A span length that JS computed may be negative; a `Diagnostic` cannot
/// hold that, so it is clamped to 0 here.
fn clamp(length: i64) -> u32 {
    u32::try_from(length.max(0)).unwrap_or(u32::MAX)
}

/// `checkGraphics(gir, file)`.
#[must_use]
pub fn check_graphics(gir: &Gir, file: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    let mut names: IndexSet<&str> = IndexSet::new();
    for sprite in &gir.sprites {
        let mut at = |code: &str, message: String, start: u32, length: i64| {
            out.push(diagnostic(
                code,
                message,
                file,
                start,
                clamp(length),
                Severity::Error,
            ));
        };
        let (s_start, s_len) = (sprite.start, i64::from(sprite.length));
        if sprite.name.is_empty() {
            continue;
        }
        if names.contains(sprite.name.as_str()) {
            at(
                codes::GFX_DUPLICATE_NAME,
                format!("'{}' is already declared", sprite.name),
                s_start,
                s_len,
            );
        }
        names.insert(&sprite.name);
        if sprite.source.as_deref().is_none_or(str::is_empty) {
            at(
                codes::GFX_MISSING_FIELD,
                format!("sprite '{}' needs a source \"...png\"", sprite.name),
                s_start,
                s_len,
            );
        }
        if sprite.width == 0.0 && sprite.height == 0.0 {
            at(
                codes::GFX_MISSING_FIELD,
                format!("sprite '{}' needs size WxH", sprite.name),
                sprite.size_start,
                sprite.size_length,
            );
        } else if sprite.width < 1.0
            || sprite.height < 1.0
            || sprite.width > 64.0
            || sprite.height > 64.0
        {
            at(
                codes::GFX_INVALID_SIZE,
                format!(
                    "sprite '{}' size {}x{} is not 1x1..64x64",
                    sprite.name,
                    number_to_string(sprite.width),
                    number_to_string(sprite.height)
                ),
                sprite.size_start,
                sprite.size_length,
            );
        }
        for anim in &sprite.animations {
            if anim.frames.is_empty() {
                at(
                    codes::GFX_MISSING_FIELD,
                    format!("animation '{}' needs frames", anim.name),
                    anim.start,
                    i64::from(anim.length),
                );
            }
            if !(anim.every.is_finite() && anim.every.fract() == 0.0) || anim.every < 1.0 {
                at(
                    codes::GFX_SYNTAX,
                    format!(
                        "'every' is a frame count of 1 or more, not {}",
                        number_to_string(anim.every)
                    ),
                    anim.every_start,
                    i64::from(anim.every_length),
                );
            }
        }
    }
    out
}
