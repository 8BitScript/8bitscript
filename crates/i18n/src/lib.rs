//! Port of packages/compiler/src/i18n/index.mjs:1-512
//!
//! Message catalogs: `src/i18n/<locale>.8bs` imported as `@8bitscript/i18n/catalog`. A catalog
//! is exported namespaces of string consts. The selected locale is merged with the fallback at
//! link time, placeholders `{name}` must match the default locale, and Latin Unicode is
//! transliterated into the portable set before anything reaches the machine.
//!
//! The regular expressions of the JS (`PLACEHOLDER`, `PORTABLE_CHARACTERS`,
//! `CATALOG_CHARACTERS`, the `isI18nPackageFile` pattern) are hand matchers over the same
//! character sets.

pub mod fs;
pub mod path;
pub mod tap;

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use syntax::{Node, NodeKind, SourceKind, children_mut};

pub use fs::{CatalogFs, RealFs, RootedFs};

pub const CATALOG_SPECIFIER: &str = "@8bitscript/i18n/catalog";
pub const DEFAULT_CATALOG: &str = "src/i18n";
/// The charset applied when none is configured.
pub const DEFAULT_CHARSET: &str = "transliterate";

/// Latin extras a catalog may spell; width is the replacement's length.
pub const TRANSLITERATIONS: [(char, &str); 7] = [
    ('Ä', "AE"),
    ('Ö', "OE"),
    ('Ü', "UE"),
    ('ä', "ae"),
    ('ö', "oe"),
    ('ü', "ue"),
    ('ß', "SS"),
];

/// `PORTABLE_CHARACTERS` = `/^[ 0-9A-Za-z!,\-.:?]*$/` on one character.
#[must_use]
pub fn is_portable_character(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '!' | ',' | '-' | '.' | ':' | '?')
}

/// `CATALOG_CHARACTERS` = `/^[ 0-9A-Za-z!,\-.:?{}]*$/` on one character: catalog templates may
/// also hold `{name}` placeholders.
#[must_use]
pub fn is_catalog_character(ch: char) -> bool {
    is_portable_character(ch) || matches!(ch, '{' | '}')
}

/// `PORTABLE_CHARACTERS.test(text)`.
#[must_use]
pub fn is_portable_text(text: &str) -> bool {
    text.chars().all(is_portable_character)
}

/// `CATALOG_CHARACTERS.test(text)`.
#[must_use]
pub fn is_catalog_text(text: &str) -> bool {
    text.chars().all(is_catalog_character)
}

/// Every match of `PLACEHOLDER` = `/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g` in `text`, as
/// `(start, end, name)` byte ranges. The regex tries each position in turn, so `{{a}` matches
/// at the second brace.
fn placeholder_matches(text: &str) -> Vec<(usize, usize, &str)> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{'
            && bytes
                .get(i + 1)
                .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
        {
            let name_start = i + 1;
            let mut j = name_start + 1;
            while bytes
                .get(j)
                .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
            {
                j += 1;
            }
            if bytes.get(j) == Some(&b'}') {
                found.push((i, j + 1, &text[name_start..j]));
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    found
}

/// `{name}` placeholders in `text`, in source order, unique. `None` is the JS non-string.
#[must_use]
pub fn placeholders_of(text: Option<&str>) -> Vec<String> {
    let Some(text) = text else {
        return Vec::new();
    };
    let mut seen: IndexSet<&str> = IndexSet::new();
    for (_, _, name) in placeholder_matches(text) {
        seen.insert(name);
    }
    seen.into_iter().map(str::to_string).collect()
}

/// The names JS finds on `Object.prototype` when it reads `params[name]` and `params` has no
/// own property of that name, with the text `String(value)` gives for each (V8's, for Node).
const PROTOTYPE_PROPERTIES: [(&str, &str); 12] = [
    ("constructor", "function Object() { [native code] }"),
    (
        "__defineGetter__",
        "function __defineGetter__() { [native code] }",
    ),
    (
        "__defineSetter__",
        "function __defineSetter__() { [native code] }",
    ),
    (
        "hasOwnProperty",
        "function hasOwnProperty() { [native code] }",
    ),
    (
        "__lookupGetter__",
        "function __lookupGetter__() { [native code] }",
    ),
    (
        "__lookupSetter__",
        "function __lookupSetter__() { [native code] }",
    ),
    (
        "isPrototypeOf",
        "function isPrototypeOf() { [native code] }",
    ),
    (
        "propertyIsEnumerable",
        "function propertyIsEnumerable() { [native code] }",
    ),
    ("toString", "function toString() { [native code] }"),
    ("valueOf", "function valueOf() { [native code] }"),
    ("__proto__", "[object Object]"),
    (
        "toLocaleString",
        "function toLocaleString() { [native code] }",
    ),
];

/// `params[name]` as text: an own value, else what the prototype chain gives.
fn param_value<'a>(params: &'a IndexMap<String, String>, name: &str) -> Option<&'a str> {
    params.get(name).map(String::as_str).or_else(|| {
        PROTOTYPE_PROPERTIES
            .iter()
            .find(|(proto, _)| *proto == name)
            .map(|(_, text)| *text)
    })
}

