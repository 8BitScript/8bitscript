//! `xtask tap --front`: replay the records of `scripts/oracle/front-tap`.
//!
//! The front end has no backend counters, so the build's [`Counters`] are not used. Each name
//! maps to the `tap::<fn>::replay` of the crate that ports it.

use front_replay::Replay as Front;
use mos::build::Counters;
use mos::tap::Replay;
use serde_json::Value;

/// The tapped function names, in the order [`replay`] dispatches them.
pub const NAMES: [&str; 17] = [
    "bind",
    "bindImportedComponents",
    "check",
    "scanDeclaredTypes",
    "layoutTemplate",
    "checkBx",
    "elaborateBx",
    "applyCatalogCharset",
    "resolveCatalogSpecifier",
    "foldCompileTime",
    "lower",
    "findImports",
    "pathFormSpecifiers",
    "resolveSpecifier",
    "nativeSourcesBeside",
    "parseMediaModule",
    "elaborateMedia",
];

fn convert(outcome: Front) -> Replay {
    match outcome {
        Front::Match => Replay::Match,
        Front::Mismatch(pointer, js, rust) => Replay::Mismatch(pointer, js, rust),
        Front::Skip => Replay::Skip,
    }
}

/// Replays `record` of the JS function `name`; `None` when `name` is not tapped.
pub fn replay(name: &str, record: &Value, _counters: &mut Counters) -> Option<Replay> {
    let outcome = match name {
        "bind" => sema::tap::bind::replay(record),
        "bindImportedComponents" => sema::tap::bind_imported_components::replay(record),
        "check" => sema::tap::check::replay(record),
        "scanDeclaredTypes" => sema::tap::scan_declared_types::replay(record),
        "layoutTemplate" => sema::tap::layout_template::replay(record),
        "checkBx" => bx::tap::check_bx::replay(record),
        "elaborateBx" => bx::tap::elaborate_bx::replay(record),
        "applyCatalogCharset" => i18n::tap::apply_catalog_charset::replay(record),
        "resolveCatalogSpecifier" => i18n::tap::resolve_catalog_specifier::replay(record),
        "foldCompileTime" => fold::tap::fold_compile_time::replay(record),
        "lower" => lower::tap::lower::replay(record),
        "findImports" => resolver::tap::find_imports::replay(record),
        "pathFormSpecifiers" => resolver::tap::path_form_specifiers::replay(record),
        "resolveSpecifier" => resolver::tap::resolve_specifier::replay(record),
        "nativeSourcesBeside" => resolver::tap::native_sources_beside::replay(record),
        "parseMediaModule" => media::tap::parse_media_module::replay(record),
        "elaborateMedia" => media::tap::elaborate_media::replay(record),
        _ => return None,
    };
    Some(convert(outcome))
}
