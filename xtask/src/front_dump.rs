//! `cargo xtask front-dump <out> --toolchain <dir> [--game <id>=<dir>]... [--builds <tap dir>]
//! [--release-of <js dump dir>]`: the front end's stage dumps in the JS layout, for
//! `xtask compare`.
//!
//! * `fe/<stem>/{tokens,ast,diagnostics}.json` for every source file of the toolchain and of each
//!   game's `src/` (scripts/oracle/frontend.mjs).
//! * `<id>/<program>/<target>/{diagnostics.json,modules/<stem>.{tokens,ast,ir}.json}` for every build the front tap
//!   recorded: the module driver runs on the build's options (`resolveSpecifier`'s third
//!   argument, `checkBx`'s fourth) over the entry file the tap's first `bind` names.
//! * `<id>/release/<out>/modules/...` for every release build of a JS dump tree (`--release-of`),
//!   with the options of the tapped build of the same program and target and the release's locale.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use front::module::{LinkOptions, Stage, canonical, parse_module};
use serde_json::Value;

const SKIPPED_DIRS: [&str; 3] = ["node_modules", "dist", ".git"];

/// The roots a dump replaces with tokens: each a root and its realpath.
#[derive(Debug, Clone, Default)]
pub struct Roots {
    pub toolchain: Vec<String>,
    pub project: Vec<String>,
}

fn candidates(root: &[String]) -> Vec<String> {
    let mut list: Vec<String> = root.iter().filter(|r| !r.is_empty()).cloned().collect();
    list.sort();
    list.dedup();
    list.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    list
}

impl Roots {
    /// A root and its realpath, as `rootsFor`.
    #[must_use]
    pub fn of(toolchain: &str, project: Option<&str>) -> Roots {
        let both = |p: &str| vec![p.to_string(), canonical(p)];
        Roots {
            toolchain: both(toolchain),
            project: project.map(both).unwrap_or_default(),
        }
    }

    /// `tokenizePath`: the toolchain first; only a whole segment matches.
    #[must_use]
    pub fn tokenize(&self, path: &str) -> String {
        for (root, token) in [
            (&self.toolchain, "<toolchain>"),
            (&self.project, "<project>"),
        ] {
            for prefix in candidates(root) {
                if path == prefix {
                    return token.to_string();
                }
                if let Some(rest) = path
                    .strip_prefix(prefix.as_str())
                    .and_then(|r| r.strip_prefix('/'))
                {
                    return format!("{token}/{rest}");
                }
            }
        }
        path.to_string()
    }

    /// The reverse: `<toolchain>/x` becomes the real path (the first, unresolved, candidate).
    #[must_use]
    pub fn detokenize(&self, text: &str) -> String {
        for (root, token) in [
            (&self.toolchain, "<toolchain>"),
            (&self.project, "<project>"),
        ] {
            let Some(first) = root.first() else { continue };
            if text == token {
                return first.clone();
            }
            if let Some(rest) = text.strip_prefix(token).filter(|r| r.starts_with('/')) {
                return format!("{first}{rest}");
            }
        }
        text.to_string()
    }

    /// `tokenStem`: `<toolchain>/a` becomes `toolchain/a`; a path under neither is `external/...`.
    #[must_use]
    pub fn stem(&self, path: &str) -> String {
        let token = self.tokenize(path);
        for name in ["toolchain", "project"] {
            let prefix = format!("<{name}>");
            if let Some(rest) = token.strip_prefix(prefix.as_str()) {
                return format!("{name}{rest}");
            }
        }
        format!(
            "external/{}",
            token.trim_start_matches('/').replacen(':', "", 1)
        )
    }
}

/// Every string value tokenized (`primitiveText`); keys stay as they are.
fn map_strings(value: &mut Value, f: &dyn Fn(&str) -> String) {
    match value {
        Value::String(s) => *s = f(s),
        Value::Array(items) => items.iter_mut().for_each(|v| map_strings(v, f)),
        Value::Object(map) => map.values_mut().for_each(|v| map_strings(v, f)),
        _ => {}
    }
}

/// The canonical text of a dumped value.
#[must_use]
pub fn dump_text(mut value: Value, roots: &Roots) -> String {
    map_strings(&mut value, &|s| roots.tokenize(s));
    oracle::canonical_json(&value)
}

