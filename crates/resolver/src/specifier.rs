//! Port of packages/compiler/src/resolver/index.mjs:702-831
//!
//! `resolveSpecifier` (one import specifier to the module it names) and `resolveImports` (every
//! import of a file, reported as diagnostics on the specifier's span).

use diagnostics::{Diagnostic, Severity, codes, diagnostic, is_source_file};
use i18n::{CatalogResolution, I18nOptions, RealFs, ResolveOptions, resolve_catalog_specifier};
use indexmap::{IndexMap, IndexSet};
use jsnum::is_js_whitespace;
use serde_json::{Map, Value, json};

use crate::aliases::{aliased_subpath, is_path_form, longest_alias_prefix};
use crate::imports::{Import, ScanToken, find_imports, with_path_form};
use crate::package::{
    Json, NativeSources, bitscript_of, find_package_dir, native_sources_beside, native_sources_of,
    read_manifest, resolve_conditional_entry, resolve_subpath,
};
use crate::posix::{dirname, resolve};
use crate::variants::{Chosen, Options, Warning, choose_module, choose_variant, tags_of};

/// `{ path, warning?, native? }`: a module the specifier names (`path` null is "valid, and
/// target-dependent").
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub path: Option<String>,
    pub warning: Option<Warning>,
    pub native: Option<Vec<String>>,
}

/// What `resolveSpecifier` returns, apart from `null`.
#[derive(Debug, Clone, PartialEq)]
pub enum Resolution {
    Resolved(Resolved),
    /// `{ code, message, native? }`
    Failed {
        code: String,
        message: String,
        native: Option<Vec<String>>,
    },
    /// The message catalog's answer.
    Catalog(CatalogResolution),
}

impl Resolution {
    /// `{ code, message }`
    #[must_use]
    pub fn failed(code: &str, message: String) -> Resolution {
        Resolution::Failed {
            code: code.to_string(),
            message,
            native: None,
        }
    }

    /// `{ ...chosen, native }` (`native` left out when `None`).
    #[must_use]
    pub fn from_chosen(chosen: Chosen, native: Option<Vec<String>>) -> Resolution {
        match chosen {
            Chosen::Path(path) => Resolution::Resolved(Resolved {
                path: Some(path),
                warning: None,
                native,
            }),
            Chosen::TargetDependent => Resolution::Resolved(Resolved {
                path: None,
                warning: None,
                native,
            }),
            Chosen::Warned { path, warning } => Resolution::Resolved(Resolved {
                path: Some(path),
                warning: Some(warning),
                native,
            }),
            Chosen::Failed { code, message } => Resolution::Failed {
                code: code.to_string(),
                message,
                native,
            },
        }
    }

    /// `resolved.code`.
    #[must_use]
    pub fn code(&self) -> Option<&str> {
        match self {
            Resolution::Failed { code, .. } => Some(code),
            Resolution::Catalog(CatalogResolution::Failed { code, .. }) => Some(code),
            _ => None,
        }
    }

    /// `resolved.message`.
    #[must_use]
    pub fn message(&self) -> Option<&str> {
        match self {
            Resolution::Failed { message, .. } => Some(message),
            Resolution::Catalog(CatalogResolution::Failed { message, .. }) => Some(message),
            _ => None,
        }
    }

    /// `resolved.diagnostics`.
    #[must_use]
    pub fn diagnostics(&self) -> Option<&[Diagnostic]> {
        match self {
            Resolution::Catalog(CatalogResolution::Found { diagnostics, .. }) => Some(diagnostics),
            Resolution::Catalog(CatalogResolution::Failed { diagnostics, .. }) => {
                diagnostics.as_deref()
            }
            _ => None,
        }
    }

    /// The JS record.
    #[must_use]
    pub fn to_json(&self) -> Value {
        match self {
            Resolution::Resolved(r) => {
                let mut map = Map::new();
                map.insert("path".into(), json!(r.path));
                if let Some(w) = &r.warning {
                    map.insert(
                        "warning".into(),
                        json!({ "code": w.code, "message": w.message }),
                    );
                }
                if let Some(native) = &r.native {
                    map.insert("native".into(), json!(native));
                }
                Value::Object(map)
            }
            Resolution::Failed {
                code,
                message,
                native,
            } => {
                let mut map = Map::new();
                map.insert("code".into(), json!(code));
                map.insert("message".into(), json!(message));
                if let Some(native) = native {
                    map.insert("native".into(), json!(native));
                }
                Value::Object(map)
            }
            Resolution::Catalog(c) => serde_json::to_value(c).unwrap_or(Value::Null),
        }
    }
}

