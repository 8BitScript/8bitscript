//! Port of `media/index.mjs:1-55`: the front end for `.8bg` and `.8ba`:
//! lex, parse, check. Decode and machine lowering belong to the elaborate
//! unit.

pub mod audio;
pub mod cursor;
pub mod elaborate;
pub mod graphics;
pub mod kinds;
pub mod lexer;
pub mod machine;
pub mod machines;
pub mod tap;

use audio::Air;
use diagnostics::Diagnostic;
use graphics::Gir;
use lexer::MediaToken;
use serde::Serialize;

pub use audio::check::check_audio;
pub use audio::parse::parse_audio;
pub use graphics::check::check_graphics;
pub use graphics::parse::parse_graphics;
pub use kinds::is_media_kind;
pub use lexer::{MediaTokenKind, tokenize_media};

/// `media: {kind, gir, air}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Media {
    pub kind: String,
    pub gir: Option<Gir>,
    pub air: Option<Air>,
}

/// The result of `parseMediaModule`. The JS also carries `ast: null` and an
/// empty `bound`; the tap encoder writes those.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MediaModule {
    pub file: String,
    pub text: String,
    pub tokens: Vec<MediaToken>,
    pub media: Media,
}

/// The result of `analyzeMedia`.
#[derive(Debug, Clone, PartialEq)]
pub struct MediaAnalysis {
    pub tokens: Vec<MediaToken>,
    pub gir: Option<Gir>,
    pub air: Option<Air>,
    pub diagnostics: Vec<Diagnostic>,
}

/// `parseMediaModule(file, text, diagnostics, sourceKind)`.
pub fn parse_media_module(
    file: &str,
    text: &str,
    diagnostics: &mut Vec<Diagnostic>,
    source_kind: &str,
) -> MediaModule {
    let result = analyze_media(text, file, source_kind);
    diagnostics.extend(result.diagnostics);
    MediaModule {
        file: file.to_string(),
        text: text.to_string(),
        tokens: result.tokens,
        media: Media {
            kind: source_kind.to_string(),
            gir: result.gir,
            air: result.air,
        },
    }
}

/// `analyzeMedia(text, file, { sourceKind })`.
#[must_use]
pub fn analyze_media(text: &str, file: &str, source_kind: &str) -> MediaAnalysis {
    let (tokens, lexical) = tokenize_media(text, file, source_kind);
    if source_kind == ".8bg" {
        let (gir, syntax) = parse_graphics(&tokens, text, file);
        let checked = check_graphics(&gir, file);
        let diagnostics = lexical.into_iter().chain(syntax).chain(checked).collect();
        return MediaAnalysis {
            tokens,
            gir: Some(gir),
            air: None,
            diagnostics,
        };
    }
    let (air, syntax) = parse_audio(&tokens, text, file);
    let checked = check_audio(&air, file);
    let diagnostics = lexical.into_iter().chain(syntax).chain(checked).collect();
    MediaAnalysis {
        tokens,
        gir: None,
        air: Some(air),
        diagnostics,
    }
}