/// `findSources`: every source file under `base`, sorted.
///
/// # Errors
/// A directory that cannot be read.
pub fn find_sources(base: &Path) -> Result<Vec<PathBuf>, String> {
    fn walk(dir: &Path, found: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            // A symlink is followed, as `Dirent` of a link is neither file nor directory in JS:
            // only real files and directories count.
            if kind.is_dir() {
                if !SKIPPED_DIRS.contains(&name.as_str()) {
                    walk(&entry.path(), found)?;
                }
            } else if kind.is_file() && diagnostics::source_kind_of(&name).is_some() {
                found.push(entry.path());
            }
        }
        Ok(())
    }
    let mut found = Vec::new();
    walk(base, &mut found)?;
    found.sort();
    Ok(found)
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

/// `frontendOf`: `(tokens, ast, diagnostics)` of one file as canonical text; `ast` is `None` for
/// a media file.
#[must_use]
pub fn frontend_of(file: &str, text: &str, roots: &Roots) -> (String, Option<String>, String) {
    let kind = diagnostics::source_kind_of(file).unwrap_or(syntax::SourceKind::Bs);
    if matches!(kind, syntax::SourceKind::Bg | syntax::SourceKind::Ba) {
        let media = media::analyze_media(text, file, kind.as_str());
        let value = |v: Value| dump_text(v, roots);
        return (
            value(serde_json::to_value(&media.tokens).unwrap_or(Value::Null)),
            None,
            value(serde_json::to_value(&media.diagnostics).unwrap_or(Value::Null)),
        );
    }
    let mut tokens = None;
    let mut ast = None;
    let mut found = Vec::new();
    let mut dump = |stage: Stage, _key: &str, value: Value| match stage {
        Stage::Tokens => tokens = Some(dump_text(value, roots)),
        Stage::Ast => ast = Some(dump_text(value, roots)),
        Stage::ModuleIr => {}
    };
    let _ = parse_module(file, text, &mut found, Some(&mut dump));
    (
        tokens.unwrap_or_default(),
        ast,
        dump_text(serde_json::to_value(&found).unwrap_or(Value::Null), roots),
    )
}