/// The resolver options `resolveSpecifier` reads.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpecifierOptions {
    /// `machine`, `tags`, `profile`, `locale`, `pathForm`.
    pub base: Options,
    /// A local checkout whose `packages/` win over node_modules (JS truthiness: non-empty).
    pub checkout: Option<String>,
    /// `@prefix` to absolute directory, from the project's `imports`.
    pub import_aliases: Option<IndexMap<String, String>>,
    /// The message catalog options; `resolveCatalogSpecifier` leaves its cache on them.
    pub i18n: Option<I18nOptions>,
}

impl SpecifierOptions {
    /// The options object of a recorded call.
    ///
    /// # Errors
    /// The `i18n` member does not have the shape of the catalog options.
    pub fn from_json(v: &Value) -> Result<SpecifierOptions, String> {
        let text = |key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
        let import_aliases = v.get("importAliases").and_then(Value::as_object).map(|o| {
            o.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<IndexMap<_, _>>()
        });
        let i18n = match v.get("i18n") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                serde_json::from_value::<I18nOptions>(value.clone())
                    .map_err(|e| format!("i18n options: {e}"))?,
            ),
        };
        Ok(SpecifierOptions {
            base: Options {
                machine: text("machine"),
                tags: v.get("tags").and_then(Value::as_array).map(|t| {
                    t.iter()
                        .filter_map(|s| s.as_str().map(str::to_string))
                        .collect()
                }),
                profile: text("profile"),
                locale: text("locale"),
                path_form: v.get("pathForm").and_then(Value::as_bool).unwrap_or(false),
            },
            checkout: text("checkout"),
            import_aliases,
            i18n,
        })
    }
}

/// The text of a Node file-system error, as `error.message` begins.
#[must_use]
pub fn node_error_text(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT: no such file or directory".to_string(),
        std::io::ErrorKind::PermissionDenied => "EACCES: permission denied".to_string(),
        _ => error.to_string(),
    }
}

/// `/^(?:@[^/\s]+\/[^/\s]+|[^@./\s][^/\s]*)$/`: a bare specifier naming exactly one package.
#[must_use]
pub fn is_bare_package(specifier: &str) -> bool {
    let segment = |s: &str| !s.is_empty() && !s.contains('/') && !s.chars().any(is_js_whitespace);
    if let Some(rest) = specifier.strip_prefix('@') {
        return match rest.split_once('/') {
            Some((scope, name)) => segment(scope) && segment(name),
            None => false,
        };
    }
    let Some(first) = specifier.chars().next() else {
        return false;
    };
    !matches!(first, '@' | '.' | '/') && !is_js_whitespace(first) && segment(specifier)
}

/// `/^((?:@[^/\s]+\/)?[^@./\s][^/\s]*)\/([^\s]+)$/`: a package name and a subpath, as `(name, subpath)`.
#[must_use]
pub fn package_subpath(specifier: &str) -> Option<(&str, &str)> {
    let clean = |s: &str| !s.chars().any(is_js_whitespace);
    let name_start = if specifier.starts_with('@') {
        let slash = specifier.find('/')?;
        let scope = &specifier[1..slash];
        if scope.is_empty() || !clean(scope) {
            return None;
        }
        slash + 1
    } else {
        0
    };
    let first = specifier[name_start..].chars().next()?;
    if matches!(first, '@' | '.' | '/') || is_js_whitespace(first) {
        return None;
    }
    let slash = name_start + specifier[name_start..].find('/')?;
    let name = &specifier[..slash];
    let rest = &specifier[slash + 1..];
    if !clean(&specifier[name_start..slash]) || rest.is_empty() || !clean(rest) {
        return None;
    }
    Some((name, rest))
}

/// A module's resolution: the variant `chooseModule` picks, with the native sources of the
/// package the file sits in.
fn resolve_module(
    specifier: &str,
    target: &str,
    options: &SpecifierOptions,
) -> Result<Resolution, String> {
    let Some(chosen) = choose_module(specifier, target, &options.base) else {
        return Ok(Resolution::failed(
            codes::UNRESOLVED_RELATIVE_IMPORT,
            format!("cannot find module '{specifier}'"),
        ));
    };
    if let Chosen::Failed { code, .. } = &chosen
        && *code == codes::AMBIGUOUS_IMPORT
    {
        return Ok(Resolution::from_chosen(chosen, None));
    }
    // The file's own package's native sources come with it (see nativeSourcesBeside); a package
    // whose manifest names a missing one is reported here as it would be at the package's own
    // resolution.
    let beside = match &chosen {
        Chosen::Path(path) | Chosen::Warned { path, .. } => path.clone(),
        Chosen::TargetDependent | Chosen::Failed { .. } => target.to_string(),
    };
    Ok(match native_sources_beside(&beside) {
        NativeSources::Failed { code, message } => Resolution::failed(code, message),
        NativeSources::Sources(native) if native.is_empty() => {
            Resolution::from_chosen(chosen, None)
        }
        NativeSources::Sources(native) => Resolution::from_chosen(chosen, Some(native)),
    })
}

