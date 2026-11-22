//! A JSON value as JS holds it after `JSON.parse`, and the JS operations the
//! fact checks apply to one.

use indexmap::IndexMap;
use jsnum::{cmp_utf16, number_to_string, object_key_order};

/// A JSON value as JS holds it after `JSON.parse`: numbers are f64 and an
/// object keeps its keys in the order they were given.
///
/// The parser accepts any nesting depth, so every walk over a value here
/// (drop, clone, compare, stringify, `String(v)`) keeps its own stack rather
/// than recursing.
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(IndexMap<String, Json>),
}

/// An open array or object during a walk.
enum Walk<'a> {
    Array(std::slice::Iter<'a, Json>),
    Object(indexmap::map::Iter<'a, String, Json>),
}

/// The manual `Drop` frees nested values with a heap stack, so deep nesting
/// does not overflow the call stack when a value is dropped.
impl Drop for Json {
    fn drop(&mut self) {
        let mut stack: Vec<Json> = Vec::new();
        detach(self, &mut stack);
        while let Some(mut next) = stack.pop() {
            detach(&mut next, &mut stack);
        }
    }
}

/// Move a value's children onto `stack`, leaving it empty.
fn detach(value: &mut Json, stack: &mut Vec<Json>) {
    match value {
        Json::Array(items) => stack.append(items),
        Json::Object(map) => stack.extend(std::mem::take(map).into_values()),
        _ => {}
    }
}

impl std::fmt::Debug for Json {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.stringify())
    }
}

impl Clone for Json {
    fn clone(&self) -> Json {
        enum Open<'a> {
            Array(std::slice::Iter<'a, Json>, Vec<Json>),
            Object(
                indexmap::map::Iter<'a, String, Json>,
                Option<&'a String>,
                IndexMap<String, Json>,
            ),
        }
        let mut stack: Vec<Open> = Vec::new();
        let mut next: Option<&Json> = Some(self);
        let mut done: Option<Json> = None;
        loop {
            if let Some(value) = next.take() {
                done = match value {
                    Json::Array(items) => {
                        stack.push(Open::Array(items.iter(), Vec::with_capacity(items.len())));
                        None
                    }
                    Json::Object(map) => {
                        stack.push(Open::Object(
                            map.iter(),
                            None,
                            IndexMap::with_capacity(map.len()),
                        ));
                        None
                    }
                    Json::Null => Some(Json::Null),
                    Json::Bool(b) => Some(Json::Bool(*b)),
                    Json::Number(n) => Some(Json::Number(*n)),
                    Json::String(s) => Some(Json::String(s.clone())),
                };
            }
            if let Some(value) = done.take() {
                match stack.last_mut() {
                    None => return value,
                    Some(Open::Array(_, out)) => out.push(value),
                    Some(Open::Object(_, key, out)) => {
                        out.insert(key.take().cloned().unwrap_or_default(), value);
                    }
                }
            }
            match stack.last_mut() {
                None => return Json::Null,
                Some(Open::Array(iter, _)) => match iter.next() {
                    Some(child) => next = Some(child),
                    None => {
                        if let Some(Open::Array(_, out)) = stack.pop() {
                            done = Some(Json::Array(out));
                        }
                    }
                },
                Some(Open::Object(iter, key, _)) => match iter.next() {
                    Some((k, child)) => {
                        *key = Some(k);
                        next = Some(child);
                    }
                    None => {
                        if let Some(Open::Object(_, _, out)) = stack.pop() {
                            done = Some(Json::Object(out));
                        }
                    }
                },
            }
        }
    }
}

impl PartialEq for Json {
    fn eq(&self, other: &Json) -> bool {
        let mut pairs: Vec<(&Json, &Json)> = vec![(self, other)];
        while let Some((a, b)) = pairs.pop() {
            match (a, b) {
                (Json::Null, Json::Null) => {}
                (Json::Bool(x), Json::Bool(y)) if x == y => {}
                (Json::Number(x), Json::Number(y)) if x == y => {}
                (Json::String(x), Json::String(y)) if x == y => {}
                (Json::Array(x), Json::Array(y)) if x.len() == y.len() => {
                    pairs.extend(x.iter().zip(y))
                }
                (Json::Object(x), Json::Object(y)) if x.len() == y.len() => {
                    for ((kx, vx), (ky, vy)) in x.iter().zip(y) {
                        if kx != ky {
                            return false;
                        }
                        pairs.push((vx, vy));
                    }
                }
                _ => return false,
            }
        }
        true
    }
}