fn read_text(path: &Path) -> Result<String, String> {
    fs::read(path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// One group of the front-end dump: the files, their roots and the project id, if any.
fn dump_group(out: &Path, base: &Path, roots: &Roots, id: Option<&str>) -> Result<usize, String> {
    let mut written = 0;
    for file in find_sources(base)? {
        let file_text = file.to_string_lossy().into_owned();
        let tokenized = roots.stem(&file_text);
        let stem = match id {
            Some(id) if tokenized.starts_with("project/") => {
                format!("project/{id}/{}", &tokenized["project/".len()..])
            }
            _ => tokenized,
        };
        if stem.split('/').any(|s| s == "modules") {
            return Err(format!(
                "{stem}: a directory named \"modules\" would be read as a build's module directory"
            ));
        }
        let dir = out.join("fe").join(&stem);
        let (tokens, ast, diagnostics) = frontend_of(&file_text, &read_text(&file)?, roots);
        write(&dir.join("tokens.json"), &tokens)?;
        if let Some(ast) = ast {
            write(&dir.join("ast.json"), &ast)?;
        }
        write(&dir.join("diagnostics.json"), &diagnostics)?;
        written += if ast_present(&dir) { 3 } else { 2 };
    }
    Ok(written)
}

fn ast_present(dir: &Path) -> bool {
    dir.join("ast.json").exists()
}

/// What one tapped build recorded that the front end needs.
struct BuildTap {
    options: Value,
    strict: bool,
    entry: String,
}

/// Reads a build's tap: the first `resolveSpecifier`, `checkBx` and `bind` records.
fn read_tap(path: &Path) -> Result<BuildTap, String> {
    let text = read_text(path)?;
    let (mut options, mut strict, mut entry) = (None, None, None);
    for line in text.lines() {
        if options.is_some() && strict.is_some() && entry.is_some() {
            break;
        }
        let wanted = [
            (options.is_none(), "\"fn\":\"resolveSpecifier\""),
            (strict.is_none(), "\"fn\":\"checkBx\""),
            (entry.is_none(), "\"fn\":\"bind\""),
        ];
        if !wanted.iter().any(|(need, tag)| *need && line.contains(tag)) {
            continue;
        }
        let record: Value =
            serde_json::from_str(line).map_err(|e| format!("{}: {e}", path.display()))?;
        let args = record.get("args").and_then(Value::as_array);
        match (record.get("fn").and_then(Value::as_str), args) {
            (Some("resolveSpecifier"), Some(a)) if options.is_none() => options = a.get(2).cloned(),
            (Some("checkBx"), Some(a)) if strict.is_none() => {
                strict = Some(
                    a.get(3)
                        .and_then(|o| o.get("strict"))
                        .and_then(Value::as_bool)
                        != Some(false),
                );
            }
            (Some("bind"), Some(a)) if entry.is_none() => {
                entry = a.get(1).and_then(Value::as_str).map(str::to_string)
            }
            _ => {}
        }
    }
    Ok(BuildTap {
        options: options
            .ok_or_else(|| format!("{}: no resolveSpecifier record", path.display()))?,
        strict: strict.unwrap_or(true),
        entry: entry.ok_or_else(|| format!("{}: no bind record", path.display()))?,
    })
}

/// A web release's `machine` option: the hardware tag its file twins carry and the facts it sets on
/// top of the web machine's own (`resolveHardware`, one option).
pub struct Skin {
    tag: Option<String>,
    /// The web machine's own facts with this value's facts over them.
    facts: serde_json::Map<String, Value>,
}

impl Skin {
    /// The skin a web release's output name ends in (`<name>-<value>.wasm`), from the toolchain's
    /// `packages/web/package.json`; the longest value wins. `None` for the default or no match.
    fn of(toolchain: &Path, output: &str) -> Option<Self> {
        let text = fs::read_to_string(toolchain.join("packages/web/package.json")).ok()?;
        let package: Value = serde_json::from_str(&text).ok()?;
        let option = package.pointer("/8bitscript/hardware/options/machine")?;
        let default = option.get("default").and_then(Value::as_str);
        let stem = output.strip_suffix(".wasm")?;
        let (value, entry) = option
            .get("values")?
            .as_object()?
            .iter()
            .filter(|(v, _)| Some(v.as_str()) != default && stem.ends_with(&format!("-{v}")))
            .max_by_key(|(v, _)| v.len())?;
        let tag = match entry.get("tag") {
            None => Some(value.clone()),
            Some(t) => t.as_str().map(str::to_string),
        };
        let mut facts = package
            .pointer("/8bitscript/hardware/facts")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (k, v) in entry
            .get("facts")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            facts.insert(k.clone(), v.clone());
        }
        Some(Self { tag, facts })
    }

    fn apply(&self, options: &mut Value) {
        let Some(map) = options.as_object_mut() else {
            return;
        };
        map.insert(
            "tags".into(),
            Value::Array(self.tag.iter().cloned().map(Value::String).collect()),
        );
        if let Some(Value::Object(facts)) = map.get_mut("facts") {
            for (k, v) in &self.facts {
                facts.insert(k.clone(), v.clone());
            }
        }
    }
}

/// The module dumps of one build: `modules/<stem><suffix>` files under `build_dir`.
fn dump_build(
    build_dir: &Path,
    tap: &BuildTap,
    roots: &Roots,
    locale: Option<&str>,
    skin: Option<&Skin>,
) -> Result<usize, String> {
    let mut options = tap.options.clone();
    if let Some(skin) = skin {
        skin.apply(&mut options);
    }
    map_strings(&mut options, &|s| roots.detokenize(s));
    let mut link = LinkOptions::from_json(&options, tap.strict)?;
    // The recorded call was a path-form one; `loadGraph` sets the flag itself, per import.
    link.spec.base.path_form = false;
    if let Some(locale) = locale {
        link.spec.base.locale = Some(locale.to_string());
    }
    let entry = roots.detokenize(&tap.entry);
    let text = read_text(Path::new(&entry))?;
    let mut files: BTreeMap<String, String> = BTreeMap::new();
    let mut dump = |stage: Stage, key: &str, value: Value| {
        let suffix = match stage {
            Stage::Tokens => ".tokens.json",
            Stage::Ast => ".ast.json",
            Stage::ModuleIr => ".ir.json",
        };
        files.insert(
            format!("modules/{}{suffix}", roots.stem(key)),
            dump_text(value, roots),
        );
    };
    let mut diagnostics = Vec::new();
    front::graph::load_graph(&text, &entry, &mut diagnostics, &link, Some(&mut dump))?;
    for (rel, text) in &files {
        write(&build_dir.join(rel), text)?;
    }
    let found = serde_json::to_value(&diagnostics).map_err(|e| e.to_string())?;
    write(
        &build_dir.join("diagnostics.json"),
        &dump_text(found, roots),
    )?;
    Ok(files.len())
}

fn project_dir(toolchain: &Path, games: &BTreeMap<String, PathBuf>, id: &str) -> PathBuf {
    games
        .get(id)
        .cloned()
        .unwrap_or_else(|| toolchain.join("packages").join(id))
}

fn find_files(root: &Path, name: &str, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            find_files(&path, name, found);
        } else if entry.file_name().to_string_lossy() == name {
            found.push(path);
        }
    }
}

