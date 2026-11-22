//! Port of packages/compiler/src/linker/index.mjs:63-114 (parseModule, finishModule) and
//! packages/compiler/index.mjs:95-150 (the analyze order).
//!
//! A module is read in two halves. [`parse_module`] stops before anything that needs to know
//! what an imported name means; [`finish_module`] runs once every import of the graph is bound.
//!
//! R1.10: nothing here calls `syntax::number_nodes` after `bx::elaborate_bx`. The ids the parser
//! gave stay on the tree. A binder symbol's node is read, by `elaborate_bx` for another module's
//! symbol, from the tree as it was before that module's elaboration (`Module::pre_elaboration`).

use std::collections::HashSet;
use std::path::Path;

use bx::check::{CheckOptions as BxCheckOptions, check_bx};
use bx::elaborate::elaborate_bx;
use diagnostics::{Diagnostic, source_kind_of};
use fold::Options as FoldOptions;
use fold::facts::Json;
use i18n::{CatalogDir, I18nOptions, apply_catalog_charset, is_catalog_file};
use indexmap::IndexMap;
use lexer::tokenize;
use lower::module::ModuleIr;
use media::MediaModule;
use media::MediaTokenKind;
use media::elaborate::{ElaborateOptions, elaborate_media};
use media::lexer::MediaToken;
use media::machine::MediaSlots;
use parser::{parse, strip_tests};
use resolver::imports::{ScanToken, with_path_form};
use resolver::specifier::{Resolution, SpecifierOptions, resolve_specifier};
use sema::binder::bind;
use sema::binder::types::{Bound, ModuleId, ScopeId};
use sema::checker::{CheckOptions, check};
use serde_json::Value;
use syntax::{Node, SourceKind, TokenKind};

/// A dumped stage: the files `tokens`, `ast` and `module-ir` of a build's `modules/` directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Tokens,
    Ast,
    ModuleIr,
}

impl Stage {
    /// The JS stage id.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Stage::Tokens => "tokens",
            Stage::Ast => "ast",
            Stage::ModuleIr => "module-ir",
        }
    }
}

/// The `dump(stage, value, key)` callback: `key` is the canonical (real) path of the module.
pub type DumpFn<'a> = dyn FnMut(Stage, &str, Value) + 'a;

/// The options a link hands to the front end (`link()`'s `options`, as `loadGraph` reads them).
#[derive(Debug, Clone)]
pub struct LinkOptions {
    /// `machine`, `tags`, `locale`, `pathForm`, `checkout`, `importAliases` and `i18n`.
    pub spec: SpecifierOptions,
    /// The project's logical frame rate (JS leaves it unset, and the fold uses 60).
    pub frame_rate: f64,
    /// The machine's hardware fact sheet.
    pub facts: Option<IndexMap<String, Value>>,
    /// `defines`, by name.
    pub defines: Option<IndexMap<String, Value>>,
    /// `bx?.strict !== false`.
    pub bx_strict: bool,
}

impl Default for LinkOptions {
    /// The JS defaults: no frame rate (the fold's 60) and `bx?.strict !== false`.
    fn default() -> Self {
        LinkOptions {
            spec: SpecifierOptions::default(),
            frame_rate: 60.0,
            facts: None,
            defines: None,
            bx_strict: true,
        }
    }
}

impl LinkOptions {
    /// The options of a recorded `resolveSpecifier` call (its third argument carries the whole
    /// link: `frameRate`, `facts`, `defines`, `locale` and the resolver options).
    ///
    /// # Errors
    /// The resolver options do not decode.
    pub fn from_json(v: &Value, bx_strict: bool) -> Result<LinkOptions, String> {
        let object = |key: &str| {
            v.get(key).and_then(Value::as_object).map(|o| {
                o.iter()
                    .map(|(k, x)| (k.clone(), x.clone()))
                    .collect::<IndexMap<String, Value>>()
            })
        };
        Ok(LinkOptions {
            spec: SpecifierOptions::from_json(v)?,
            frame_rate: v.get("frameRate").and_then(Value::as_f64).unwrap_or(60.0),
            facts: object("facts"),
            defines: object("defines"),
            bx_strict,
        })
    }
}

/// One module of a graph (JS `{ file, text, tokens, ast, bound, media?, ir? }`). The binder's
/// result is kept beside the modules, in a `Vec<Bound>` with the same indices.
#[derive(Debug, Clone)]
pub struct Module {
    pub file: String,
    pub text: String,
    pub source_kind: SourceKind,
    /// What the import scan reads: a source file's tokens, or a media file's converted ones.
    pub tokens: Vec<ScanToken>,
    /// The syntax tree; `None` for a media module.
    pub ast: Option<Node>,
    /// The tree as it was before `elaborate_bx`, once this module is finished (R1.10).
    pub pre_elaboration: Option<Node>,
    pub media: Option<MediaModule>,
    pub ir: Option<ModuleIr>,
    /// The entry, and whatever it reaches by a relative path or a project alias.
    pub own: bool,
}

