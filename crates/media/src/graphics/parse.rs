//! Port of `media/graphics/parse.mjs:1-195`: the `.8bg` parser. It never
//! fails; it produces GIR.

use super::{Animation, AnimationKind, Gir, Sprite, Transparent};
use crate::cursor::{
    BlockItem, Cursor, cursor, parse_block, parse_name, parse_number, parse_string,
};
use crate::lexer::{MediaToken, MediaTokenKind};
use diagnostics::Diagnostic;

const SPRITE_FIELDS: [&str; 4] = ["source", "size", "transparent", "animation"];
const ANIM_FIELDS: [&str; 2] = ["frames", "every"];

/// `/^x\d+$/i`.
fn is_x_digits(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some('x' | 'X')) && s.len() > 1 && chars.all(|c| c.is_ascii_digit())
}

struct Size {
    width: f64,
    height: f64,
    start: u32,
    length: i64,
    diagnostics: Vec<Diagnostic>,
}

fn parse_size(c: &mut Cursor) -> Size {
    let w = parse_number(c, "width");
    let next = c.at(0);
    let w_start = i64::from(w.start);
    if let Some(n) = next {
        if n.kind == MediaTokenKind::Identifier && is_x_digits(&n.text) {
            let tok = c.eat(Some(MediaTokenKind::Identifier), None).unwrap_or(n);
            let height = tok.text[1..].parse::<f64>().unwrap_or(f64::NAN);
            return Size {
                width: w.value,
                height,
                start: w.start,
                length: i64::from(tok.start) + i64::from(tok.length) - w_start,
                diagnostics: w.diagnostics,
            };
        }
        if n.kind == MediaTokenKind::Identifier && n.text.to_lowercase() == "x" {
            c.eat(Some(MediaTokenKind::Identifier), None);
            let h = parse_number(c, "height");
            let mut diagnostics = w.diagnostics;
            diagnostics.extend(h.diagnostics);
            return Size {
                width: w.value,
                height: h.value,
                start: w.start,
                length: i64::from(h.start) + i64::from(h.length) - w_start,
                diagnostics,
            };
        }
    }
    let x = c.expect(Some(MediaTokenKind::Punctuation), Some("x"), "'x'");
    let h = parse_number(c, "height");
    let mut diagnostics = w.diagnostics;
    diagnostics.extend(x.diagnostics);
    diagnostics.extend(h.diagnostics);
    Size {
        width: w.value,
        height: h.value,
        start: w.start,
        length: i64::from(h.start) + i64::from(h.length) - w_start,
        diagnostics,
    }
}

fn parse_frames(c: &mut Cursor) -> (Vec<f64>, Vec<Diagnostic>) {
    let mut frames = Vec::new();
    let mut diagnostics = Vec::new();
    let first = parse_number(c, "a frame index");
    let ok = first.diagnostics.is_empty();
    diagnostics.extend(first.diagnostics);
    if ok {
        frames.push(first.value);
    }
    while c
        .eat(Some(MediaTokenKind::Punctuation), Some(","))
        .is_some()
    {
        let n = parse_number(c, "a frame index");
        let ok = n.diagnostics.is_empty();
        diagnostics.extend(n.diagnostics);
        if ok {
            frames.push(n.value);
        }
    }
    (frames, diagnostics)
}

enum AnimItem {
    Frames {
        frames: Vec<f64>,
        diagnostics: Vec<Diagnostic>,
    },
    Every {
        value: f64,
        start: u32,
        length: u32,
        diagnostics: Vec<Diagnostic>,
    },
    Skip {
        diagnostics: Vec<Diagnostic>,
    },
}

impl BlockItem for AnimItem {
    fn diagnostics(&self) -> &[Diagnostic] {
        match self {
            AnimItem::Frames { diagnostics, .. }
            | AnimItem::Every { diagnostics, .. }
            | AnimItem::Skip { diagnostics } => diagnostics,
        }
    }
    fn is_skip(&self) -> bool {
        matches!(self, AnimItem::Skip { .. })
    }
}

fn parse_animation(c: &mut Cursor) -> Animation {
    let name = parse_name(c);
    let mut diagnostics = name.diagnostics.clone();
    let mut frames: Vec<f64> = Vec::new();
    let mut every = 1.0;
    let (mut every_start, mut every_length) = (name.start, name.length);
    let block = parse_block(c, |inner| {
        let Some(field) = inner.eat(Some(MediaTokenKind::Identifier), None) else {
            inner.skip_to(&["}"]);
            return AnimItem::Skip {
                diagnostics: vec![inner.report(inner.syntax, "expected a field", inner.at(0))],
            };
        };
        if !ANIM_FIELDS.contains(&field.text.as_str()) {
            inner.skip_to(&[
                "}",
                "source",
                "size",
                "transparent",
                "animation",
                "frames",
                "every",
            ]);
            return AnimItem::Skip {
                diagnostics: vec![inner.report(
                    inner.unknown,
                    format!("unknown field '{}'", field.text),
                    Some(field),
                )],
            };
        }
        if field.text == "frames" {
            let (frames, diagnostics) = parse_frames(inner);
            return AnimItem::Frames {
                frames,
                diagnostics,
            };
        }
        // `every`: the only other member of ANIM_FIELDS.
        let n = parse_number(inner, "a frame interval");
        AnimItem::Every {
            value: n.value,
            start: n.start,
            length: n.length,
            diagnostics: n.diagnostics,
        }
    });
    diagnostics.extend(block.diagnostics);
    for item in block.body {
        match item {
            AnimItem::Frames { frames: f, .. } => frames = f,
            AnimItem::Every {
                value,
                start,
                length,
                ..
            } => {
                every = value;
                every_start = start;
                every_length = length;
            }
            AnimItem::Skip { .. } => {}
        }
    }
    Animation {
        kind: AnimationKind::Animation,
        name: name.name,
        frames,
        every,
        start: name.start,
        length: name.length,
        every_start,
        every_length,
        diagnostics,
    }
}