/// Substitute `{name}` from `params` (insertion order, as the JS object was written). Missing
/// or leftover names are an error.
///
/// A placeholder named like a property of `Object.prototype` (`constructor`, `toString`, ...)
/// is never missing in JS: `params[name]` finds the inherited function and the template gets
/// its source text. [`PROTOTYPE_PROPERTIES`] reproduces that.
///
/// # Errors
///
/// The JS `error` text when a placeholder has no value or a value has no placeholder.
pub fn format_message(template: &str, params: &IndexMap<String, String>) -> Result<String, String> {
    let needed = placeholders_of(Some(template));
    let keys: Vec<&String> = params.keys().collect();
    let extra: Vec<&String> = jsnum::object_key_order(&keys)
        .into_iter()
        .map(|i| keys[i])
        .filter(|name| !needed.contains(name))
        .collect();
    let missing: Vec<&String> = needed
        .iter()
        .filter(|n| param_value(params, n).is_none())
        .collect();
    if let Some(first) = missing.first() {
        return Err(format!("i18n.format is missing {{{first}}}"));
    }
    if let Some(first) = extra.first() {
        return Err(format!(
            "i18n.format was given '{first}', which is not a placeholder in the template"
        ));
    }
    let mut out = String::new();
    let mut last = 0;
    for (start, end, name) in placeholder_matches(template) {
        out.push_str(&template[last..start]);
        out.push_str(param_value(params, name).unwrap_or_default());
        last = end;
    }
    out.push_str(&template[last..]);
    Ok(out)
}

/// What [`transliterate`] returns: the mapped text, and the characters nothing maps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Transliterated {
    pub text: String,
    pub unmapped: Vec<char>,
}

/// Map Latin extras into the portable set. Unmapped non-portable characters are listed; mapped
/// text is always returned so length can be measured.
#[must_use]
pub fn transliterate(text: &str) -> Transliterated {
    let mut unmapped = Vec::new();
    let mut out = String::new();
    for ch in text.chars() {
        if is_catalog_character(ch) {
            out.push(ch);
            continue;
        }
        if let Some((_, mapped)) = TRANSLITERATIONS.iter().find(|(from, _)| *from == ch) {
            out.push_str(mapped);
            continue;
        }
        unmapped.push(ch);
        out.push(ch);
    }
    Transliterated {
        text: out,
        unmapped,
    }
}