impl Json {
    /// `JSON.stringify(value)` for a value that has no `undefined` in it.
    #[must_use]
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        let mut stack: Vec<(Walk, bool)> = Vec::new();
        let mut next: Option<&Json> = Some(self);
        loop {
            if let Some(value) = next.take() {
                match value {
                    Json::Null => out.push_str("null"),
                    Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
                    Json::Number(n) if n.is_finite() => out.push_str(&number_to_string(*n)),
                    Json::Number(_) => out.push_str("null"),
                    Json::String(s) => out.push_str(&quote(s)),
                    Json::Array(items) => {
                        out.push('[');
                        stack.push((Walk::Array(items.iter()), true));
                    }
                    Json::Object(map) => {
                        out.push('{');
                        stack.push((Walk::Object(map.iter()), true));
                    }
                }
            }
            match stack.last_mut() {
                None => return out,
                Some((Walk::Array(iter), first)) => match iter.next() {
                    Some(child) => {
                        if !std::mem::replace(first, false) {
                            out.push(',');
                        }
                        next = Some(child);
                    }
                    None => {
                        out.push(']');
                        stack.pop();
                    }
                },
                Some((Walk::Object(iter), first)) => match iter.next() {
                    Some((key, child)) => {
                        if !std::mem::replace(first, false) {
                            out.push(',');
                        }
                        out.push_str(&quote(key));
                        out.push(':');
                        next = Some(child);
                    }
                    None => {
                        out.push('}');
                        stack.pop();
                    }
                },
            }
        }
    }

    /// `Number.isInteger(v)`.
    pub(crate) fn is_integer(&self) -> bool {
        matches!(self, Json::Number(n) if n.is_finite() && n.fract() == 0.0)
    }

    /// `String(v)` for a value that came out of JSON (an array joins with
    /// commas, `null` inside it is empty).
    fn to_js_string(&self) -> String {
        let mut out = String::new();
        let mut stack: Vec<(std::slice::Iter<Json>, bool)> = Vec::new();
        let mut next: Option<&Json> = Some(self);
        loop {
            if let Some(value) = next.take() {
                match value {
                    Json::Null if !stack.is_empty() => {}
                    Json::Null => out.push_str("null"),
                    Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
                    Json::Number(n) => out.push_str(&number_to_string(*n)),
                    Json::String(s) => out.push_str(s),
                    Json::Array(items) => stack.push((items.iter(), true)),
                    Json::Object(_) => out.push_str("[object Object]"),
                }
            }
            match stack.last_mut() {
                None => return out,
                Some((iter, first)) => match iter.next() {
                    Some(child) => {
                        if !std::mem::replace(first, false) {
                            out.push(',');
                        }
                        next = Some(child);
                    }
                    None => {
                        stack.pop();
                    }
                },
            }
        }
    }

    /// ToPrimitive then, for a relational operator, the string or the number.
    fn to_operand(&self) -> Operand {
        match self {
            Json::Array(_) | Json::Object(_) => Operand::Text(self.to_js_string()),
            Json::String(s) => Operand::Text(s.clone()),
            Json::Null => Operand::Number(0.0),
            Json::Bool(b) => Operand::Number(f64::from(u8::from(*b))),
            Json::Number(n) => Operand::Number(*n),
        }
    }
}

/// An operand of a JS relational operator after ToPrimitive.
enum Operand {
    Text(String),
    Number(f64),
}

impl Operand {
    fn to_number(&self) -> f64 {
        match self {
            Operand::Number(n) => *n,
            Operand::Text(s) => jsnum::string_to_number(s),
        }
    }
}