/// Resolve one import specifier to the absolute path of the module it names (`index.mjs:702`).
///
/// `None` is `null`: not resolved, and not an error. `seen` is the set of package directories a
/// chain of delegations has passed through.
///
/// # Errors
/// A throw of the JS (`realpathSync` of a package directory that vanished, a catalog that cannot
/// be read), as its message.
pub fn resolve_specifier(
    specifier: &str,
    from_file: &str,
    options: &mut SpecifierOptions,
    seen: &mut IndexSet<String>,
) -> Result<Option<Resolution>, String> {
    // The catalog options are shared state: `resolveCatalogSpecifier` leaves its cache on them.
    let mut catalog_options = ResolveOptions {
        locale: options.base.locale.clone(),
        i18n: options.i18n.take(),
    };
    let catalog = resolve_catalog_specifier(&RealFs, specifier, from_file, &mut catalog_options);
    options.i18n = catalog_options.i18n;
    if let Some(catalog) = catalog? {
        return Ok(Some(Resolution::Catalog(catalog)));
    }

    let from_dir = dirname(from_file);

    if specifier.starts_with('.') || specifier.starts_with('/') {
        if !is_source_file(specifier) && !(options.base.path_form && is_path_form(specifier)) {
            return Ok(None);
        }
        let target = resolve(from_dir, specifier);
        // `./hardware.8bs` on the NES is `./hardware.nes.8bs` when that file exists beside it.
        return resolve_module(specifier, &target, options).map(Some);
    }

    if let Some(import_aliases) = &options.import_aliases
        && let Some(prefix) = longest_alias_prefix(specifier, import_aliases)
    {
        let Some(rest) = aliased_subpath(specifier, prefix, options.base.path_form) else {
            return Ok(None);
        };
        let target = resolve(&import_aliases[prefix], &rest);
        return resolve_module(specifier, &target, options).map(Some);
    }

    let subpath = package_subpath(specifier);
    if subpath.is_none() && !is_bare_package(specifier) {
        return Ok(None);
    }
    let name = subpath.map_or(specifier, |(name, _)| name);

    let Some(package_dir) = find_package_dir(from_dir, name, options.checkout.as_deref()) else {
        return Ok(Some(Resolution::failed(
            codes::UNRESOLVED_PACKAGE,
            format!("cannot find package '{name}'. Is it installed?"),
        )));
    };

    let manifest = read_manifest(&i18n::path::join(&package_dir, "package.json"));

    if let Some((_, subpath)) = subpath {
        if !bitscript_of(manifest.as_ref()).is_some_and(Json::truthy) {
            return Ok(Some(Resolution::failed(
                codes::NOT_AN_8BS_PACKAGE,
                format!(
                    "'{name}' is not an 8BitScript package: its package.json has no \"8bitscript\" field"
                ),
            )));
        }
        return resolve_subpath(
            specifier,
            name,
            &package_dir,
            manifest.as_ref(),
            subpath,
            options,
        )
        .map(Some);
    }

    let entry = bitscript_of(manifest.as_ref()).and_then(|b| b.get("entry"));
    match entry {
        Some(Json::String(entry)) => {
            // A package's entry follows the same filename rule a relative import does:
            // `./src/index.8bs` with an `index.nes.8bs` beside it is the NES version of the
            // package, without the manifest having to say so.
            let target = resolve(&package_dir, entry);
            let tags = tags_of(&options.base);
            let chosen = choose_variant(
                specifier,
                &target,
                options.base.machine.as_deref(),
                &tags,
                options.base.locale.as_deref(),
            );
            let Some(chosen) = chosen else {
                return Ok(Some(Resolution::failed(
                    codes::MISSING_PACKAGE_ENTRY,
                    format!("'{specifier}' declares entry '{entry}', which does not exist"),
                )));
            };
            if let Chosen::Failed { .. } = chosen {
                return Ok(Some(Resolution::from_chosen(chosen, None)));
            }
            Ok(Some(
                match native_sources_of(specifier, &package_dir, manifest.as_ref()) {
                    NativeSources::Failed { code, message } => Resolution::failed(code, message),
                    NativeSources::Sources(native) => Resolution::from_chosen(chosen, Some(native)),
                },
            ))
        }
        Some(Json::Object(entry)) => {
            match native_sources_of(specifier, &package_dir, manifest.as_ref()) {
                NativeSources::Failed { code, message } => {
                    Ok(Some(Resolution::failed(code, message)))
                }
                NativeSources::Sources(native) => resolve_conditional_entry(
                    specifier,
                    &package_dir,
                    entry,
                    options,
                    seen,
                    &native,
                )
                .map(Some),
            }
        }
        _ => Ok(Some(Resolution::failed(
            codes::NOT_AN_8BS_PACKAGE,
            format!(
                "'{specifier}' is not an 8BitScript package: its package.json has no \"8bitscript\".entry field"
            ),
        ))),
    }
}

