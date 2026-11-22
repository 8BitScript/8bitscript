//! The bridge (port spec 4.1): the lexer, the parser and the pair check
//! behind JSON in, JSON out. The pure functions work on bytes so native
//! tests can call them; the wasm exports (`front_alloc`, `front_free`,
//! `front_tokenize`, `front_parse`, `front_check`) wrap them with a linear
//! memory convention and exist only on `wasm32`. There are no host imports.
//!
//! Malformed input is an `{"error": "..."}` reply, never a trap (R6.5).

use lexer::{Options as LexOptions, tokenize};
use parser::{Options as ParseOptions, parse, strip_tests};
use serde_json::{Value, json};
use syntax::{SourceKind, differences};

/// How many differences `front_check` reports.
pub const MAX_DIFFERENCES: usize = 20;

/// Deepest tree `front_check` compares; deeper input is an error reply so
/// the comparison never runs out of the 1 MB wasm stack.
const MAX_DEPTH: usize = 256;

struct Request {
    file: String,
    kind: SourceKind,
    body: Value,
}

fn request(input: &[u8]) -> Result<Request, String> {
    let body: Value = serde_json::from_slice(input).map_err(|e| format!("bad request: {e}"))?;
    let file = match body.get("file") {
        None | Some(Value::Null) => "<unknown>".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return Err("bad request: `file` must be a string".to_string()),
    };
    let kind = match body.get("sourceKind") {
        None | Some(Value::Null) => SourceKind::Bs,
        Some(Value::String(s)) => match SourceKind::from_extension(s) {
            Some(kind @ (SourceKind::Bs | SourceKind::Bx)) => kind,
            _ => return Err(format!("unsupported sourceKind `{s}`")),
        },
        Some(_) => return Err("bad request: `sourceKind` must be a string".to_string()),
    };
    Ok(Request { file, kind, body })
}

fn text_of<'a>(req: &'a Request, key: &str) -> Result<&'a str, String> {
    req.body
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("bad request: `{key}` must be a string"))
}

fn error_reply(message: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "error": message }))
        .unwrap_or_else(|_| br#"{"error":"could not serialize the reply"}"#.to_vec())
}

fn reply(result: Result<Value, String>) -> Vec<u8> {
    match result {
        Ok(value) => serde_json::to_vec(&value)
            .unwrap_or_else(|_| br#"{"error":"could not serialize the reply"}"#.to_vec()),
        Err(message) => error_reply(&message),
    }
}

/// The `front_parse` reply. A derived struct is written in field order; a
/// `Value` would write its keys sorted. The order of `ast` comes from
/// `syntax::Node`, which matches the parser's property order.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ParseReply<'a, D> {
    tokens: &'a [syntax::Token],
    ast: &'a syntax::Node,
    diagnostics: &'a [D],
    lexer_diagnostics: &'a [D],
}

fn lex(req: &Request, text: &str) -> lexer::Lexed {
    tokenize(
        text,
        &req.file,
        &LexOptions {
            source_kind: Some(req.kind),
        },
    )
}

fn parse_options(req: &Request) -> ParseOptions {
    ParseOptions {
        source_kind: Some(req.kind),
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| format!("could not serialize: {e}"))
}

/// `front_tokenize`: `{file, text, sourceKind}` in, `{tokens, diagnostics}` out.
#[must_use]
pub fn tokenize_json(input: &[u8]) -> Vec<u8> {
    reply((|| {
        let req = request(input)?;
        let lexed = lex(&req, text_of(&req, "text")?);
        Ok(json!({
            "tokens": to_value(&lexed.tokens)?,
            "diagnostics": to_value(&lexed.diagnostics)?,
        }))
    })())
}

