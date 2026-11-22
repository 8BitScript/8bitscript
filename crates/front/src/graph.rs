//! Port of `loadGraph` (packages/compiler/src/linker/index.mjs:130-243): read the entry and
//! everything it imports, bind the imports, finish every module and load what the IR's imports
//! name that the token scan missed.
//!
//! Left to the linker unit: `nativeSourcesBeside` and the `nativeSources` map (they only collect
//! file names for the target toolchain) and `imp.module` (a link between finished modules).

use std::collections::{HashMap, HashSet};

use diagnostics::codes::{NOT_COMPILABLE, UNRESOLVED_RELATIVE_IMPORT};
use diagnostics::{Diagnostic, Severity, diagnostic};
use i18n::CatalogResolution;
use resolver::imports::find_imports;
use resolver::specifier::Resolution;
use sema::binder::bind_imports;
use sema::binder::types::{Bound, ModuleId};

use crate::module::{
    DumpFn, FinishOptions, LinkOptions, Module, canonical, finish_module, parse_module,
    resolve_form,
};

/// `resolved.path` of a resolution that is not an error: `Some(None)` is a target-specific
/// answer (`path === null`).
fn path_of(resolution: &Resolution) -> Option<Option<&str>> {
    match resolution {
        Resolution::Resolved(r) => Some(r.path.as_deref()),
        Resolution::Catalog(CatalogResolution::Found { path, .. }) => Some(Some(path)),
        _ => None,
    }
}

/// `resolved.text`: the catalog's merged text, which has no file behind it.
fn text_of(resolution: &Resolution) -> Option<&str> {
    match resolution {
        Resolution::Catalog(CatalogResolution::Found { text, .. }) => Some(text),
        _ => None,
    }
}

