//! Audio front end stub: `parse_audio` and `check_audio` are ported by the
//! next unit. Until then `.8ba` analysis returns `Unported`.

/// The tap replay maps this to Skip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unported(pub &'static str);

/// AIR `{instruments, samples, songs, parts, voiceGroups}`; the audio unit
/// declares the fields.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Air {}

/// `parseAudio(tokens, text, file)`.
///
/// # Errors
/// Always `Unported` until the audio unit lands.
pub fn parse_audio(
    _tokens: &[crate::lexer::MediaToken],
    _text: &str,
    _file: &str,
) -> Result<(Air, Vec<diagnostics::Diagnostic>), Unported> {
    Err(Unported("media::audio::parse_audio"))
}
