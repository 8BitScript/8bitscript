//! Port of mos/chr-nes.ts

use jsnum::{is_js_whitespace, js_trim, parse_int, to_int32, to_uint8, utf16_len};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A native source file: its tokenized path and its text (`chr-nes.ts:46`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeSource {
    pub path: String,
    pub text: String,
}

/// The section whose bytes become CHR-ROM (`chr-nes.ts:63`).
const CHR_SECTION: &str = ".chr_rom";

/// A macro definition: its parameter names and its body lines.
struct Macro {
    params: Vec<String>,
    body: Vec<String>,
}

/// The assembled CHR-ROM: exactly the requested size, and how many bytes the
/// sources actually wrote (`ChrResult.defined`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChrRom {
    pub bytes: Vec<u8>,
    pub defined: usize,
}

/// Everything after an unquoted `;` or `//` is a comment (`chr-nes.ts:70`).
fn strip_comment(line: &str) -> &str {
    let mut end = line.len();
    if let Some(i) = line.find(';') {
        end = end.min(i);
    }
    if let Some(i) = line.find("//") {
        end = end.min(i);
    }
    &line[..end]
}

/// `a, b, c` split at top-level commas (`chr-nes.ts:87`).
fn split_args(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for ch in text.chars() {
        if ch == '(' {
            depth += 1;
        }
        if ch == ')' {
            depth -= 1;
        }
        if ch == ',' && depth == 0 {
            out.push(js_trim(&current).to_string());
            current.clear();
            continue;
        }
        current.push(ch);
    }
    if !js_trim(&current).is_empty() {
        out.push(js_trim(&current).to_string());
    }
    out
}

// ---- expressions: f64 throughout, like JS numbers -------------------------

struct Cursor {
    text: Vec<char>,
    at: usize,
}

impl Cursor {
    fn peek(&self) -> Option<char> {
        self.text.get(self.at).copied()
    }

    fn skip_space(&mut self) {
        while self.peek().is_some_and(is_js_whitespace) {
            self.at += 1;
        }
    }

    /// Length of the run of chars at `from` that satisfy `ok`.
    fn run(&self, from: usize, ok: impl Fn(char) -> bool) -> usize {
        self.text[from.min(self.text.len())..]
            .iter()
            .take_while(|c| ok(**c))
            .count()
    }

    fn digits(&self, from: usize, len: usize) -> String {
        self.text[from..from + len].iter().collect()
    }
}

/// A literal or a parenthesized expression; `None` when it is neither.
fn parse_primary(c: &mut Cursor) -> Option<f64> {
    c.skip_space();
    match c.peek() {
        Some('(') => {
            c.at += 1;
            let value = parse_bitwise(c)?;
            c.skip_space();
            if c.peek() != Some(')') {
                return None;
            }
            c.at += 1;
            return Some(value);
        }
        Some('-') => {
            c.at += 1;
            return parse_primary(c).map(|v| -v);
        }
        _ => {}
    }
    let at = c.at;
    let prefix = (c.peek(), c.text.get(at + 1).copied());
    if let (Some('0'), Some(x)) = prefix {
        if x == 'x' || x == 'X' {
            let n = c.run(at + 2, |ch| ch.is_ascii_hexdigit());
            if n > 0 {
                let digits = c.digits(at + 2, n);
                c.at += 2 + n;
                return Some(parse_int(&digits, 16));
            }
        }
        if x == 'b' || x == 'B' {
            let n = c.run(at + 2, |ch| ch == '0' || ch == '1');
            if n > 0 {
                let digits = c.digits(at + 2, n);
                c.at += 2 + n;
                return Some(parse_int(&digits, 2));
            }
        }
    }
    let n = c.run(at, |ch| ch.is_ascii_digit());
    if n > 0 {
        let digits = c.digits(at, n);
        c.at += n;
        return Some(parse_int(&digits, 10));
    }
    None
}

fn parse_product(c: &mut Cursor) -> Option<f64> {
    let mut left = parse_primary(c)?;
    loop {
        c.skip_space();
        let op = c.peek();
        if op != Some('*') && op != Some('/') {
            return Some(left);
        }
        c.at += 1;
        let right = parse_primary(c)?;
        left = if op == Some('*') {
            left * right
        } else {
            (left / right).floor()
        };
    }
}

fn parse_sum(c: &mut Cursor) -> Option<f64> {
    let mut left = parse_product(c)?;
    loop {
        c.skip_space();
        let op = c.peek();
        if op != Some('+') && op != Some('-') {
            return Some(left);
        }
        c.at += 1;
        let right = parse_product(c)?;
        left = if op == Some('+') {
            left + right
        } else {
            left - right
        };
    }
}

fn parse_bitwise(c: &mut Cursor) -> Option<f64> {
    let mut left = parse_sum(c)?;
    loop {
        c.skip_space();
        let op = c.peek();
        if !matches!(op, Some('&' | '^' | '|')) {
            return Some(left);
        }
        c.at += 1;
        let right = parse_sum(c)?;
        let (l, r) = (to_int32(left), to_int32(right));
        left = f64::from(match op {
            Some('&') => l & r,
            Some('^') => l ^ r,
            _ => l | r,
        });
    }
}

/// The value of `text`, or `None` if it is not an expression read end to end.
fn evaluate(text: &str) -> Option<f64> {
    let mut c = Cursor {
        text: text.chars().collect(),
        at: 0,
    };
    let value = parse_bitwise(&mut c)?;
    c.skip_space();
    (c.at == c.text.len()).then_some(value)
}

// ---- the reader -----------------------------------------------------------