/// Locale `.8bs` basenames in `dir`.
#[must_use]
pub fn discover_catalog_locales(fs: &dyn CatalogFs, dir: &str) -> Vec<String> {
    if !fs.exists(dir) {
        return Vec::new();
    }
    let Some(entries) = fs.read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .iter()
        .filter(|name| name.ends_with(".8bs"))
        .map(|name| diagnostics::strip_source_extension(name).to_string())
        .filter(|name| diagnostics::is_locale_name(name) && !name.contains('.'))
        .collect();
    // Ordinal, not locale-aware: this order feeds build output.
    names.sort_by(|a, b| jsnum::cmp_utf16(a, b));
    names
}

/// The `{ catalogDir? }` argument of `isCatalogFile`.
#[derive(Clone, Copy, Debug, Default)]
pub struct CatalogDir<'a> {
    pub catalog_dir: Option<&'a str>,
}

/// Whether `file` is a message catalog: a locale-named `.8bs` in the project's catalog
/// directory, or, without config, in a directory named `i18n`.
#[must_use]
pub fn is_catalog_file(file: &str, i18n: Option<CatalogDir>) -> bool {
    if file.is_empty() || !diagnostics::is_source_file(file) {
        return false;
    }
    let base = path::basename(file);
    let stem = diagnostics::strip_source_extension(&base);
    if !diagnostics::is_locale_name(stem) || stem.contains('.') {
        return false;
    }
    let parent = path::dirname(&path::resolve(file));
    if let Some(dir) = i18n
        .and_then(|i| i.catalog_dir)
        .filter(|dir| !dir.is_empty())
    {
        return parent == path::resolve(dir);
    }
    path::basename(&parent) == "i18n"
}

/// Walk up from `from_file` looking for `src/i18n` with at least one locale file.
#[must_use]
pub fn infer_catalog_dir(fs: &dyn CatalogFs, from_file: &str) -> Option<String> {
    if from_file.is_empty() {
        return None;
    }
    let mut dir = path::dirname(from_file);
    loop {
        let candidate = path::join(&dir, DEFAULT_CATALOG);
        if !discover_catalog_locales(fs, &candidate).is_empty() {
            return Some(candidate);
        }
        let parent = path::dirname(&dir);
        if parent == dir {
            return None;
        }
        dir = parent;
    }
}

fn unportable_strict(bad: char, file: &str, start: u32, length: u32) -> Diagnostic {
    diagnostic(
        codes::UNPORTABLE_CHARACTER,
        format!(
            "'{bad}' is not in the portable character set (space, 0-9, A-Z, a-z, and ! , - . : ?)"
        ),
        file,
        start,
        length,
        Severity::Error,
    )
}

fn unportable_unmapped(bad: char, file: &str, start: u32, length: u32) -> Diagnostic {
    diagnostic(
        codes::UNPORTABLE_CHARACTER,
        format!("'{bad}' is not in the portable character set and has no Latin transliteration"),
        file,
        start,
        length,
        Severity::Error,
    )
}

/// Apply the catalog charset to string literals in `ast`. Mutates values. Import specifiers
/// are left alone. `charset` is `"transliterate"` or `"strict"`; any other text acts as
/// `"transliterate"`, as in the JS.
pub fn apply_catalog_charset(ast: &mut Node, file: &str, charset: &str) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    visit_charset(ast, false, file, charset == "strict", &mut diagnostics);
    diagnostics
}

fn visit_charset(
    node: &mut Node,
    parent_is_import: bool,
    file: &str,
    strict: bool,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let (start, length) = (node.start, node.length);
    if let NodeKind::StringLiteral { value, .. } = &mut node.kind
        && !parent_is_import
    {
        if strict {
            if !is_catalog_text(value)
                && let Some(bad) = value.chars().find(|ch| !is_catalog_character(*ch))
            {
                diagnostics.push(unportable_strict(bad, file, start, length));
            }
            return;
        }
        let mapped = transliterate(value);
        *value = mapped.text;
        if let Some(bad) = mapped.unmapped.first() {
            diagnostics.push(unportable_unmapped(*bad, file, start, length));
        }
        return;
    }
    let is_import = matches!(node.kind, NodeKind::ImportDeclaration { .. });
    for child in children_mut(node) {
        visit_charset(child, is_import, file, strict, diagnostics);
    }
}