/// Check every import in a file and report the ones that do not resolve (`index.mjs:811`).
///
/// `file` is the absolute path of the importing file; anything else gives no diagnostics.
///
/// # Errors
/// As [`resolve_specifier`].
pub fn resolve_imports(
    tokens: &[ScanToken],
    file: &str,
    options: &mut SpecifierOptions,
) -> Result<Vec<Diagnostic>, String> {
    if file.is_empty() || !file.starts_with('/') {
        return Ok(Vec::new());
    }
    let mut diagnostics: Vec<Diagnostic> = Vec::new();

    for Import {
        specifier,
        path_form,
        start,
        length,
    } in find_imports(tokens)
    {
        let resolved = if path_form {
            // `{ ...options, pathForm: true }` is a copy that shares the catalog options object.
            let had_catalog_options = options.i18n.is_some();
            let mut copy = SpecifierOptions {
                base: with_path_form(&options.base, true),
                checkout: options.checkout.clone(),
                import_aliases: options.import_aliases.clone(),
                i18n: options.i18n.clone(),
            };
            let resolved = resolve_specifier(&specifier, file, &mut copy, &mut IndexSet::new());
            if had_catalog_options {
                options.i18n = copy.i18n;
            }
            resolved?
        } else {
            resolve_specifier(&specifier, file, options, &mut IndexSet::new())?
        };
        if let Some(resolved) = &resolved
            && let Some(extras) = resolved.diagnostics()
            && !extras.is_empty()
        {
            for extra in extras {
                if !diagnostics.iter().any(|d| {
                    d.code == extra.code
                        && d.file == extra.file
                        && d.start == extra.start
                        && d.message == extra.message
                }) {
                    diagnostics.push(extra.clone());
                }
            }
            if resolved.code().is_some() {
                continue;
            }
        }
        if let Some(resolved) = &resolved
            && let Some(code) = resolved.code()
        {
            diagnostics.push(diagnostic(
                code,
                resolved.message().unwrap_or_default(),
                file,
                start,
                length,
                Severity::Error,
            ));
        }
    }

    Ok(diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_package_matches_the_regex() {
        for ok in ["a", "pkg", "@s/n", "a-b", "é", "@a@/b"] {
            assert!(is_bare_package(ok), "{ok}");
        }
        for no in [
            "", "@", "@s", "@s/", "@/n", "@s/n/x", ".a", "/a", "a/b", "a b", " a", "@s/n m", "@@",
        ] {
            assert!(!is_bare_package(no), "{no}");
        }
    }

    #[test]
    fn package_subpath_matches_the_regex() {
        assert_eq!(package_subpath("a/b"), Some(("a", "b")));
        assert_eq!(package_subpath("a/b/c"), Some(("a", "b/c")));
        assert_eq!(package_subpath("@s/n/x/y"), Some(("@s/n", "x/y")));
        for no in [
            "", "a", "a/", "@s/n", "@s/", "@/n/x", "@s//x", ".a/b", "/a/b", "a b/c", "a/b c",
            "@s/@n/x", "@s/.n/x",
        ] {
            assert_eq!(package_subpath(no), None, "{no}");
        }
        assert_eq!(package_subpath("@@s/n/x"), Some(("@@s/n", "x")));
        // The scope segment may hold an '@'; the name may not start with one.
        assert_eq!(package_subpath("@a@/n/x"), Some(("@a@/n", "x")));
    }

    #[test]
    fn resolved_records_carry_only_what_is_set() {
        let r = Resolution::Resolved(Resolved {
            path: None,
            warning: None,
            native: None,
        });
        assert_eq!(r.to_json(), json!({ "path": null }));
        let f = Resolution::from_chosen(
            Chosen::Failed {
                code: "8BS2217",
                message: "m".into(),
            },
            Some(vec![]),
        );
        assert_eq!(
            f.to_json(),
            json!({ "code": "8BS2217", "message": "m", "native": [] })
        );
        assert_eq!(f.code(), Some("8BS2217"));
        assert!(f.diagnostics().is_none());
    }

    #[test]
    fn imports_need_an_absolute_file() {
        let mut options = SpecifierOptions::default();
        assert_eq!(
            resolve_imports(&[], "rel.8bs", &mut options),
            Ok(Vec::new())
        );
        assert_eq!(resolve_imports(&[], "", &mut options), Ok(Vec::new()));
    }
}
