//! Replays `fixtures/i18n.json` (made by `gen/i18n.mjs` in Node): the text helpers, the
//! catalog schema and charset checks, and `prepareCatalog` / `resolveCatalogSpecifier` over a
//! temp tree built from the fixture. Rows name paths `<root>/...`; the test maps `<root>` to
//! its own temp dir.
//!
//! One deliberate normalization: `catalogSchema` never sets `file` on the schema, so JS gives
//! the diagnostic for an empty namespace missing from the baseline no `file` at all; Rust
//! writes `""` there. A row whose expected result holds a diagnostic with no `file` is
//! compared with the empty `file`s removed from ours.

use std::fs;
use std::path::PathBuf;

use i18n::fs::{CatalogFs, RootedFs};
use i18n::{
    CatalogDir, I18nOptions, PrepareOptions, ResolveOptions, apply_catalog_charset, catalog_schema,
    compare_catalog_schemas, discover_catalog_locales, format_message, infer_catalog_dir,
    is_catalog_file, is_i18n_package_file, placeholders_of, prepare_catalog,
    resolve_catalog_specifier, transliterate,
};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{Value, json};
use syntax::{Node, NodeKind, SourceKind, children_mut};

struct Root(PathBuf);

impl Root {
    fn new() -> Root {
        let dir = std::env::temp_dir().join(format!("i18n-fixture-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Root(dir)
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn parse_text(text: &str, file: &str) -> Node {
    let source_kind = Some(SourceKind::Bs);
    let lexed = lexer::tokenize(text, file, &lexer::Options { source_kind });
    parser::parse(&lexed.tokens, text, file, &parser::Options { source_kind }).ast
}

fn string_values(node: &mut Node, out: &mut Vec<String>) {
    if let NodeKind::StringLiteral { value, .. } = &node.kind {
        out.push(value.clone());
        return;
    }
    for child in children_mut(node) {
        string_values(child, out);
    }
}

fn s(value: &Value) -> &str {
    value.as_str().unwrap()
}

fn arg_str(args: &[Value], i: usize) -> &str {
    s(&args[i])
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct PrepareArgs {
    i18n: Option<I18nOptions>,
    locale: Option<String>,
    from_file: Option<String>,
}

/// Whether `value` holds a diagnostic (an object with a `code`) that has no `file`.
fn lacks_file(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            (map.contains_key("code") && !map.contains_key("file")) || map.values().any(lacks_file)
        }
        Value::Array(items) => items.iter().any(lacks_file),
        _ => false,
    }
}

/// Removes an empty `file` from every diagnostic in `value`.
fn drop_empty_file(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if map.contains_key("code") && map.get("file").is_some_and(|f| f == "") {
                map.remove("file");
            }
            map.values_mut().for_each(drop_empty_file);
        }
        Value::Array(items) => items.iter_mut().for_each(drop_empty_file),
        _ => {}
    }
}

fn run(fs: &RootedFs, name: &str, args: &[Value]) -> (Value, Option<Value>) {
    match name {
        "placeholdersOf" => (to_value(&placeholders_of(args[0].as_str())), None),
        "formatMessage" => {
            let params: IndexMap<String, String> = args[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|pair| (s(&pair[0]).to_string(), s(&pair[1]).to_string()))
                .collect();
            let got = match format_message(arg_str(args, 0), &params) {
                Ok(text) => json!({"ok": true, "text": text}),
                Err(error) => json!({"ok": false, "error": error}),
            };
            (got, None)
        }
        "transliterate" => (to_value(&transliterate(arg_str(args, 0))), None),
        "catalogSchema" => {
            let ast = parse_text(arg_str(args, 0), arg_str(args, 1));
            (to_value(&catalog_schema(&ast, arg_str(args, 1))), None)
        }
        "compareCatalogSchemas" => {
            let locale = arg_str(args, 2);
            let base = catalog_schema(&parse_text(arg_str(args, 0), "en.8bs"), "en.8bs");
            let file = format!("{locale}.8bs");
            let other = catalog_schema(&parse_text(arg_str(args, 1), &file), &file);
            (
                to_value(&compare_catalog_schemas(&base, &other, locale, None)),
                None,
            )
        }
        "applyCatalogCharset" => {
            let mut ast = parse_text(arg_str(args, 0), arg_str(args, 1));
            let charset = args
                .get(2)
                .and_then(Value::as_str)
                .unwrap_or("transliterate");
            let diagnostics = apply_catalog_charset(&mut ast, arg_str(args, 1), charset);
            let mut values = Vec::new();
            string_values(&mut ast, &mut values);
            (json!({"diagnostics": diagnostics, "values": values}), None)
        }
        "isCatalogFile" => {
            let i18n = args.get(1).map(|o| CatalogDir {
                catalog_dir: o.get("catalogDir").and_then(Value::as_str),
            });
            (json!(is_catalog_file(arg_str(args, 0), i18n)), None)
        }
        "isI18nPackageFile" => (json!(is_i18n_package_file(arg_str(args, 0))), None),
        "discoverCatalogLocales" => (
            to_value(&discover_catalog_locales(fs, arg_str(args, 0))),
            None,
        ),
        "inferCatalogDir" => (to_value(&infer_catalog_dir(fs, arg_str(args, 0))), None),
        "prepareCatalog" => {
            let opts: PrepareArgs = serde_json::from_value(args[0].clone()).unwrap();
            let got = prepare_catalog(
                fs,
                &PrepareOptions {
                    locale: opts.locale.as_deref(),
                    i18n: opts.i18n.as_ref(),
                    from_file: opts.from_file.as_deref(),
                },
            )
            .unwrap();
            (to_value(&got), None)
        }
        "resolveCatalogSpecifier" => {
            let mut opts: ResolveOptions = serde_json::from_value(args[2].clone()).unwrap();
            let got = resolve_catalog_specifier(fs, arg_str(args, 0), arg_str(args, 1), &mut opts)
                .unwrap();
            (to_value(&got), Some(to_value(&opts)))
        }
        other => panic!("unknown fn {other}"),
    }
}

#[test]
fn i18n_matches_js() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/i18n.json")).unwrap();
    let root = Root::new();
    for (file, text) in fixture["tree"].as_object().unwrap() {
        let path = root.0.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, s(text)).unwrap();
    }
    let fs = RootedFs::new().with("<root>", &root.0);
    let rows = fixture["rows"].as_array().unwrap();
    assert!(rows.len() > 100);
    for (i, row) in rows.iter().enumerate() {
        let name = s(&row["fn"]);
        let args = row["args"].as_array().unwrap();
        let (mut got, after) = run(&fs, name, args);
        if lacks_file(&row["result"]) {
            drop_empty_file(&mut got);
        }
        assert_eq!(got, row["result"], "row {i}: {name} {args:?}");
        if let Some(mut after) = after {
            if lacks_file(&row["after"]) {
                drop_empty_file(&mut after);
            }
            assert_eq!(after, row["after"], "row {i}: {name} options after");
        }
    }
}