/// One `const NAME: string = "..."` of a catalog namespace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Member {
    pub value: Option<String>,
    pub placeholders: Vec<String>,
    pub start: u32,
    pub length: u32,
    pub file: String,
}

/// A catalog shape error found while reading the schema.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Extra {
    pub message: String,
    pub start: u32,
    pub length: u32,
    pub file: String,
}

/// `{ namespaces: Map<string, Map<string, Member>>, extras }`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Schema {
    pub namespaces: IndexMap<String, IndexMap<String, Member>>,
    pub extras: Vec<Extra>,
}

/// `member.name?.name`: the text of the node's `name` child, when the node has one.
fn member_name(node: &Node) -> Option<&str> {
    let name = match &node.kind {
        NodeKind::VariableDeclaration { name, .. }
        | NodeKind::FunctionDeclaration { name, .. }
        | NodeKind::ComponentDeclaration { name, .. }
        | NodeKind::StateDeclaration { name, .. }
        | NodeKind::NamespaceDeclaration { name, .. } => name.as_deref()?,
        NodeKind::Parameter { name, .. } => name,
        _ => return None,
    };
    match &name.kind {
        NodeKind::Identifier { name, .. } | NodeKind::TypeReference { name, .. } => Some(name),
        _ => None,
    }
}

/// Exported namespaces of string consts in a catalog AST.
#[must_use]
pub fn catalog_schema(ast: &Node, file: &str) -> Schema {
    let mut schema = Schema::default();
    let NodeKind::Program { body } = &ast.kind else {
        return schema;
    };
    for node in body {
        if matches!(node.kind, NodeKind::ImportDeclaration { .. }) {
            continue;
        }
        if let NodeKind::NamespaceDeclaration {
            name: Some(name),
            members: nodes,
            exported: true,
        } = &node.kind
        {
            let mut members: IndexMap<String, Member> = IndexMap::new();
            for member in nodes.iter().flatten() {
                if let NodeKind::VariableDeclaration {
                    kind,
                    name: Some(member_name_node),
                    type_annotation,
                    initializer,
                    ..
                } = &member.kind
                    && kind == "const"
                    && matches!(
                        type_annotation.as_deref().map(|t| &t.kind),
                        Some(NodeKind::TypeReference { name, .. }) if name == "string"
                    )
                {
                    let value = match initializer.as_deref().map(|i| &i.kind) {
                        Some(NodeKind::StringLiteral { value, .. }) => Some(value.clone()),
                        _ => None,
                    };
                    let key = match &member_name_node.kind {
                        NodeKind::Identifier { name, .. } => name.clone(),
                        _ => String::new(),
                    };
                    members.insert(
                        key,
                        Member {
                            placeholders: placeholders_of(value.as_deref()),
                            value,
                            start: member_name_node.start,
                            length: member_name_node.length,
                            file: file.to_string(),
                        },
                    );
                    continue;
                }
                schema.extras.push(Extra {
                    message: format!(
                        "a message catalog may make only mods of string consts pub; '{}' is not one",
                        member_name(member).unwrap_or_else(|| member.type_name())
                    ),
                    start: member.start,
                    length: member.length,
                    file: file.to_string(),
                });
            }
            let namespace = match &name.kind {
                NodeKind::Identifier { name, .. } => name.clone(),
                _ => String::new(),
            };
            schema.namespaces.insert(namespace, members);
            continue;
        }
        schema.extras.push(Extra {
            message: "a message catalog may make only mods of string consts pub".to_string(),
            start: node.start,
            length: node.length,
            file: file.to_string(),
        });
    }
    schema
}

/// A catalog file read, lexed and parsed (`parseCatalogFile`).
struct CatalogModule {
    file: String,
    ast: Node,
    diagnostics: Vec<Diagnostic>,
}