enum SpriteItem {
    Source {
        value: String,
        start: u32,
        length: u32,
        diagnostics: Vec<Diagnostic>,
    },
    Size(Size),
    Transparent {
        value: Transparent,
        diagnostics: Vec<Diagnostic>,
    },
    Animation(Animation),
    Skip {
        diagnostics: Vec<Diagnostic>,
    },
}

impl BlockItem for SpriteItem {
    fn diagnostics(&self) -> &[Diagnostic] {
        match self {
            SpriteItem::Source { diagnostics, .. }
            | SpriteItem::Transparent { diagnostics, .. }
            | SpriteItem::Skip { diagnostics } => diagnostics,
            SpriteItem::Size(s) => &s.diagnostics,
            SpriteItem::Animation(a) => &a.diagnostics,
        }
    }
    fn is_skip(&self) -> bool {
        matches!(self, SpriteItem::Skip { .. })
    }
}

fn parse_sprite(c: &mut Cursor, keyword: &MediaToken) -> (Sprite, Vec<Diagnostic>) {
    let name = parse_name(c);
    let mut diagnostics = name.diagnostics.clone();
    let mut sprite = Sprite {
        name: name.name.clone(),
        source: None,
        width: 0.0,
        height: 0.0,
        transparent: Transparent::Auto,
        animations: Vec::new(),
        start: keyword.start,
        length: name.length,
        source_start: keyword.start,
        source_length: keyword.length,
        size_start: keyword.start,
        size_length: i64::from(keyword.length),
    };
    let block = parse_block(c, |inner| {
        let Some(field) = inner.eat(Some(MediaTokenKind::Identifier), None) else {
            inner.skip_to(&["}"]);
            return SpriteItem::Skip {
                diagnostics: vec![inner.report(inner.syntax, "expected a field", inner.at(0))],
            };
        };
        if field.text == "animation" {
            return SpriteItem::Animation(parse_animation(inner));
        }
        if !SPRITE_FIELDS.contains(&field.text.as_str()) {
            return SpriteItem::Skip {
                diagnostics: vec![inner.report(
                    inner.unknown,
                    format!("unknown field '{}'", field.text),
                    Some(field),
                )],
            };
        }
        if field.text == "source" {
            let s = parse_string(inner, "a source path");
            return SpriteItem::Source {
                value: s.value,
                start: s.start,
                length: s.length,
                diagnostics: s.diagnostics,
            };
        }
        if field.text == "size" {
            return SpriteItem::Size(parse_size(inner));
        }
        // `transparent`: the only other member of SPRITE_FIELDS.
        if inner
            .at(0)
            .is_some_and(|t| t.kind == MediaTokenKind::Identifier && t.text == "auto")
        {
            inner.eat(Some(MediaTokenKind::Identifier), None);
            return SpriteItem::Transparent {
                value: Transparent::Auto,
                diagnostics: Vec::new(),
            };
        }
        let n = parse_number(inner, "a transparent index or auto");
        SpriteItem::Transparent {
            value: Transparent::Index(n.value),
            diagnostics: n.diagnostics,
        }
    });
    diagnostics.extend(block.diagnostics);
    for item in block.body {
        match item {
            SpriteItem::Source {
                value,
                start,
                length,
                ..
            } => {
                sprite.source = Some(value);
                sprite.source_start = start;
                sprite.source_length = length;
            }
            SpriteItem::Size(s) => {
                sprite.width = s.width;
                sprite.height = s.height;
                sprite.size_start = s.start;
                sprite.size_length = s.length;
            }
            SpriteItem::Transparent { value, .. } => sprite.transparent = value,
            SpriteItem::Animation(a) => sprite.animations.push(a),
            SpriteItem::Skip { .. } => {}
        }
    }
    (sprite, diagnostics)
}

/// `parseGraphics(tokens, text, file)`: `(gir, diagnostics)`.
#[must_use]
pub fn parse_graphics(tokens: &[MediaToken], text: &str, file: &str) -> (Gir, Vec<Diagnostic>) {
    let mut c = cursor(tokens, text, file, ".8bg");
    let mut diagnostics = Vec::new();
    let mut sprites = Vec::new();
    while !c.done() {
        let Some(kw) = c.eat(Some(MediaTokenKind::Identifier), None) else {
            diagnostics.push(c.report(c.syntax, "expected a declaration", c.at(0)));
            c.pos = c.tokens.len();
            break;
        };
        if kw.text == "sprite" {
            let (sprite, d) = parse_sprite(&mut c, kw);
            diagnostics.extend(d);
            sprites.push(sprite);
            continue;
        }
        diagnostics.push(c.report(
            c.unknown,
            format!(
                "'{}' is not a graphics declaration in this slice (sprite)",
                kw.text
            ),
            Some(kw),
        ));
        c.skip_to(&["sprite", "tile", "font"]);
    }
    (
        Gir {
            sprites,
            tiles: Vec::new(),
            fonts: Vec::new(),
        },
        diagnostics,
    )
}