/// The command; returns the exit code (1 when a build or release could not be dumped).
///
/// # Errors
/// Bad usage or an unreadable input.
pub fn command(args: &[String]) -> Result<u8, String> {
    const USAGE: &str = "usage: cargo xtask front-dump <out> --toolchain <dir> [--game <id>=<dir>]... [--builds <tap dir>] [--release-of <js dump dir>]";
    let mut out: Option<PathBuf> = None;
    let mut toolchain: Option<PathBuf> = None;
    let mut games: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut builds: Option<PathBuf> = None;
    let mut release_of: Option<PathBuf> = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match arg.as_str() {
            "--toolchain" => toolchain = Some(PathBuf::from(value("--toolchain")?)),
            "--builds" => builds = Some(PathBuf::from(value("--builds")?)),
            "--release-of" => release_of = Some(PathBuf::from(value("--release-of")?)),
            "--game" => {
                let v = value("--game")?;
                let (id, dir) = v.split_once('=').ok_or("--game needs <id>=<dir>")?;
                games.insert(id.to_string(), PathBuf::from(dir));
            }
            flag if flag.starts_with("--") => {
                return Err(format!("unknown option `{flag}`\n{USAGE}"));
            }
            dir if out.is_none() => out = Some(PathBuf::from(dir)),
            _ => return Err(USAGE.to_string()),
        }
    }
    let (Some(out), Some(toolchain)) = (out, toolchain) else {
        return Err(USAGE.to_string());
    };
    let toolchain_text = toolchain.to_string_lossy().into_owned();
    let mut written = dump_group(&out, &toolchain, &Roots::of(&toolchain_text, None), None)?;
    for (id, dir) in &games {
        let roots = Roots::of(&toolchain_text, Some(&dir.to_string_lossy()));
        written += dump_group(&out, &dir.join("src"), &roots, Some(id))?;
    }
    println!("front-dump: {written} front-end files");
    let mut failures = 0;
    let mut tapped: BTreeMap<String, (PathBuf, BuildTap)> = BTreeMap::new();
    if let Some(builds) = &builds {
        let mut taps = Vec::new();
        find_files(builds, "0.jsonl", &mut taps);
        let mut modules = 0;
        for path in taps {
            let rel = path
                .parent()
                .and_then(|p| p.strip_prefix(builds).ok())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let Some((id_program, target)) = rel.rsplit_once('/') else {
                continue;
            };
            let Some((id, program)) = id_program.rsplit_once('/') else {
                continue;
            };
            let roots = Roots::of(
                &toolchain_text,
                Some(&project_dir(&toolchain, &games, id).to_string_lossy()),
            );
            let result = read_tap(&path).and_then(|tap| {
                let n = dump_build(&out.join(&rel), &tap, &roots, None, None)?;
                Ok((n, tap))
            });
            match result {
                Ok((n, tap)) => {
                    modules += n;
                    tapped.insert(format!("{id}/{program}/{target}"), (out.join(&rel), tap));
                }
                Err(e) => {
                    failures += 1;
                    eprintln!("ERROR {rel}: {e}");
                }
            }
        }
        println!(
            "front-dump: {} builds, {modules} module files",
            tapped.len()
        );
    }
    if let Some(js) = &release_of {
        let mut manifests = Vec::new();
        find_files(js, "manifest.json", &mut manifests);
        let (mut done, mut skipped) = (0, 0);
        for path in manifests {
            let Some(dir) = path.parent() else { continue };
            let rel = dir
                .strip_prefix(js)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let Some((id, name)) = rel.split_once("/release/") else {
                continue;
            };
            let manifest: Value = serde_json::from_str(&read_text(&path)?)
                .map_err(|e| format!("{}: {e}", path.display()))?;
            let text = |k: &str| manifest.get(k).and_then(Value::as_str);
            let (Some(program), Some(target)) = (text("program"), text("target")) else {
                continue;
            };
            let Some((_, tap)) = tapped.get(&format!("{id}/{program}/{target}")) else {
                skipped += 1;
                eprintln!("skip {rel}: no tapped build {id}/{program}/{target}");
                continue;
            };
            let roots = Roots::of(
                &toolchain_text,
                Some(&project_dir(&toolchain, &games, id).to_string_lossy()),
            );
            let skin = if text("machine") == Some("web") {
                Skin::of(&toolchain, name)
            } else {
                None
            };
            match dump_build(&out.join(&rel), tap, &roots, text("locale"), skin.as_ref()) {
                Ok(_) => done += 1,
                Err(e) => {
                    failures += 1;
                    eprintln!("ERROR {rel}: {e}");
                }
            }
        }
        println!("front-dump: {done} releases, {skipped} skipped");
    }
    Ok(u8::from(failures > 0))
}