fn parse_catalog_file(fs: &dyn CatalogFs, file: &str) -> Result<CatalogModule, String> {
    let text = fs.read_to_string(file)?;
    let source_kind = diagnostics::source_kind_of(file).unwrap_or(SourceKind::Bs);
    let lexed = lexer::tokenize(
        &text,
        file,
        &lexer::Options {
            source_kind: Some(source_kind),
        },
    );
    let parsed = parser::parse(
        &lexed.tokens,
        &text,
        file,
        &parser::Options {
            source_kind: Some(source_kind),
        },
    );
    let mut diagnostics = lexed.diagnostics;
    diagnostics.extend(parsed.diagnostics);
    Ok(CatalogModule {
        file: file.to_string(),
        ast: parsed.ast,
        diagnostics,
    })
}

/// Compare `other` against `baseline` (the default locale). Extra keys and placeholder
/// mismatches are errors; missing keys are filled later.
///
/// A namespace with no members has no file in JS (`catalogSchema` sets no `file` on the schema)
/// and the diagnostic's `file` is missing; here that is `""`.
#[must_use]
pub fn compare_catalog_schemas(baseline: &Schema, other: &Schema, locale: &str) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    for extra in &other.extras {
        diagnostics.push(diagnostic(
            codes::CATALOG,
            extra.message.clone(),
            &extra.file,
            extra.start,
            extra.length,
            Severity::Error,
        ));
    }
    for (ns, members) in &other.namespaces {
        let Some(expected) = baseline.namespaces.get(ns) else {
            let first = members.values().next();
            diagnostics.push(diagnostic(
                codes::CATALOG_SCHEMA,
                format!("locale '{locale}' has pub mod '{ns}', which the default locale does not"),
                first.map_or("", |m| m.file.as_str()),
                first.map_or(0, |m| m.start),
                first.map_or(0, |m| m.length),
                Severity::Error,
            ));
            continue;
        };
        for (name, member) in members {
            let Some(want) = expected.get(name) else {
                diagnostics.push(diagnostic(
                    codes::CATALOG_SCHEMA,
                    format!(
                        "locale '{locale}' exports {ns}.{name}, which the default locale does not"
                    ),
                    &member.file,
                    member.start,
                    member.length,
                    Severity::Error,
                ));
                continue;
            };
            let want = &want.placeholders;
            let have = &member.placeholders;
            if want != have {
                let list = |names: &[String]| {
                    if names.is_empty() {
                        "none".to_string()
                    } else {
                        names.join("}, {")
                    }
                };
                diagnostics.push(diagnostic(
                    codes::CATALOG_PLACEHOLDER,
                    format!(
                        "{ns}.{name} in locale '{locale}' has placeholders {{{}}}; the default locale has {{{}}}",
                        list(have),
                        list(want)
                    ),
                    &member.file,
                    member.start,
                    member.length,
                    Severity::Error,
                ));
            }
        }
    }
    diagnostics
}