/// `readFileSync(path, 'utf8')`: undecodable bytes become U+FFFD.
fn read(path: &str) -> Option<String> {
    std::fs::read(path)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

struct Graph {
    modules: Vec<Module>,
    bounds: Vec<Bound>,
    by_path: HashMap<String, usize>,
}

impl Graph {
    fn enqueue(
        &mut self,
        file: &str,
        text: &str,
        own: bool,
        diagnostics: &mut Vec<Diagnostic>,
        dump: Option<&mut DumpFn<'_>>,
    ) -> usize {
        let (mut module, bound) = parse_module(file, text, diagnostics, dump);
        module.own = own;
        self.modules.push(module);
        self.bounds.push(bound);
        let index = self.modules.len() - 1;
        self.by_path.insert(canonical(file), index);
        index
    }
}

fn own_route(specifier: &str, aliases: &[String]) -> bool {
    specifier.starts_with('.')
        || specifier.starts_with('/')
        || aliases.iter().any(|p| {
            specifier == p
                || specifier
                    .strip_prefix(p.as_str())
                    .is_some_and(|r| r.starts_with('/'))
        })
}

/// `loadGraph(entryText, entryFile, diagnostics, options)`; `modules[i]` pairs with `bounds[i]`.
///
/// # Errors
/// A throw of the JS: a resolver, fold or media-elaboration failure.
pub fn load_graph(
    entry_text: &str,
    entry_file: &str,
    diagnostics: &mut Vec<Diagnostic>,
    link: &LinkOptions,
    mut dump: Option<&mut DumpFn<'_>>,
) -> Result<(Vec<Module>, Vec<Bound>), String> {
    let mut options = FinishOptions {
        link: link.clone(),
        ..FinishOptions::default()
    };
    let aliases: Vec<String> = options
        .link
        .spec
        .import_aliases
        .as_ref()
        .map(|a| a.keys().cloned().collect())
        .unwrap_or_default();
    let mut g = Graph {
        modules: Vec::new(),
        bounds: Vec::new(),
        by_path: HashMap::new(),
    };
    g.enqueue(
        entry_file,
        entry_text,
        true,
        diagnostics,
        dump.as_deref_mut(),
    );

    // Pass one: read the graph.
    let mut i = 0;
    while i < g.modules.len() {
        let file = g.modules[i].file.clone();
        let own = g.modules[i].own;
        for import in find_imports(&g.modules[i].tokens) {
            let resolved = resolve_form(
                &mut options.link.spec,
                &import.specifier,
                &file,
                import.path_form,
            )?;
            let Some(resolved) = resolved else { continue };
            if let Some(found) = resolved.diagnostics() {
                for d in found {
                    if !diagnostics.contains(d) {
                        diagnostics.push(d.clone());
                    }
                }
            }
            let Some(Some(path)) = path_of(&resolved) else {
                continue;
            };
            if g.by_path.contains_key(&canonical(path)) {
                continue;
            }
            let text = match text_of(&resolved) {
                Some(t) => t.to_string(),
                None => match read(path) {
                    Some(t) => t,
                    None => continue,
                },
            };
            let path = path.to_string();
            g.enqueue(
                &path,
                &text,
                own && own_route(&import.specifier, &aliases),
                diagnostics,
                dump.as_deref_mut(),
            );
        }
        i += 1;
    }

    // Every import that names an exported component now points at it.
    let mut failure: Option<String> = None;
    for m in 0..g.modules.len() {
        let file = g.modules[m].file.clone();
        let by_path = &g.by_path;
        let spec = &mut options.link.spec;
        // `pathFormSpecifiers`: a specifier written in path form anywhere in the module.
        let path_forms: HashSet<String> = find_imports(&g.modules[m].tokens)
            .into_iter()
            .filter(|i| i.path_form)
            .map(|i| i.specifier)
            .collect();
        let mut lookup = |specifier: &str| -> Option<ModuleId> {
            let resolved =
                match resolve_form(spec, specifier, &file, path_forms.contains(specifier)) {
                    Ok(r) => r,
                    Err(e) => {
                        failure.get_or_insert(e);
                        return None;
                    }
                };
            let path = path_of(resolved.as_ref()?)??;
            by_path.get(&canonical(path)).map(|&x| ModuleId(x as u32))
        };
        bind_imports(&mut g.bounds, ModuleId(m as u32), &mut lookup);
    }
    if let Some(e) = failure {
        return Err(e);
    }

    // Pass two: finish every module, then link its IR imports.
    for m in 0..g.modules.len() {
        finish_module(
            &mut g.modules,
            &g.bounds,
            m,
            diagnostics,
            &mut options,
            dump.as_deref_mut(),
        )?;
    }

    let mut m = 0;
    while m < g.modules.len() {
        let file = g.modules[m].file.clone();
        let own = g.modules[m].own;
        let imports = g.modules[m]
            .ir
            .as_ref()
            .map(|ir| ir.imports.clone())
            .unwrap_or_default();
        for imp in imports {
            let (start, length) = (imp.start as u32, imp.length as u32);
            let resolved = resolve_form(
                &mut options.link.spec,
                &imp.source,
                &file,
                imp.path_form == Some(true),
            )?;
            let Some(resolved) = resolved else {
                diagnostics.push(diagnostic(
                    NOT_COMPILABLE,
                    format!("import specifier '{}' is not linkable yet: only './file.8bs', './file.8bx', './file.8bg' or './file.8ba' paths, project import aliases ('@lib/…' from 8bitscript.config.8bs), bare package names, and package subpaths ('@scope/name/thing') are specified", imp.source),
                    &file, start, length, Severity::Error,
                ));
                continue;
            };
            if let (Some(code), Some(message)) = (resolved.code(), resolved.message()) {
                diagnostics.push(diagnostic(
                    code,
                    message,
                    &file,
                    start,
                    length,
                    Severity::Error,
                ));
                continue;
            }
            if let Resolution::Resolved(r) = &resolved
                && let Some(w) = &r.warning
            {
                diagnostics.push(diagnostic(
                    w.code,
                    w.message.clone(),
                    &file,
                    start,
                    length,
                    Severity::Warning,
                ));
            }
            let Some(path) = path_of(&resolved) else {
                continue;
            };
            let Some(path) = path else {
                diagnostics.push(diagnostic(
                    NOT_COMPILABLE,
                    format!(
                        "'{}' is target-specific; linking it needs a machine target",
                        imp.source
                    ),
                    &file,
                    start,
                    length,
                    Severity::Error,
                ));
                continue;
            };
            if !g.by_path.contains_key(&canonical(path)) {
                let text = match text_of(&resolved) {
                    Some(t) => t.to_string(),
                    None => match read(path) {
                        Some(t) => t,
                        None => {
                            diagnostics.push(diagnostic(
                                UNRESOLVED_RELATIVE_IMPORT,
                                format!("cannot read module '{}'", imp.source),
                                &file,
                                start,
                                length,
                                Severity::Error,
                            ));
                            continue;
                        }
                    },
                };
                let path = path.to_string();
                let index = g.enqueue(
                    &path,
                    &text,
                    own && own_route(&imp.source, &aliases),
                    diagnostics,
                    dump.as_deref_mut(),
                );
                finish_module(
                    &mut g.modules,
                    &g.bounds,
                    index,
                    diagnostics,
                    &mut options,
                    dump.as_deref_mut(),
                )?;
            }
        }
        m += 1;
    }
    Ok((g.modules, g.bounds))
}
