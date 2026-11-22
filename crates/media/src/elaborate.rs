//! Port of `media/elaborate.mjs:1-158` and `:180-380`: a media module to IR. Host decode (PNG,
//! WAV, FLAC) happens here, in the linker, because this is the first stage that reads the disk.
//! The bytes become a const array plus a bind function; the handle is an exported const. Array
//! parameters are not lowered yet, so bind copies one byte at a time through `graphics.bind` /
//! `audio.bind`. `spriteBounds` (`:159-179`) is `sprite_bounds` below.
//!
//! Declared deviations from the JS:
//! - A machine's media module is `machines::for_machine(<package directory name>)`; a package
//!   whose `"8bitscript".media` module is not one of the seven gets default lowering (recorded
//!   in `oracle/divergences.toml`).
//! - The JS mutates the module (`ir`, `ast`, `tokens`); `elaborate_media` returns the `ir`.
//! - A read error of the file system is reported with the message Node gives for the two common
//!   cases (a directory, no permission) and the platform text otherwise.
//! - A sprite size that is not a whole number is cut by `as usize`; the checker refuses one.

use std::ffi::OsStr;
use std::path::Path;

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use indexmap::{IndexMap, IndexSet};
use jsnum::{number_to_string, utf16_len};
use lower::module::{IrConst, IrImport, IrSpecifier, ModuleIr};
use media_tools::audio::{decode_flac_in, decode_wav, encode_dpcm};
use media_tools::png::{decode_png, slice_frames};
use mos_ir::{
    Assign, Binop, ChrPatch, Const, Expr, For, Function, Global, GlobalInit, Index, Local,
    NamespaceCall, Ref, Stmt,
};
use resolver::specifier::{Resolution, SpecifierOptions, resolve_specifier};
use resolver::variants::Options as ResolveOptions;

use crate::MediaModule;
use crate::audio::song::encode_song;
use crate::lower_default::{lower_audio_default, lower_graphics_default};
use crate::machine::{Facts, Frame, MachineMedia, MediaSlots, Pcm};
use crate::machines::{self, sprite_pack::px};

/// The data bank every chip driver keeps for the program's samples and songs (the drivers' `bank`
/// arrays are this size, indexed by a byte). A program that binds more is refused here rather
/// than silently losing the end of a song at run time.
pub const AUDIO_BANK_BYTES: u32 = 255;

/// What `elaborateMedia` reads of its `options`.
#[derive(Debug, Clone, Default)]
pub struct ElaborateOptions {
    pub machine: Option<String>,
    pub tags: Option<Vec<String>>,
    pub facts: Facts,
    pub checkout: Option<String>,
    /// One counter for the whole link, so sprites in different `.8bg` files get different slots.
    pub media_slots: Option<MediaSlots>,
}

/// `path.join` of two posix paths: joined, then normalized (no working directory involved).
fn join(a: &str, b: &str) -> String {
    let joined = if a.is_empty() {
        b.to_string()
    } else {
        format!("{a}/{b}")
    };
    if joined.is_empty() {
        return ".".to_string();
    }
    let absolute = joined.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let body = parts.join("/");
    match (absolute, body.is_empty()) {
        (true, _) => format!("/{body}"),
        (false, true) => ".".to_string(),
        (false, false) => body,
    }
}

/// `resolveMediaPath(specifier, fromFile)`.
fn resolve_media_path(specifier: Option<&str>, from_file: &str) -> Option<String> {
    let spec = specifier.filter(|s| !s.is_empty())?;
    if spec.starts_with('/') {
        return Some(spec.to_string());
    }
    Some(join(resolver::posix::dirname(from_file), spec))
}

