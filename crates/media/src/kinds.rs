//! Port of `media/kinds.mjs:1-3`.

/// `isMediaKind(kind)`.
#[must_use]
pub fn is_media_kind(kind: &str) -> bool {
    kind == ".8bg" || kind == ".8ba"
}