/// The canonical identity of a file: two pnpm symlink routes, one module.
#[must_use]
pub fn canonical(path: &str) -> String {
    match std::fs::canonicalize(Path::new(path)) {
        Ok(real) => real.to_string_lossy().into_owned(),
        Err(_) => path.to_string(),
    }
}

/// The `kind` a media token converts to.
fn scan_kind(kind: MediaTokenKind) -> TokenKind {
    match kind {
        MediaTokenKind::Comment => TokenKind::Comment,
        MediaTokenKind::String => TokenKind::String,
        MediaTokenKind::Number => TokenKind::Number,
        MediaTokenKind::Identifier => TokenKind::Identifier,
        MediaTokenKind::Punctuation => TokenKind::Punctuation,
    }
}

/// The tokens of a media file as the import scan reads them (the JS hands the same objects to
/// `findImports`, which looks only at `kind`, `start`, `length` and `text`).
#[must_use]
pub fn media_tokens_to_scan(tokens: &[MediaToken]) -> Vec<ScanToken> {
    tokens
        .iter()
        .map(|t| ScanToken {
            kind: scan_kind(t.kind),
            start: t.start,
            length: t.length,
            text: t.text.clone(),
        })
        .collect()
}

/// The binder's result of a module that has no symbols (a media module's `bound`).
#[must_use]
pub fn empty_bound(file: &str) -> Bound {
    Bound {
        scopes: Vec::new(),
        symbol_table: Vec::new(),
        module_scope: ScopeId(0),
        symbols: IndexMap::new(),
        imports: Vec::new(),
        scope_of: IndexMap::new(),
        file: file.to_string(),
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// `parseModule(file, text, diagnostics, dump)`: tokens, syntax tree and the module's own
/// symbols.
pub fn parse_module(
    file: &str,
    text: &str,
    diagnostics: &mut Vec<Diagnostic>,
    mut dump: Option<&mut DumpFn<'_>>,
) -> (Module, Bound) {
    let source_kind = source_kind_of(file).unwrap_or(SourceKind::Bs);
    if matches!(source_kind, SourceKind::Bg | SourceKind::Ba) {
        let media = media::parse_media_module(file, text, diagnostics, source_kind.as_str());
        let module = Module {
            file: file.to_string(),
            text: text.to_string(),
            source_kind,
            tokens: media_tokens_to_scan(&media.tokens),
            ast: None,
            pre_elaboration: None,
            media: Some(media),
            ir: None,
            own: false,
        };
        return (module, empty_bound(file));
    }
    let lexed = tokenize(
        text,
        file,
        &lexer::Options {
            source_kind: Some(source_kind),
        },
    );
    if let Some(dump) = dump.as_mut() {
        dump(Stage::Tokens, &canonical(file), to_value(&lexed.tokens));
    }
    let mut parsed = parse(
        &lexed.tokens,
        text,
        file,
        &parser::Options {
            source_kind: Some(source_kind),
        },
    );
    strip_tests(&mut parsed.ast);
    // Before bind: bind, fold and the linker mutate nodes in place.
    if let Some(dump) = dump.as_mut() {
        dump(Stage::Ast, &canonical(file), to_value(&parsed.ast));
    }
    diagnostics.extend(lexed.diagnostics);
    diagnostics.extend(parsed.diagnostics);
    let bound = bind(&parsed.ast, file, diagnostics);
    let module = Module {
        file: file.to_string(),
        text: text.to_string(),
        source_kind,
        tokens: lexed.tokens.iter().map(ScanToken::from).collect(),
        ast: Some(parsed.ast),
        pre_elaboration: None,
        media: None,
        ir: None,
        own: false,
    };
    (module, bound)
}

/// What `finishModule` reads of the link's options, plus the one counter it updates.
#[derive(Debug, Clone, Default)]
pub struct FinishOptions {
    pub link: LinkOptions,
    /// One counter for the whole link, so sprites in different `.8bg` files get different slots.
    pub media_slots: MediaSlots,
}

fn fold_facts(
    facts: Option<&IndexMap<String, Value>>,
) -> Result<Option<IndexMap<String, Json>>, String> {
    let Some(facts) = facts else {
        return Ok(None);
    };
    let mut out = IndexMap::new();
    for (key, value) in facts {
        out.insert(key.clone(), Json::parse(&value.to_string())?);
    }
    Ok(Some(out))
}

/// `resolveSpecifier(specifier, file, withPathForm(options, pathForm))`.
///
/// # Errors
/// A throw of the JS resolver.
pub fn resolve_form(
    options: &mut SpecifierOptions,
    specifier: &str,
    file: &str,
    path_form: bool,
) -> Result<Option<Resolution>, String> {
    if path_form {
        // `{ ...options, pathForm: true }` is a copy that shares the catalog options object.
        let had_catalog_options = options.i18n.is_some();
        let mut copy = SpecifierOptions {
            base: with_path_form(&options.base, true),
            checkout: options.checkout.clone(),
            import_aliases: options.import_aliases.clone(),
            i18n: options.i18n.clone(),
        };
        let resolved =
            resolve_specifier(specifier, file, &mut copy, &mut indexmap::IndexSet::new());
        if had_catalog_options {
            options.i18n = copy.i18n;
        }
        resolved
    } else {
        resolve_specifier(specifier, file, options, &mut indexmap::IndexSet::new())
    }
}

fn dedupe_key(d: &Diagnostic) -> String {
    format!("{}@{}+{}", d.code, d.start, d.length)
}

/// Appends the lowering diagnostics the earlier ones did not report. The JS builds `seen` once
/// and only filters (R5.2), so two lowering diagnostics that share a key are both kept.
fn merge_lowering(diagnostics: &mut Vec<Diagnostic>, lowered: Vec<Diagnostic>) {
    let seen: HashSet<String> = diagnostics.iter().map(dedupe_key).collect();
    for d in lowered {
        if !seen.contains(&dedupe_key(&d)) {
            diagnostics.push(d);
        }
    }
}

/// Folds, checks and lowers one source module: the shared tail of `finishModule` and `analyze`
/// from `checkBx` on. Returns the lowering diagnostics that the earlier ones did not report.
#[allow(clippy::too_many_arguments)]
fn front_tail(
    ast: &mut Node,
    pre_trees: &[Option<&Node>],
    bounds: &[Bound],
    index: usize,
    file: &str,
    text: &str,
    link: &LinkOptions,
    source_kind: SourceKind,
    diagnostics: &mut Vec<Diagnostic>,
    snapshot: &mut Option<Node>,
) -> Result<ModuleIr, String> {
    let id = ModuleId(u32::try_from(index).map_err(|e| e.to_string())?);
    diagnostics.extend(check_bx(
        ast,
        file,
        &bounds[index],
        bounds,
        &BxCheckOptions {
            source_kind,
            strict: link.bx_strict,
        },
        &[],
    ));
    *snapshot = Some(ast.clone());
    elaborate_bx(ast, bounds, id, pre_trees, file)
        .map_err(|_| format!("{file}: a symbol names a node of a tree that is not loaded"))?;
    let catalog = is_catalog_file(
        file,
        Some(CatalogDir {
            catalog_dir: link
                .spec
                .i18n
                .as_ref()
                .and_then(|i| i.catalog_dir.as_deref()),
        }),
    );
    if catalog {
        let charset = link
            .spec
            .i18n
            .as_ref()
            .and_then(|i: &I18nOptions| i.charset.as_deref())
            .unwrap_or("transliterate");
        diagnostics.extend(apply_catalog_charset(ast, file, charset));
    }
    // Folding runs before check(): a #frames(...) call needs to already be a plain
    // IntegerLiteral by the time the width-fit rule walks the tree.
    let fold_options = FoldOptions {
        frame_rate: link.frame_rate,
        machine: link.spec.base.machine.clone(),
        facts: fold_facts(link.facts.as_ref())?,
        locale: link.spec.base.locale.clone(),
        defines: fold_facts(link.defines.as_ref())?,
    };
    diagnostics.extend(fold::fold_compile_time(
        Some(ast),
        file,
        &fold_options,
        None,
    )?);
    diagnostics.extend(check(
        Some(ast),
        file,
        Some(text),
        CheckOptions {
            skip_screen_text: catalog,
        },
    ));
    let lowered = lower::function::lower(ast, file, Some(text));
    // The template layout runs in both check() and lower(); one problem is reported once.
    // `seen` is built once: duplicates among the lowering diagnostics themselves are kept.
    merge_lowering(diagnostics, lowered.diagnostics);
    Ok(lowered.ir)
}

/// `finishModule(module, diagnostics, options)` for `modules[index]`: element checks, 8BX
/// elaboration, folding, checking and lowering to the module's IR. `bounds[i]` is the binder's
/// result of `modules[i]`, with every import already bound.
///
/// # Errors
/// A throw of the JS: the fold or a media elaboration failing, or a symbol naming a node of a
/// tree that is not loaded.
pub fn finish_module(
    modules: &mut [Module],
    bounds: &[Bound],
    index: usize,
    diagnostics: &mut Vec<Diagnostic>,
    options: &mut FinishOptions,
    mut dump: Option<&mut DumpFn<'_>>,
) -> Result<(), String> {
    if modules[index].media.is_some() {
        let link = &options.link;
        let mut elaborate = ElaborateOptions {
            machine: link.spec.base.machine.clone(),
            tags: link.spec.base.tags.clone(),
            facts: link.facts.clone().unwrap_or_default(),
            checkout: link.spec.checkout.clone(),
            media_slots: Some(options.media_slots),
        };
        let media = modules[index].media.clone();
        let Some(media) = media else {
            return Ok(());
        };
        let ir = elaborate_media(&media, diagnostics, &mut elaborate)?;
        if let Some(slots) = elaborate.media_slots {
            options.media_slots = slots;
        }
        modules[index].ir = Some(ir);
        return Ok(());
    }
    let file = modules[index].file.clone();
    let text = modules[index].text.clone();
    let Some(mut ast) = modules[index].ast.take() else {
        return Ok(());
    };
    let mut snapshot = None;
    let result = {
        let pre: Vec<Option<&Node>> = modules
            .iter()
            .enumerate()
            .map(|(i, m)| {
                if i == index {
                    None
                } else {
                    m.pre_elaboration.as_ref().or(m.ast.as_ref())
                }
            })
            .collect();
        front_tail(
            &mut ast,
            &pre,
            bounds,
            index,
            &file,
            &text,
            &options.link,
            source_kind_of(&file).unwrap_or(SourceKind::Bs),
            diagnostics,
            &mut snapshot,
        )
    };
    modules[index].ast = Some(ast);
    modules[index].pre_elaboration = snapshot;
    let ir = result?;
    if let Some(dump) = dump.as_mut() {
        dump(Stage::ModuleIr, &canonical(&file), to_value(&ir));
    }
    modules[index].ir = Some(ir);
    Ok(())
}

/// `analyze`'s tail, from `checkBx` on, over a tree whose binder results are `bounds[0]` (this
/// file) and the definers' after it. `trees[i]` is the definer tree of `bounds[i]`.
///
/// # Errors
/// As [`finish_module`].
#[allow(clippy::too_many_arguments)]
pub fn analyze_tail(
    ast: &mut Node,
    trees: &[Option<&Node>],
    bounds: &[Bound],
    file: &str,
    text: &str,
    link: &LinkOptions,
    source_kind: SourceKind,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(), String> {
    let mut snapshot = None;
    front_tail(
        ast,
        trees,
        bounds,
        0,
        file,
        text,
        link,
        source_kind,
        diagnostics,
        &mut snapshot,
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(code: &str, start: u32, message: &str) -> Diagnostic {
        Diagnostic {
            code: code.to_string(),
            message: message.to_string(),
            file: "a.8bs".to_string(),
            start,
            length: 1,
            severity: diagnostics::Severity::Error,
        }
    }

    #[test]
    fn lowering_diagnostics_sharing_a_key_are_both_kept() {
        let mut all = vec![found("8BS1001", 0, "earlier")];
        let lowered = vec![
            found("8BS2002", 5, "first"),
            found("8BS2002", 5, "second"),
            found("8BS1001", 0, "reported already"),
        ];
        merge_lowering(&mut all, lowered);
        let messages: Vec<&str> = all.iter().map(|d| d.message.as_str()).collect();
        assert_eq!(messages, ["earlier", "first", "second"]);
    }

    #[test]
    fn default_link_options_are_the_js_defaults() {
        let link = LinkOptions::default();
        assert_eq!(link.frame_rate, 60.0);
        assert!(link.bx_strict);
    }

    #[test]
    fn parse_module_leaves_test_declarations_out_of_the_tree() {
        let mut diagnostics = Vec::new();
        let text =
            "fn main() {}\n#[test]\nfn t() {}\n#[cfg(test)]\nmod tests { #[test] fn x() {} }\n";
        let (module, _) = parse_module("a.8bs", text, &mut diagnostics, None);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let ast = module.ast.expect("a parsed tree");
        let tree = serde_json::to_string(&ast).expect("serialize");
        assert!(!tree.contains("TestDecl"));
        assert!(!tree.contains("\"tests\""));
        assert!(tree.contains("\"main\""));
    }
}
