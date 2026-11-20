//! A JSON value as JS holds it after `JSON.parse`, and the JS operations the
//! fact checks apply to one.

use indexmap::IndexMap;
use jsnum::{cmp_utf16, number_to_string, object_key_order};

/// A JSON value as JS holds it after `JSON.parse`: numbers are f64 and an
/// object keeps its keys in the order they were given.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(IndexMap<String, Json>),
}

impl Json {
    /// `JSON.stringify(value)` for a value that has no `undefined` in it.
    #[must_use]
    pub fn stringify(&self) -> String {
        match self {
            Json::Null => "null".to_string(),
            Json::Bool(b) => b.to_string(),
            Json::Number(n) => {
                if n.is_finite() {
                    number_to_string(*n)
                } else {
                    "null".to_string()
                }
            }
            Json::String(s) => quote(s),
            Json::Array(items) => {
                let parts: Vec<String> = items.iter().map(Json::stringify).collect();
                format!("[{}]", parts.join(","))
            }
            Json::Object(map) => {
                let parts: Vec<String> = map
                    .iter()
                    .map(|(k, v)| format!("{}:{}", quote(k), v.stringify()))
                    .collect();
                format!("{{{}}}", parts.join(","))
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
        match self {
            Json::Null => "null".to_string(),
            Json::Bool(b) => b.to_string(),
            Json::Number(n) => number_to_string(*n),
            Json::String(s) => s.clone(),
            Json::Array(items) => items
                .iter()
                .map(|item| {
                    if *item == Json::Null {
                        String::new()
                    } else {
                        item.to_js_string()
                    }
                })
                .collect::<Vec<String>>()
                .join(","),
            Json::Object(_) => "[object Object]".to_string(),
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