/// `JSON.stringify(text)` for a string.
fn quote_8bs(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

fn emit_catalog(baseline: &Schema, values: &IndexMap<String, IndexMap<String, String>>) -> String {
    let mut lines: Vec<String> = vec![
        "// Merged message catalog \u{2014} selected locale, with missing keys from the fallback."
            .to_string(),
        "// Generated by the compiler; do not edit.".to_string(),
        String::new(),
    ];
    for (ns, members) in &baseline.namespaces {
        lines.push(format!("pub mod {ns} {{"));
        for name in members.keys() {
            let value = values
                .get(ns)
                .and_then(|row| row.get(name))
                .map_or("", String::as_str);
            lines.push(format!("    const {name}: string = {};", quote_8bs(value)));
        }
        lines.push("}".to_string());
        lines.push(String::new());
    }
    lines.join("\n")
}

fn take_value(member: &Member, strict: bool, diagnostics: &mut Vec<Diagnostic>) -> String {
    let Some(value) = &member.value else {
        return String::new();
    };
    if strict {
        if !is_catalog_text(value)
            && let Some(bad) = value.chars().find(|ch| !is_catalog_character(*ch))
        {
            diagnostics.push(unportable_strict(
                bad,
                &member.file,
                member.start,
                member.length,
            ));
        }
        return value.clone();
    }
    let mapped = transliterate(value);
    if let Some(bad) = mapped.unmapped.first() {
        diagnostics.push(unportable_unmapped(
            *bad,
            &member.file,
            member.start,
            member.length,
        ));
    }
    mapped.text
}

/// The `i18n` options of a project (`i18n.catalog` in `8bitscript.config.ts`, resolved), plus
/// the cache `resolveCatalogSpecifier` leaves on the object (`prepared`, `preparedLocale`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct I18nOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locales: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepared: Option<Prepared>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepared_locale: Option<String>,
}

/// `prepareCatalog` result: `{ ok, path?, text?, diagnostics }`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prepared {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
}

/// The `{ locale?, i18n?, fromFile? }` argument of `prepareCatalog`.
#[derive(Clone, Copy, Debug, Default)]
pub struct PrepareOptions<'a> {
    pub locale: Option<&'a str>,
    pub i18n: Option<&'a I18nOptions>,
    pub from_file: Option<&'a str>,
}

