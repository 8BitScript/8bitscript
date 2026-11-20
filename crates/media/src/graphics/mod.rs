//! The graphics front end: `parse` and `check`, plus GIR.

pub mod check;
pub mod parse;

use serde::Serialize;

/// `kind: 'animation'` of a sprite's animation entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AnimationKind {
    Animation,
}

/// An entry of `sprite.animations`: `{kind: 'animation', ...parseAnimation}`.
/// The parser leaves its `diagnostics` on the entry, so they are part of GIR.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Animation {
    pub kind: AnimationKind,
    pub name: String,
    pub frames: Vec<f64>,
    pub every: f64,
    pub start: u32,
    pub length: u32,
    pub every_start: u32,
    pub every_length: u32,
    pub diagnostics: Vec<diagnostics::Diagnostic>,
}

/// `sprite.transparent`: the string `'auto'` or a palette index.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Transparent {
    Auto,
    Index(f64),
}

impl Serialize for Transparent {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Transparent::Auto => s.serialize_str("auto"),
            Transparent::Index(n) => s.serialize_f64(*n),
        }
    }
}

/// A GIR sprite, fields in the JS insertion order (`diagnostics` is deleted
/// by `parseGraphics` and returned beside it). `size_length` is signed: JS
/// computes it as a difference that goes negative when the height is missing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sprite {
    pub name: String,
    pub source: Option<String>,
    pub width: f64,
    pub height: f64,
    pub transparent: Transparent,
    pub animations: Vec<Animation>,
    pub start: u32,
    pub length: u32,
    pub source_start: u32,
    pub source_length: u32,
    pub size_start: u32,
    pub size_length: i64,
}

/// `{sprites, tiles: [], fonts: []}`. `tiles` and `fonts` stay empty in this
/// slice, so they are unit-typed lists.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Gir {
    pub sprites: Vec<Sprite>,
    pub tiles: Vec<()>,
    pub fonts: Vec<()>,
}