/// JS `a < b` and `a >= b` on two values that came out of JSON: two strings
/// compare as UTF-16 code units, anything else as numbers (NaN is false in
/// both).
fn compare(a: &Json, b: &Json) -> Option<std::cmp::Ordering> {
    match (a.to_operand(), b.to_operand()) {
        (Operand::Text(x), Operand::Text(y)) => Some(cmp_utf16(&x, &y)),
        (x, y) => x.to_number().partial_cmp(&y.to_number()),
    }
}

pub(crate) fn less(a: &Json, b: &Json) -> bool {
    compare(a, b).is_some_and(std::cmp::Ordering::is_lt)
}

pub(crate) fn at_least(a: &Json, b: &Json) -> bool {
    compare(a, b).is_some_and(std::cmp::Ordering::is_ge)
}

/// `JSON.stringify` of a string.
fn quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// One open array or object while [`Json::parse`] runs; the parser keeps its
/// own stack so nesting depth is not limited by the call stack.
enum Frame {
    Array(Vec<Json>),
    Object(Vec<(String, Json)>, String),
}

/// `JSON.parse`'s grammar over bytes, with V8's approximate error text.
struct Parser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    at: usize,
}

impl Json {
    /// `JSON.parse(text)`. Object keys come out in `Object.keys` order
    /// (integer-like keys ascending, then insertion order; a repeated key
    /// keeps its first position and its last value). A number too large for
    /// f64 is Infinity; a lone surrogate escape becomes U+FFFD (R7.2). There
    /// is no depth limit. Error text is approximate (R7.3).
    pub fn parse(text: &str) -> Result<Json, String> {
        let mut p = Parser {
            text,
            bytes: text.as_bytes(),
            at: 0,
        };
        let mut stack: Vec<Frame> = Vec::new();
        'value: loop {
            p.skip_space();
            let mut value = match p.peek() {
                Some(b'[') => {
                    p.at += 1;
                    p.skip_space();
                    if p.peek() == Some(b']') {
                        p.at += 1;
                        Json::Array(Vec::new())
                    } else {
                        stack.push(Frame::Array(Vec::new()));
                        continue 'value;
                    }
                }
                Some(b'{') => {
                    p.at += 1;
                    p.skip_space();
                    if p.peek() == Some(b'}') {
                        p.at += 1;
                        Json::Object(IndexMap::new())
                    } else {
                        let key = p.key()?;
                        stack.push(Frame::Object(Vec::new(), key));
                        continue 'value;
                    }
                }
                _ => p.scalar()?,
            };
            loop {
                p.skip_space();
                match stack.last_mut() {
                    None => {
                        return if p.at == p.bytes.len() {
                            Ok(value)
                        } else {
                            Err(p.unexpected())
                        };
                    }
                    Some(Frame::Array(items)) => {
                        items.push(value);
                        match p.peek() {
                            Some(b',') => {
                                p.at += 1;
                                continue 'value;
                            }
                            Some(b']') => {
                                p.at += 1;
                                let Some(Frame::Array(done)) = stack.pop() else {
                                    return Err(p.unexpected());
                                };
                                value = Json::Array(done);
                            }
                            _ => return Err(p.unexpected()),
                        }
                    }
                    Some(Frame::Object(pairs, key)) => {
                        pairs.push((std::mem::take(key), value));
                        match p.peek() {
                            Some(b',') => {
                                p.at += 1;
                                p.skip_space();
                                *key = p.key()?;
                                continue 'value;
                            }
                            Some(b'}') => {
                                p.at += 1;
                                let Some(Frame::Object(done, _)) = stack.pop() else {
                                    return Err(p.unexpected());
                                };
                                value = Json::Object(ordered(done));
                            }
                            _ => return Err(p.unexpected()),
                        }
                    }
                }
            }
        }
    }
}