/// `\name` replaced by the matching argument, longest parameter name first
/// (stable sort on UTF-16 length, `chr-nes.ts:201`).
fn substitute(line: &str, params: &[String], args: &[String]) -> String {
    let mut order: Vec<(&String, &str)> = params
        .iter()
        .enumerate()
        .map(|(i, name)| (name, args.get(i).map_or("", String::as_str)))
        .collect();
    order.sort_by_key(|(name, _)| std::cmp::Reverse(utf16_len(name)));
    let mut out = line.to_string();
    for (name, arg) in order {
        out = out.replace(&format!("\\{name}"), arg);
    }
    out
}

struct State {
    section: Option<String>,
}

/// First JS whitespace position (byte offset), like `line.search(/\s/)`.
fn first_space(line: &str) -> Option<usize> {
    line.char_indices()
        .find(|(_, c)| is_js_whitespace(*c))
        .map(|(i, _)| i)
}

fn read_lines(
    lines: &[String],
    macros: &mut HashMap<String, Macro>,
    state: &mut State,
    out: &mut Vec<u8>,
    path: &str,
    depth: usize,
) -> Result<(), String> {
    if depth > 16 {
        return Err(format!("{path}: macro expansion nested more than 16 deep"));
    }
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].as_str();
        i += 1;
        if line.is_empty() {
            continue;
        }
        let space = first_space(line);
        let head = space.map_or(line, |s| &line[..s]).to_lowercase();
        let rest = space.map_or("", |s| js_trim(&line[s..]));
        let in_chr = state.section.as_deref() == Some(CHR_SECTION);

        if head == ".macro" {
            let args = split_args(rest);
            // JS throws a TypeError on `args[0].search` when there is no name.
            let first = args
                .first()
                .ok_or_else(|| format!("{path}: '.macro' has no name (JS: TypeError)"))?;
            let name_split = first_space(first);
            let name = name_split
                .map_or(first.as_str(), |s| &first[..s])
                .to_string();
            let mut params: Vec<String> = name_split
                .map(|s| vec![js_trim(&first[s..]).to_string()])
                .unwrap_or_default();
            params.extend(args[1..].iter().cloned());
            let mut body = Vec::new();
            while i < lines.len() && lines[i].to_lowercase() != ".endm" {
                body.push(lines[i].clone());
                i += 1;
            }
            if i >= lines.len() {
                return Err(format!("{path}: '.macro {name}' has no matching .endm"));
            }
            i += 1;
            macros.insert(name, Macro { params, body });
            continue;
        }

        if head == ".rept" {
            let count = evaluate(rest)
                .ok_or_else(|| format!("{path}: '.rept {rest}' is not a count this reads"))?;
            let mut body = Vec::new();
            while i < lines.len() && lines[i].to_lowercase() != ".endr" {
                body.push(lines[i].clone());
                i += 1;
            }
            if i >= lines.len() {
                return Err(format!("{path}: '.rept {rest}' has no matching .endr"));
            }
            i += 1;
            let mut n = 0.0;
            while n < count {
                read_lines(&body, macros, state, out, path, depth + 1)?;
                n += 1.0;
            }
            continue;
        }

        if head == ".section" {
            state.section = split_args(rest).into_iter().next();
            continue;
        }

        if head == ".byte" {
            for arg in split_args(rest) {
                let value = evaluate(&arg).ok_or_else(|| {
                    format!("{path}: '{arg}' in a .byte is not a constant expression this reads")
                })?;
                if state.section.as_deref() == Some(CHR_SECTION) {
                    out.push(to_uint8(value));
                }
            }
            continue;
        }

        if head == ".space" || head == ".skip" {
            let count = evaluate(rest)
                .ok_or_else(|| format!("{path}: '{head} {rest}' is not a size this reads"))?;
            if in_chr {
                let mut n = 0.0;
                while n < count {
                    out.push(0);
                    n += 1.0;
                }
            }
            continue;
        }

        // A macro call: the head word, case-sensitively.
        let call = space.map_or(line, |s| &line[..s]);
        if let Some(m) = macros.get(call) {
            let args = split_args(rest);
            let expanded: Vec<String> = m
                .body
                .iter()
                .map(|b| substitute(b, &m.params, &args))
                .collect();
            read_lines(&expanded, macros, state, out, path, depth + 1)?;
            continue;
        }

        return Err(format!(
            "{path}: '{line}' is not something the NES image's CHR reader understands (it reads .section/.macro/.rept/.byte/.space and macro calls, nothing else)"
        ));
    }
    Ok(())
}

/// The CHR-ROM bytes `sources` define, padded with zeros to exactly `size`
/// (`assembleChrRom`, `chr-nes.ts:261`).
pub fn assemble_chr_rom(sources: &[NativeSource], size: i64) -> Result<ChrRom, String> {
    let mut out: Vec<u8> = Vec::new();
    for source in sources {
        let lines: Vec<String> = source
            .text
            .split('\n')
            .map(|line| js_trim(strip_comment(line)).to_string())
            .collect();
        let mut macros = HashMap::new();
        let mut state = State { section: None };
        read_lines(&lines, &mut macros, &mut state, &mut out, &source.path, 0)?;
    }
    let size_usize = usize::try_from(size).map_err(|_| format!("invalid array length {size}"))?;
    if out.len() > size_usize {
        return Err(format!(
            "the NES image's CHR-ROM is {size} bytes and the linked program's .chr_rom sections define {}",
            out.len()
        ));
    }
    let defined = out.len();
    out.resize(size_usize, 0);
    Ok(ChrRom {
        bytes: out,
        defined,
    })
}