#[test]
fn every_transliteration_key_is_a_fixture_row() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/i18n.json")).unwrap();
    for (key, mapped) in i18n::TRANSLITERATIONS {
        let found = fixture["rows"].as_array().unwrap().iter().any(|row| {
            row["fn"] == "transliterate"
                && row["args"][0] == key.to_string()
                && row["result"]["text"] == mapped
        });
        assert!(found, "no fixture row for {key}");
    }
}

#[test]
fn unreadable_catalog_is_an_error_not_a_panic() {
    let root = Root::new();
    let dir = root.0.join("p/src/i18n");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("en.8bs"), [0xff, 0xfe, b'x']).unwrap();
    // Invalid UTF-8 reads lossily, like Node's 'utf8'.
    let fs = RootedFs::new().with("<root>", &root.0);
    assert!(fs.read_to_string("<root>/p/src/i18n/en.8bs").is_ok());
    // A directory named like a catalog exists but cannot be read.
    fs::create_dir_all(dir.join("de.8bs")).unwrap();
    let i18n = I18nOptions {
        catalog_dir: Some("<root>/p/src/i18n".into()),
        locales: Some(vec!["en".into(), "de".into()]),
        ..I18nOptions::default()
    };
    let got = prepare_catalog(
        &fs,
        &PrepareOptions {
            i18n: Some(&i18n),
            ..PrepareOptions::default()
        },
    );
    assert!(got.is_err());
}