/// Load every locale in the catalog directory, check schema/placeholders, merge fallback into
/// the selected locale, and emit one portable module.
///
/// # Errors
///
/// A catalog file that exists but cannot be read: the error JS throws, as Node's text.
pub fn prepare_catalog(fs: &dyn CatalogFs, options: &PrepareOptions) -> Result<Prepared, String> {
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let i18n = options.i18n;
    let Some(catalog_dir) = i18n
        .and_then(|i| i.catalog_dir.as_deref())
        .filter(|dir| !dir.is_empty())
    else {
        return Ok(Prepared {
            ok: false,
            path: None,
            text: None,
            diagnostics: vec![diagnostic(
                codes::CATALOG,
                format!(
                    "'{CATALOG_SPECIFIER}' needs a message catalog (src/i18n/<locale>.8bs, or i18n.catalog in 8bitscript.config.ts)"
                ),
                options.from_file.unwrap_or("<unknown>"),
                0,
                0,
                Severity::Error,
            )],
        });
    };
    let i18n = i18n.cloned().unwrap_or_default();

    let default_locale = i18n.default_locale.as_deref().unwrap_or("en");
    let fallback_locale = i18n.fallback_locale.as_deref().unwrap_or(default_locale);
    let selected_locale = options.locale.unwrap_or(default_locale);
    let strict = i18n.charset.as_deref().unwrap_or(DEFAULT_CHARSET) == "strict";
    let locales: Vec<String> = match &i18n.locales {
        Some(list) if !list.is_empty() => list.clone(),
        _ => discover_catalog_locales(fs, catalog_dir),
    };

    let default_path = path::join(catalog_dir, &format!("{default_locale}.8bs"));
    if !fs.exists(&default_path) {
        return Ok(Prepared {
            ok: false,
            path: None,
            text: None,
            diagnostics: vec![diagnostic(
                codes::CATALOG,
                format!(
                    "message catalog '{default_path}' is missing \u{2014} the default locale '{default_locale}' needs a file"
                ),
                options.from_file.unwrap_or(&default_path),
                0,
                0,
                Severity::Error,
            )],
        });
    }

    let mut parsed: IndexMap<&str, CatalogModule> = IndexMap::new();
    for locale in &locales {
        let locale_path = path::join(catalog_dir, &format!("{locale}.8bs"));
        if !fs.exists(&locale_path) {
            diagnostics.push(diagnostic(
                codes::CATALOG,
                format!("message catalog '{locale_path}' is missing"),
                &locale_path,
                0,
                0,
                Severity::Error,
            ));
            continue;
        }
        let module = parse_catalog_file(fs, &locale_path)?;
        diagnostics.extend(module.diagnostics.iter().cloned());
        parsed.insert(locale, module);
    }
    let Some(default_module) = parsed.get(default_locale) else {
        return Ok(Prepared {
            ok: false,
            path: None,
            text: None,
            diagnostics,
        });
    };

    let baseline = catalog_schema(&default_module.ast, &default_module.file);
    for extra in &baseline.extras {
        diagnostics.push(diagnostic(
            codes::CATALOG,
            extra.message.clone(),
            &extra.file,
            extra.start,
            extra.length,
            Severity::Error,
        ));
    }

    for (locale, module) in &parsed {
        if *locale == default_locale {
            continue;
        }
        let schema = catalog_schema(&module.ast, &module.file);
        diagnostics.extend(compare_catalog_schemas(&baseline, &schema, locale));
    }

    let selected = parsed
        .get(selected_locale)
        .or_else(|| parsed.get(fallback_locale))
        .or_else(|| parsed.get(default_locale));
    let fallback = parsed
        .get(fallback_locale)
        .or_else(|| parsed.get(default_locale));
    let (Some(selected), Some(fallback)) = (selected, fallback) else {
        return Ok(Prepared {
            ok: false,
            path: None,
            text: None,
            diagnostics,
        });
    };
    let selected_schema = catalog_schema(&selected.ast, &selected.file);
    let fallback_schema = catalog_schema(&fallback.ast, &fallback.file);

    let mut values: IndexMap<String, IndexMap<String, String>> = IndexMap::new();
    for (ns, members) in &baseline.namespaces {
        let mut row = IndexMap::new();
        for (name, def) in members {
            let from_selected = selected_schema.namespaces.get(ns).and_then(|m| m.get(name));
            let from_fallback = fallback_schema.namespaces.get(ns).and_then(|m| m.get(name));
            let member = from_selected.or(from_fallback).unwrap_or(def);
            row.insert(name.clone(), take_value(member, strict, &mut diagnostics));
        }
        values.insert(ns.clone(), row);
    }

    let selected_file = path::join(catalog_dir, &format!("{selected_locale}.8bs"));
    let selected_path = if fs.exists(&selected_file) {
        selected_file
    } else {
        default_path
    };
    let text = emit_catalog(&baseline, &values);
    let ok = diagnostics.iter().all(|d| d.severity == Severity::Warning);
    Ok(Prepared {
        ok,
        path: Some(selected_path),
        text: Some(text),
        diagnostics,
    })
}

/// The options `resolveCatalogSpecifier` reads from the resolver's options object. It writes
/// `i18n` (inferred) and its cache back, as the JS does.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ResolveOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub i18n: Option<I18nOptions>,
}

/// What `resolveCatalogSpecifier` answers when the specifier is the catalog's.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum CatalogResolution {
    /// `{ path, text, catalog: true, diagnostics }`.
    Found {
        path: String,
        text: String,
        catalog: bool,
        diagnostics: Vec<Diagnostic>,
    },
    /// `{ code, message, diagnostics? }`; the diagnostics are absent when no catalog directory
    /// could be found at all.
    Failed {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnostics: Option<Vec<Diagnostic>>,
    },
}