/// `loadMachineMedia(machine, fromFile, options)`. Only `resolveSpecifier` can throw out of it:
/// everything inside the `try` answers `null`.
fn load_machine_media(
    machine: Option<&str>,
    from_file: &str,
    checkout: Option<&str>,
    tags: Option<&[String]>,
) -> Result<Option<Box<dyn MachineMedia>>, String> {
    let Some(machine) = machine.filter(|m| !m.is_empty()) else {
        return Ok(None);
    };
    let mut options = SpecifierOptions {
        base: ResolveOptions {
            machine: Some(machine.to_string()),
            tags: tags.map(<[String]>::to_vec),
            ..ResolveOptions::default()
        },
        checkout: checkout.map(str::to_string),
        ..SpecifierOptions::default()
    };
    let resolved = resolve_specifier(
        &format!("@8bitscript/{machine}"),
        from_file,
        &mut options,
        &mut IndexSet::new(),
    )?;
    let Some(Resolution::Resolved(resolved)) = resolved else {
        return Ok(None);
    };
    let Some(path) = resolved.path.filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let mut dir = resolver::posix::dirname(&path).to_string();
    for _ in 0..6 {
        let pkg_path = join(&dir, "package.json");
        if Path::new(&pkg_path).exists() {
            return package_media(&dir, &pkg_path, machine, from_file, checkout, tags);
        }
        let parent = resolver::posix::dirname(&dir).to_string();
        if parent == dir {
            break;
        }
        dir = parent;
    }
    Ok(None)
}

/// The body of the `try` in `loadMachineMedia`, once a `package.json` is found.
fn package_media(
    dir: &str,
    pkg_path: &str,
    machine: &str,
    from_file: &str,
    checkout: Option<&str>,
    tags: Option<&[String]>,
) -> Result<Option<Box<dyn MachineMedia>>, String> {
    let Ok(text) = std::fs::read_to_string(pkg_path) else {
        return Ok(None);
    };
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Ok(None);
    };
    let config = pkg.get("8bitscript");
    let wasm_media = config
        .and_then(|c| c.get("wasmMedia"))
        .and_then(serde_json::Value::as_str)
        .filter(|w| !w.is_empty());
    // A `--web` build of a machine with no hardware sprites in the page lowers with the web
    // target's module: the package names it, and the build's internal `web` tag says so.
    if let Some(wasm) = wasm_media
        && machine != wasm
        && tags.is_some_and(|t| t.iter().any(|tag| tag == "web"))
    {
        let kept: Vec<String> = tags
            .unwrap_or_default()
            .iter()
            .filter(|tag| *tag != "web")
            .cloned()
            .collect();
        return Ok(
            load_machine_media(Some(wasm), from_file, checkout, Some(&kept)).unwrap_or(None),
        );
    }
    let Some(rel) = config
        .and_then(|c| c.get("media"))
        .and_then(serde_json::Value::as_str)
        .filter(|r| !r.is_empty())
    else {
        return Ok(None);
    };
    // `require` of a module that is not there throws, and the `catch` answers `null`.
    if !Path::new(&join(dir, rel)).exists() {
        return Ok(None);
    }
    Ok(machines::for_machine(resolver::posix::basename(dir)))
}

fn empty_ir() -> ModuleIr {
    ModuleIr {
        chr_patches: Some(Vec::new()),
        ..ModuleIr::default()
    }
}

fn const_handle(name: &str, value: i64, start: Option<u32>, length: Option<u32>) -> IrConst {
    IrConst {
        name: name.to_string(),
        ty: "utinyint".to_string(),
        value: jsnum::Nullable::Value(value),
        pending: None,
        string: None,
        exported: true,
        start: i64::from(start.unwrap_or(0)),
        length: length.map_or(utf16_len(name) as i64, i64::from),
    }
}

/// `data` as the integers a const array holds (R2.1: a non-integer saturates).
fn ints(data: &[f64]) -> Vec<i64> {
    data.iter().map(|&v| v as i64).collect()
}

fn data_global(name: &str, bytes: &[f64]) -> Global {
    let data = if bytes.is_empty() {
        vec![0]
    } else {
        ints(bytes)
    };
    Global {
        name: name.to_string(),
        ty: "utinyint".to_string(),
        volatile: false,
        address: None,
        array: Some(data.len() as i64),
        constant: Some(true),
        init: Some(GlobalInit::Array(data)),
        exported: false,
        start: 0,
        length: utf16_len(name) as i64,
        string_capacity: None,
    }
}