/// The pairs as an object: duplicates collapsed, then `Object.keys` order.
fn ordered(pairs: Vec<(String, Json)>) -> IndexMap<String, Json> {
    let mut map: IndexMap<String, Json> = IndexMap::new();
    for (k, v) in pairs {
        map.insert(k, v);
    }
    let keys: Vec<&String> = map.keys().collect();
    let order = object_key_order(&keys);
    let mut slots: Vec<Option<(String, Json)>> = map.into_iter().map(Some).collect();
    let mut sorted = IndexMap::with_capacity(slots.len());
    for i in order {
        if let Some((k, v)) = slots[i].take() {
            sorted.insert(k, v);
        }
    }
    sorted
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn unexpected(&self) -> String {
        match self
            .text
            .get(self.at..)
            .and_then(|rest| rest.chars().next())
        {
            None => "Unexpected end of JSON input".to_string(),
            Some(c) => {
                let position = self.text[..self.at].encode_utf16().count();
                format!("Unexpected token {c} in JSON at position {position}")
            }
        }
    }

    /// An object key and the `:` after it.
    fn key(&mut self) -> Result<String, String> {
        if self.peek() != Some(b'"') {
            return Err(self.unexpected());
        }
        let key = self.string()?;
        self.skip_space();
        if self.peek() != Some(b':') {
            return Err(self.unexpected());
        }
        self.at += 1;
        Ok(key)
    }

    fn scalar(&mut self) -> Result<Json, String> {
        match self.peek() {
            Some(b'"') => self.string().map(Json::String),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(b't') => self.word("true", Json::Bool(true)),
            Some(b'f') => self.word("false", Json::Bool(false)),
            Some(b'n') => self.word("null", Json::Null),
            _ => Err(self.unexpected()),
        }
    }

    fn word(&mut self, word: &str, value: Json) -> Result<Json, String> {
        for expected in word.bytes() {
            if self.peek() != Some(expected) {
                return Err(self.unexpected());
            }
            self.at += 1;
        }
        Ok(value)
    }

    fn digits(&mut self) -> Result<(), String> {
        if !matches!(self.peek(), Some(b'0'..=b'9')) {
            return Err(self.unexpected());
        }
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        Ok(())
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        if self.peek() == Some(b'0') {
            self.at += 1;
        } else {
            self.digits()?;
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            self.digits()?;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            self.digits()?;
        }
        // Rust parses an overflowing literal to infinity, as JS does.
        Ok(Json::Number(
            self.text[start..self.at].parse::<f64>().unwrap_or(f64::NAN),
        ))
    }

    fn hex4(&mut self) -> Result<u16, String> {
        let mut unit = 0u16;
        for _ in 0..4 {
            let Some(d) = self.peek().and_then(|b| char::from(b).to_digit(16)) else {
                return Err(self.unexpected());
            };
            unit = unit * 16 + d as u16;
            self.at += 1;
        }
        Ok(unit)
    }

    /// A string literal as UTF-16 units, decoded lossily at the end (R7.2).
    fn string(&mut self) -> Result<String, String> {
        self.at += 1;
        let mut units: Vec<u16> = Vec::new();
        loop {
            let Some(b) = self.peek() else {
                return Err(self.unexpected());
            };
            match b {
                b'"' => {
                    self.at += 1;
                    return Ok(String::from_utf16_lossy(&units));
                }
                b'\\' => {
                    self.at += 1;
                    let Some(e) = self.peek() else {
                        return Err(self.unexpected());
                    };
                    self.at += 1;
                    let unit = match e {
                        b'"' => 0x22,
                        b'\\' => 0x5c,
                        b'/' => 0x2f,
                        b'b' => 0x08,
                        b'f' => 0x0c,
                        b'n' => 0x0a,
                        b'r' => 0x0d,
                        b't' => 0x09,
                        b'u' => self.hex4()?,
                        _ => {
                            self.at -= 1;
                            return Err(self.unexpected());
                        }
                    };
                    units.push(unit);
                }
                0..=0x1f => return Err(self.unexpected()),
                _ => {
                    let Some(c) = self.text.get(self.at..).and_then(|r| r.chars().next()) else {
                        return Err(self.unexpected());
                    };
                    let mut buf = [0u16; 2];
                    units.extend_from_slice(c.encode_utf16(&mut buf));
                    self.at += c.len_utf8();
                }
            }
        }
    }
}
