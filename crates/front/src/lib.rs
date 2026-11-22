//! Front-end API (port spec P3-18): the module driver and the `analyze` order.

pub mod graph;
pub mod module;

use diagnostics::{Diagnostic, source_kind_of};
use lexer::tokenize;
use module::{LinkOptions, analyze_tail, resolve_form};
use parser::parse;
use resolver::imports::ScanToken;
use resolver::specifier::resolve_imports;
use sema::binder::types::ModuleId;
use sema::binder::{bind, bind_imports};
use syntax::{Node, SourceKind};

/// `analyze`'s options (`resolveImports`, `sourceKind`, and the link options it shares with
/// `link()`). `defineSites` is not carried: the editor's collection of read `#define` names has
/// no caller in the Rust front end yet.
#[derive(Debug, Clone, Default)]
pub struct AnalyzeOptions {
    pub resolve_imports: bool,
    pub source_kind: Option<SourceKind>,
    pub link: LinkOptions,
}

/// `analyze(text, file, options)`: every diagnostic of one file, in source order (packages/
/// compiler/index.mjs:95-150).
///
/// A definer's tree is read before its own elaboration, which is what JS sees: `analyze` never
/// elaborates, folds or checks a definer.
///
/// # Errors
/// A throw of the JS: the resolver or the fold failing.
pub fn analyze(
    text: &str,
    file: &str,
    options: &mut AnalyzeOptions,
) -> Result<Vec<Diagnostic>, String> {
    let kind = options
        .source_kind
        .or_else(|| source_kind_of(file))
        .unwrap_or(SourceKind::Bs);
    if matches!(kind, SourceKind::Bg | SourceKind::Ba) {
        let mut found = media::analyze_media(text, file, kind.as_str()).diagnostics;
        found.sort_by_key(|d| d.start);
        return Ok(found);
    }
    let lexed = tokenize(
        text,
        file,
        &lexer::Options {
            source_kind: Some(kind),
        },
    );
    let parsed = parse(
        &lexed.tokens,
        text,
        file,
        &parser::Options {
            source_kind: Some(kind),
        },
    );
    let mut ast = parsed.ast;
    let mut all: Vec<Diagnostic> = lexed.diagnostics.clone();
    all.extend(parsed.diagnostics);
    // bind's own diagnostics, then everything checkBx adds, come before the catalog's.
    let mut bounds = vec![bind(&ast, file, &mut all)];
    let mut trees: Vec<Option<Node>> = vec![None];
    if options.resolve_imports {
        // First pass: which specifiers does the binder ask about?
        let mut asked: Vec<String> = Vec::new();
        let mut dry = bounds.clone();
        bind_imports(&mut dry, ModuleId(0), &mut |s: &str| {
            if !asked.iter().any(|a| a == s) {
                asked.push(s.to_string());
            }
            None
        });
        let mut ids: Vec<(String, ModuleId)> = Vec::new();
        // `pathFormSpecifiers`: a specifier written in path form anywhere in the module.
        let scan: Vec<ScanToken> = lexed.tokens.iter().map(ScanToken::from).collect();
        let path_forms: Vec<String> = resolver::imports::find_imports(&scan)
            .into_iter()
            .filter(|i| i.path_form)
            .map(|i| i.specifier)
            .collect();
        for specifier in asked {
            let form = path_forms.contains(&specifier);
            let resolved = resolve_form(&mut options.link.spec, &specifier, file, form)?;
            // `resolved.path` of any answer without a `code`: a catalog's `Found` is read from
            // disk too, as the JS does.
            let Some(Some(path)) = resolved
                .as_ref()
                .and_then(graph::path_of)
                .map(|p| p.map(str::to_string))
            else {
                continue;
            };
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let other = String::from_utf8_lossy(&bytes).into_owned();
            let other_kind = source_kind_of(&path).unwrap_or(SourceKind::Bs);
            let tokens = tokenize(
                &other,
                &path,
                &lexer::Options {
                    source_kind: Some(other_kind),
                },
            )
            .tokens;
            let tree = parse(
                &tokens,
                &other,
                &path,
                &parser::Options {
                    source_kind: Some(other_kind),
                },
            )
            .ast;
            let bound = bind(&tree, &path, &mut Vec::new());
            ids.push((
                specifier,
                ModuleId(u32::try_from(bounds.len()).map_err(|e| e.to_string())?),
            ));
            bounds.push(bound);
            trees.push(Some(tree));
        }
        bind_imports(&mut bounds, ModuleId(0), &mut |s: &str| {
            ids.iter().find(|(k, _)| k == s).map(|(_, id)| *id)
        });
    }
    let tree_refs: Vec<Option<&Node>> = trees.iter().map(Option::as_ref).collect();
    analyze_tail(
        &mut ast,
        &tree_refs,
        &bounds,
        file,
        text,
        &options.link,
        kind,
        &mut all,
    )?;
    if options.resolve_imports {
        let scan: Vec<ScanToken> = lexed.tokens.iter().map(ScanToken::from).collect();
        all.extend(resolve_imports(&scan, file, &mut options.link.spec)?);
    }
    all.sort_by_key(|d| d.start);
    Ok(all)
}