fn konst(value: i64, ty: &str) -> Expr {
    Expr::Const(Const {
        value,
        ty: Some(ty.to_string()),
    })
}

fn reference(name: &str, ty: Option<&str>) -> Expr {
    Expr::Ref(Ref {
        name: name.to_string(),
        ty: ty.map_or(jsnum::Nullable::Absent, |t| {
            jsnum::Nullable::Value(t.to_string())
        }),
        start: None,
        length: None,
    })
}

fn namespace_call(namespace: &str, member: &str, args: Vec<Expr>) -> Stmt {
    Stmt::NamespaceCall(NamespaceCall {
        namespace: namespace.to_string(),
        member: member.to_string(),
        args,
        ty: jsnum::Nullable::Value("void".to_string()),
        start: None,
        length: None,
    })
}

/// A `bindFunction` call after the meta call: `{member, args}`.
struct After {
    member: &'static str,
    args: Vec<i64>,
}

/// `bindFunction(name, ns, memberBind, memberMeta, slot, dataName, length, metaArgs, bindPrefix, after)`.
#[allow(clippy::too_many_arguments)]
fn bind_function(
    name: &str,
    ns: &str,
    member_bind: &str,
    member_meta: &str,
    slot: i64,
    data_name: &str,
    length: usize,
    meta_args: &[i64],
    bind_prefix: &[i64],
    after: &[After],
) -> Function {
    let idx = if length > 255 {
        "usmallint"
    } else {
        "utinyint"
    };
    let mut body = Vec::new();
    if length > 0 && !data_name.is_empty() {
        let mut args: Vec<Expr> = bind_prefix.iter().map(|&v| konst(v, "utinyint")).collect();
        args.push(konst(slot, "utinyint"));
        args.push(reference("i", Some(idx)));
        args.push(Expr::Index(Index {
            array: Box::new(reference(data_name, None)),
            index: Box::new(reference("i", Some(idx))),
            element_type: Some("utinyint".to_string()),
            ty: Some("utinyint".to_string()),
        }));
        body.push(Stmt::For(For {
            init: jsnum::Nullable::Value(Box::new(Stmt::Local(Local {
                name: "i".to_string(),
                ty: idx.to_string(),
                init: konst(0, idx),
                inlined: None,
                start: Some(0),
                length: Some(1),
            }))),
            test: jsnum::Nullable::Value(Expr::Binop(Binop {
                operator: "<".to_string(),
                left: Box::new(reference("i", Some(idx))),
                right: Box::new(konst(length as i64, idx)),
                ty: Some("bool".to_string()),
            })),
            update: jsnum::Nullable::Value(Box::new(Stmt::Assign(Assign {
                target: "i".to_string(),
                value: Expr::Binop(Binop {
                    operator: "+".to_string(),
                    left: Box::new(reference("i", Some(idx))),
                    right: Box::new(konst(1, idx)),
                    ty: Some(idx.to_string()),
                }),
                start: None,
                length: None,
            }))),
            body: vec![namespace_call(ns, member_bind, args)],
            unroll: None,
            start: None,
            length: None,
        }));
    }
    body.push(namespace_call(
        ns,
        member_meta,
        meta_args.iter().map(|&v| konst(v, "utinyint")).collect(),
    ));
    for call in after {
        body.push(namespace_call(
            ns,
            call.member,
            call.args.iter().map(|&v| konst(v, "utinyint")).collect(),
        ));
    }
    Function {
        name: name.to_string(),
        exported: false,
        component: None,
        owner: jsnum::Nullable::Absent,
        method: None,
        media_bind: Some(true),
        params: Vec::new(),
        return_type: "void".to_string(),
        body,
        start: 0,
        length: utf16_len(name) as i64,
        file: None,
        state: None,
    }
}

/// The message Node gives for a failed `readFileSync` (best effort beyond the two common causes).
fn io_message(error: &std::io::Error, path: &str) -> String {
    match error.kind() {
        std::io::ErrorKind::IsADirectory => {
            "EISDIR: illegal operation on a directory, read".to_string()
        }
        std::io::ErrorKind::PermissionDenied => format!("EACCES: permission denied, open '{path}'"),
        _ => error.to_string(),
    }
}