/// `front_parse`: `{file, text, sourceKind}` in, `{tokens, ast, diagnostics}`
/// out. `diagnostics` are the parser's, as `parse` returns them; the lexer's
/// are `lexerDiagnostics`, so one call can serve both `tokenize` and `parse`.
#[must_use]
pub fn parse_json(input: &[u8]) -> Vec<u8> {
    let bytes = (|| {
        let req = request(input)?;
        let text = text_of(&req, "text")?;
        let lexed = lex(&req, text);
        let mut parsed = parse(&lexed.tokens, text, &req.file, &parse_options(&req));
        strip_tests(&mut parsed.ast);
        serde_json::to_vec(&ParseReply {
            tokens: &lexed.tokens,
            ast: &parsed.ast,
            diagnostics: &parsed.diagnostics,
            lexer_diagnostics: &lexed.diagnostics,
        })
        .map_err(|e| format!("could not serialize: {e}"))
    })();
    bytes.unwrap_or_else(|message| error_reply(&message))
}

fn depth(value: &Value) -> usize {
    match value {
        Value::Array(items) => 1 + items.iter().map(depth).max().unwrap_or(0),
        Value::Object(map) => 1 + map.values().map(depth).max().unwrap_or(0),
        _ => 0,
    }
}

/// `front_check`: `{file, sourceKind, oldAst, newText}` in,
/// `{equal, differences}` out. Both sides go through `syntax::normalize`.
/// New text that does not lex and parse clean is not equal: its diagnostics
/// come back as one difference at `diagnostics`. The old AST is read with
/// serde_json's nesting limit (128 levels); a deeper one is an error reply.
#[must_use]
pub fn check_json(input: &[u8]) -> Vec<u8> {
    reply((|| {
        let req = request(input)?;
        let new_text = text_of(&req, "newText")?;
        let old_ast = req
            .body
            .get("oldAst")
            .filter(|v| v.is_object())
            .ok_or("bad request: `oldAst` must be an object")?;
        let lexed = lex(&req, new_text);
        let parsed = parse(&lexed.tokens, new_text, &req.file, &parse_options(&req));
        let mut found = Vec::new();
        if !lexed.diagnostics.is_empty() || !parsed.diagnostics.is_empty() {
            let mut all = lexed.diagnostics.clone();
            all.extend(parsed.diagnostics.iter().cloned());
            found.push(json!({"path": "diagnostics", "old": [], "new": to_value(&all)?}));
        } else {
            let new_ast = to_value(&parsed.ast)?;
            if depth(&new_ast) > MAX_DEPTH {
                return Err("the tree is too deep to compare".to_string());
            }
            for d in differences(old_ast, &new_ast, MAX_DIFFERENCES) {
                found.push(json!({"path": d.path, "old": d.old, "new": d.new}));
            }
        }
        Ok(json!({ "equal": found.is_empty(), "differences": found }))
    })())
}

#[cfg(target_arch = "wasm32")]
mod exports {
    //! Linear-memory convention: the host allocates with `front_alloc`,
    //! writes the request, calls an export, reads `len` bytes at `ptr` from
    //! the returned `(ptr << 32) | len`, and frees both with `front_free`.

    fn pack(bytes: Vec<u8>) -> u64 {
        let len = bytes.len();
        let ptr = Box::into_raw(bytes.into_boxed_slice()) as *mut u8 as usize;
        ((ptr as u64) << 32) | len as u64
    }

    /// # Safety
    /// `ptr..ptr + len` must be a live allocation from `front_alloc`.
    unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn front_alloc(len: usize) -> *mut u8 {
        Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
    }

    /// # Safety
    /// `ptr` and `len` must be exactly what `front_alloc` or an export returned.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn front_free(ptr: *mut u8, len: usize) {
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
    }

    /// # Safety
    /// See `input`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn front_tokenize(ptr: *const u8, len: usize) -> u64 {
        pack(super::tokenize_json(unsafe { input(ptr, len) }))
    }

    /// # Safety
    /// See `input`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn front_parse(ptr: *const u8, len: usize) -> u64 {
        pack(super::parse_json(unsafe { input(ptr, len) }))
    }

    /// # Safety
    /// See `input`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn front_check(ptr: *const u8, len: usize) -> u64 {
        pack(super::check_json(unsafe { input(ptr, len) }))
    }
}