/// Resolve `@8bitscript/i18n/catalog` to the merged selected catalog. `None` is the JS `null`:
/// the specifier is not the catalog's.
///
/// # Errors
///
/// A catalog file that exists but cannot be read (see [`prepare_catalog`]).
pub fn resolve_catalog_specifier(
    fs: &dyn CatalogFs,
    specifier: &str,
    from_file: &str,
    options: &mut ResolveOptions,
) -> Result<Option<CatalogResolution>, String> {
    if specifier != CATALOG_SPECIFIER {
        return Ok(None);
    }
    if options.i18n.is_none() {
        let Some(catalog_dir) = infer_catalog_dir(fs, from_file) else {
            return Ok(Some(CatalogResolution::Failed {
                code: codes::CATALOG.to_string(),
                message: format!(
                    "'{CATALOG_SPECIFIER}' needs a message catalog (src/i18n/<locale>.8bs, or i18n.catalog in 8bitscript.config.ts)"
                ),
                diagnostics: None,
            }));
        };
        options.i18n = Some(I18nOptions {
            locales: Some(discover_catalog_locales(fs, &catalog_dir)),
            catalog_dir: Some(catalog_dir),
            default_locale: Some("en".to_string()),
            fallback_locale: Some("en".to_string()),
            charset: Some(DEFAULT_CHARSET.to_string()),
            ..I18nOptions::default()
        });
    }
    let locale_key = options
        .locale
        .clone()
        .or_else(|| options.i18n.as_ref().and_then(|i| i.default_locale.clone()))
        .unwrap_or_else(|| "en".to_string());
    let stale = options
        .i18n
        .as_ref()
        .is_some_and(|i| i.prepared.is_none() || i.prepared_locale.as_deref() != Some(&locale_key));
    if stale {
        let prepared = prepare_catalog(
            fs,
            &PrepareOptions {
                locale: options.locale.as_deref(),
                i18n: options.i18n.as_ref(),
                from_file: Some(from_file),
            },
        )?;
        if let Some(i18n) = options.i18n.as_mut() {
            i18n.prepared = Some(prepared);
            i18n.prepared_locale = Some(locale_key);
        }
    }
    let Some(prepared) = options.i18n.as_ref().and_then(|i| i.prepared.as_ref()) else {
        return Ok(None);
    };
    match prepared.path.as_deref().filter(|p| !p.is_empty()) {
        Some(path) if prepared.ok => Ok(Some(CatalogResolution::Found {
            path: path.to_string(),
            text: prepared.text.clone().unwrap_or_default(),
            catalog: true,
            diagnostics: prepared.diagnostics.clone(),
        })),
        _ => {
            let first = prepared.diagnostics.first();
            Ok(Some(CatalogResolution::Failed {
                code: first.map_or_else(|| codes::CATALOG.to_string(), |d| d.code.clone()),
                message: first.map_or_else(
                    || format!("'{CATALOG_SPECIFIER}' could not load a message catalog"),
                    |d| d.message.clone(),
                ),
                diagnostics: Some(prepared.diagnostics.clone()),
            }))
        }
    }
}

/// Whether `file` is this package's `@8bitscript/i18n` entry (any locale twin): the
/// pattern `/\/i18n\/src\/index(?:\.[A-Za-z0-9-]+)?\.8bs$/` on the path with `\` as `/`.
#[must_use]
pub fn is_i18n_package_file(file: &str) -> bool {
    if file.is_empty() {
        return false;
    }
    let normalized = file.replace('\\', "/");
    let Some(head) = normalized.strip_suffix(".8bs") else {
        return false;
    };
    // `.../i18n/src/index` or `.../i18n/src/index.<tag>`.
    let Some(at) = head.rfind("/i18n/src/index") else {
        return false;
    };
    let rest = &head[at + "/i18n/src/index".len()..];
    // The regex may also match with the optional tag taken out of an earlier occurrence, so try
    // every occurrence from the right.
    if tag_ok(rest) {
        return true;
    }
    let mut end = at;
    while let Some(earlier) = head[..end].rfind("/i18n/src/index") {
        if tag_ok(&head[earlier + "/i18n/src/index".len()..]) {
            return true;
        }
        end = earlier;
    }
    false
}

/// `(?:\.[A-Za-z0-9-]+)?` and nothing after it.
fn tag_ok(rest: &str) -> bool {
    match rest.strip_prefix('.') {
        None => rest.is_empty(),
        Some(tag) => !tag.is_empty() && tag.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
    }
}