fn js_u32(n: i64) -> u32 {
    u32::try_from(n.max(0)).unwrap_or(u32::MAX)
}

/// `decodeSpriteSource(sprite, file, diagnostics)`.
fn decode_sprite_source(
    sprite: &crate::graphics::Sprite,
    file: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<Frame> {
    let source = sprite.source.as_deref();
    let shown = source.unwrap_or("null");
    let path = resolve_media_path(source, file);
    let Some(path) = path.filter(|p| Path::new(p).exists()) else {
        diagnostics.push(diagnostic(
            codes::GFX_MISSING_SOURCE,
            format!("cannot find source '{shown}'"),
            file,
            sprite.source_start,
            sprite.source_length,
            Severity::Error,
        ));
        return Vec::new();
    };
    let decoded = std::fs::read(&path)
        .map_err(|e| io_message(&e, &path))
        .and_then(|bytes| decode_png(&bytes));
    let decoded = match decoded {
        Ok(d) => d,
        Err(message) => {
            diagnostics.push(diagnostic(
                codes::GFX_MISSING_SOURCE,
                format!("cannot decode '{shown}': {message}"),
                file,
                sprite.source_start,
                sprite.source_length,
                Severity::Error,
            ));
            return Vec::new();
        }
    };
    if (decoded.width as f64) < sprite.width || (decoded.height as f64) < sprite.height {
        diagnostics.push(diagnostic(
            codes::GFX_SOURCE_TOO_SMALL,
            format!(
                "source '{shown}' is {}x{}, smaller than size {}x{}",
                decoded.width,
                decoded.height,
                number_to_string(sprite.width),
                number_to_string(sprite.height)
            ),
            file,
            sprite.size_start,
            js_u32(sprite.size_length),
            Severity::Error,
        ));
        return Vec::new();
    }
    let (fw, fh) = (sprite.width as usize, sprite.height as usize);
    slice_frames(
        &decoded.rgba,
        decoded.width as usize,
        decoded.height as usize,
        fw,
        fh,
    )
    .into_iter()
    .map(|rgba| Frame {
        width: fw as u32,
        height: fh as u32,
        rgba,
    })
    .collect()
}

/// `decodeSampleSource(sample, file, diagnostics)`.
fn decode_sample_source(
    sample: &crate::audio::Sample,
    file: &str,
    diagnostics: &mut Vec<Diagnostic>,
    search: Option<&OsStr>,
) -> Option<Pcm> {
    let source = sample.source.as_deref();
    let shown = source.unwrap_or("null");
    let path = resolve_media_path(source, file);
    let Some(path) = path.filter(|p| Path::new(p).exists()) else {
        diagnostics.push(diagnostic(
            codes::AUD_MISSING_SOURCE,
            format!("cannot find source '{shown}'"),
            file,
            sample.source_start,
            sample.source_length,
            Severity::Error,
        ));
        return None;
    };
    let decoded = if path.to_lowercase().ends_with(".flac") {
        decode_flac_in(&path, search).map_err(|e| (e.message, e.code))
    } else {
        std::fs::read(&path)
            .map_err(|e| (io_message(&e, &path), None))
            .and_then(|bytes| decode_wav(&bytes).map_err(|m| (m, None)))
    };
    match decoded {
        Ok(pcm) => {
            let dpcm = encode_dpcm(&pcm.samples, f64::from(pcm.sample_rate));
            Some(Pcm {
                sample_rate: pcm.sample_rate,
                samples: pcm.samples,
                dpcm,
            })
        }
        Err((_, Some(code))) if code == "FLAC_NEEDS_FFMPEG" => {
            diagnostics.push(diagnostic(
                codes::AUD_FLAC_NEEDS_FFMPEG,
                format!("FLAC source '{shown}' needs ffmpeg on PATH"),
                file,
                sample.source_start,
                sample.source_length,
                Severity::Error,
            ));
            None
        }
        Err((message, _)) => {
            diagnostics.push(diagnostic(
                codes::AUD_MISSING_SOURCE,
                format!("cannot decode '{shown}': {message}"),
                file,
                sample.source_start,
                sample.source_length,
                Severity::Error,
            ));
            None
        }
    }
}

/// `elaborateMedia(module, diagnostics, options)`: the module's `ir`. `PATH` is searched for
/// `ffmpeg` when a sample is FLAC.
///
/// # Errors
/// A throw of the JS: `resolveSpecifier` failing (it is the one call outside the `try`), or a
/// module whose `gir` / `air` is `null`.
pub fn elaborate_media(
    module: &MediaModule,
    diagnostics: &mut Vec<Diagnostic>,
    options: &mut ElaborateOptions,
) -> Result<ModuleIr, String> {
    let path = std::env::var_os("PATH");
    elaborate_media_in(module, diagnostics, options, path.as_deref())
}

/// `elaborate_media` with an explicit `PATH` for the FLAC decoder (the JS reads `process.env.PATH`).
///
/// # Errors
/// As `elaborate_media`.
pub fn elaborate_media_in(
    module: &MediaModule,
    diagnostics: &mut Vec<Diagnostic>,
    options: &mut ElaborateOptions,
    search: Option<&OsStr>,
) -> Result<ModuleIr, String> {
    let file = module.file.as_str();
    let lowering = load_machine_media(
        options.machine.as_deref(),
        file,
        options.checkout.as_deref(),
        options.tags.as_deref(),
    )?;
    let mut ir = empty_ir();
    let mut chr_patches: Vec<ChrPatch> = Vec::new();
    if module.media.kind == ".8bg" {
        elaborate_graphics(
            module,
            diagnostics,
            options,
            lowering.as_deref(),
            &mut ir,
            &mut chr_patches,
        )?;
    } else {
        elaborate_audio(
            module,
            diagnostics,
            options,
            lowering.as_deref(),
            &mut ir,
            search,
        )?;
    }
    ir.chr_patches = Some(chr_patches);
    Ok(ir)
}

fn elaborate_graphics(
    module: &MediaModule,
    diagnostics: &mut Vec<Diagnostic>,
    options: &mut ElaborateOptions,
    lowering: Option<&dyn MachineMedia>,
    ir: &mut ModuleIr,
    chr_patches: &mut Vec<ChrPatch>,
) -> Result<(), String> {
    let file = module.file.as_str();
    ir.imports.push(IrImport {
        source: "@8bitscript/graphics".to_string(),
        specifiers: vec![IrSpecifier {
            imported: "graphics".to_string(),
            local: "graphics".to_string(),
            start: 0,
            length: 8,
        }],
        path_form: None,
        start: 0,
        length: 0,
    });
    let gir = module
        .media
        .gir
        .as_ref()
        .ok_or("Cannot read properties of null (reading 'sprites')")?;
    // A sprite's slot is its place among every sprite in the build, not among the ones in its own
    // file: two .8bg files each start counting at zero, and a driver that keeps one object per
    // slot would draw the second file's first sprite over the first file's.
    for (index, sprite) in gir.sprites.iter().enumerate() {
        let slot = match options.media_slots.as_mut() {
            Some(slots) => {
                let taken = slots.graphics;
                slots.graphics += 1;
                i64::from(taken)
            }
            None => index as i64,
        };
        ir.consts.push(const_handle(
            &sprite.name,
            slot,
            Some(sprite.start),
            Some(sprite.length),
        ));
        let frames = decode_sprite_source(sprite, file, diagnostics);
        let result = match lowering {
            Some(machine) => machine.lower_graphics(
                sprite,
                &frames,
                &options.facts,
                file,
                options.media_slots.as_mut(),
            ),
            None => lower_graphics_default(sprite, &frames, file),
        };
        diagnostics.extend(result.diagnostics.unwrap_or_default());
        let data = result.data.unwrap_or_default();
        let data_name = format!("__8bg_{}", sprite.name);
        ir.globals.push(data_global(&data_name, &data));
        let [left, top, right, bottom] = sprite_bounds(&frames);
        ir.functions.push(bind_function(
            &format!("__8bs_media_bind_{}", sprite.name),
            "graphics",
            "bind",
            "meta",
            slot,
            &data_name,
            data.len(),
            &[
                slot,
                result.frames.unwrap_or(1.0) as i64,
                result.every.unwrap_or(8.0) as i64,
                result.kind.unwrap_or(0.0) as i64,
                result.width.unwrap_or(8.0) as i64,
                result.height.unwrap_or(8.0) as i64,
            ],
            &[],
            &[After {
                member: "bounds",
                args: vec![
                    slot,
                    i64::from(left),
                    i64::from(top),
                    i64::from(right),
                    i64::from(bottom),
                ],
            }],
        ));
        for patch in result.chr_patches.unwrap_or_default() {
            chr_patches.push(ChrPatch {
                tile: patch.tile as i64,
                bytes: patch.bytes,
            });
        }
    }
    Ok(())
}

fn elaborate_audio(
    module: &MediaModule,
    diagnostics: &mut Vec<Diagnostic>,
    options: &mut ElaborateOptions,
    lowering: Option<&dyn MachineMedia>,
    ir: &mut ModuleIr,
    search: Option<&OsStr>,
) -> Result<(), String> {
    let file = module.file.as_str();
    ir.imports.push(IrImport {
        source: "@8bitscript/audio".to_string(),
        specifiers: vec![IrSpecifier {
            imported: "audio".to_string(),
            local: "audio".to_string(),
            start: 0,
            length: 5,
        }],
        path_form: None,
        start: 0,
        length: 0,
    });
    let air = module
        .media
        .air
        .as_ref()
        .ok_or("Cannot read properties of null (reading 'samples')")?;
    let mut pcm_by_sample: IndexMap<String, Pcm> = IndexMap::new();
    for sample in &air.samples {
        if let Some(pcm) = decode_sample_source(sample, file, diagnostics, search) {
            pcm_by_sample.insert(sample.name.clone(), pcm);
        }
    }
    // What a machine's media module can ask of the compiler: the portable song encoding.
    let encode = |song: &crate::audio::Song| encode_song(air, song);
    let result = match lowering {
        Some(machine) => machine.lower_audio(air, &pcm_by_sample, &options.facts, file, &encode),
        None => lower_audio_default(
            air,
            &pcm_by_sample,
            file,
            options.machine.as_deref().unwrap_or("(none)"),
        ),
    };
    diagnostics.extend(result.diagnostics.unwrap_or_default());
    // A handle is the asset's place among every sample and song in the build, not in its own
    // file: the linker keeps the tally.
    let mut local = 0u32;
    let mut local_bytes = 0u32;
    let mut slot_for = |options: &mut ElaborateOptions| -> i64 {
        let counter = match options.media_slots.as_mut() {
            Some(tally) => &mut tally.audio,
            None => &mut local,
        };
        let taken = *counter;
        *counter += 1;
        i64::from(taken)
    };
    let mut bank = |options: &mut ElaborateOptions,
                    diagnostics: &mut Vec<Diagnostic>,
                    name: &str,
                    bytes: usize| {
        let counter = match options.media_slots.as_mut() {
            Some(tally) => &mut tally.audio_bytes,
            None => &mut local_bytes,
        };
        *counter = counter.saturating_add(u32::try_from(bytes).unwrap_or(u32::MAX));
        let total = *counter;
        if bytes > 0 && total > AUDIO_BANK_BYTES {
            diagnostics.push(diagnostic(
                codes::AUD_BANK_FULL,
                format!(
                    "the audio bank holds {AUDIO_BANK_BYTES} bytes of sample and song data across the whole program; '{name}' brings it to {total}"
                ),
                file,
                0,
                0,
                Severity::Error,
            ));
        }
    };
    for (index, sample) in result.samples.iter().enumerate() {
        let slot = slot_for(options);
        let node = air.samples.get(index);
        ir.consts.push(const_handle(
            &sample.name,
            slot,
            node.map(|n| n.start),
            node.map(|n| n.length),
        ));
        let data_name = format!("__8ba_sfx_{}", sample.name);
        if let Some(data) = sample.data.as_ref().filter(|d| !d.is_empty()) {
            bank(options, diagnostics, &sample.name, data.len());
            ir.globals.push(data_global(&data_name, data));
            ir.functions.push(bind_function(
                &format!("__8bs_media_bind_{}", sample.name),
                "audio",
                "bind",
                "meta",
                slot,
                &data_name,
                data.len(),
                &[0, slot, data.len() as i64, 0, 0, 0],
                &[0],
                &[],
            ));
        }
    }
    for (index, song) in result.songs.iter().enumerate() {
        let slot = slot_for(options);
        let node = air.songs.get(index);
        ir.consts.push(const_handle(
            &song.name,
            slot,
            node.map(|n| n.start),
            node.map(|n| n.length),
        ));
        let data_name = format!("__8ba_song_{}", song.name);
        if let Some(data) = song.data.as_ref().filter(|d| !d.is_empty()) {
            bank(options, diagnostics, &song.name, data.len());
            ir.globals.push(data_global(&data_name, data));
            ir.functions.push(bind_function(
                &format!("__8bs_media_bind_{}", song.name),
                "audio",
                "bind",
                "meta",
                slot,
                &data_name,
                data.len(),
                &[1, slot, data.len() as i64, 0, 0, 0],
                &[1],
                &[],
            ));
        }
    }
    for inst in &air.instruments {
        if ir.consts.iter().any(|c| c.name == inst.name) {
            continue;
        }
        ir.consts.push(const_handle(
            &inst.name,
            0,
            Some(inst.start),
            Some(inst.length),
        ));
    }
    Ok(())
}

/// The box a sprite's hit check uses: the union over every frame of the pixels
/// with alpha >= 16, as `[left, top, right, bottom]` with right and bottom
/// exclusive. No opaque pixel, or no frames, is `[0, 0, 0, 0]`, which never hits.
#[must_use]
pub fn sprite_bounds(frames: &[Frame]) -> [u32; 4] {
    let mut left = u32::MAX;
    let mut top = u32::MAX;
    let mut right = 0;
    let mut bottom = 0;
    for frame in frames {
        let (width, height) = (frame.width, frame.height);
        for y in 0..height {
            for x in 0..width {
                // A short `rgba` reads `undefined < 16`: false, so opaque.
                let alpha = (y as usize * width as usize + x as usize) * 4 + 3;
                if px(&frame.rgba, alpha) < 16.0 {
                    continue;
                }
                left = left.min(x);
                top = top.min(y);
                right = right.max(x + 1);
                bottom = bottom.max(y + 1);
            }
        }
    }
    if right == 0 {
        [0, 0, 0, 0]
    } else {
        [left, top, right, bottom]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32, alpha: impl Fn(u32, u32) -> u8) -> Frame {
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        for y in 0..height {
            for x in 0..width {
                rgba[((y * width + x) * 4 + 3) as usize] = alpha(x, y);
            }
        }
        Frame {
            width,
            height,
            rgba,
        }
    }

    #[test]
    fn no_frames_and_blank_frames_never_hit() {
        assert_eq!(sprite_bounds(&[]), [0, 0, 0, 0]);
        assert_eq!(sprite_bounds(&[frame(8, 8, |_, _| 15)]), [0, 0, 0, 0]);
    }

    #[test]
    fn frames_are_unioned() {
        let a = frame(8, 8, |x, y| if (x, y) == (1, 2) { 255 } else { 0 });
        let b = frame(8, 8, |x, y| if (x, y) == (5, 6) { 16 } else { 0 });
        assert_eq!(sprite_bounds(&[a, b]), [1, 2, 6, 7]);
    }

    #[test]
    fn a_short_buffer_counts_as_opaque() {
        let short = Frame {
            width: 2,
            height: 1,
            rgba: vec![0; 4],
        };
        assert_eq!(sprite_bounds(&[short]), [1, 0, 2, 1]);
    }
}
