//! The pilot builds a committed backend-input dump and writes the stage files; a build that
//! refuses writes `error.txt`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn scratch(name: &str) -> Scratch {
    let dir = std::env::temp_dir().join(format!("pilot-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Scratch(dir)
}

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../crates/mos-ir/tests/fixtures/hello-world-c64/backend-input.json");
    let mut value: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    // No native sources: the test must not need an installed toolchain.
    value["nativeSources"] = Value::Array(Vec::new());
    // An empty `main`: nothing calls a routine that only the native sources define.
    let entry = value["entry"].clone();
    let functions = value["functions"].as_array_mut().unwrap();
    functions.retain(|f| f["name"] == entry);
    functions[0]["body"] = Value::Array(Vec::new());
    value["globals"] = Value::Array(Vec::new());
    value["strings"] = Value::Array(Vec::new());
    value
}

fn run(name: &str, input: &Value) -> (Scratch, PathBuf, xtask::pilot::Summary) {
    let js = scratch(&format!("{name}-js"));
    let id = format!("t/main/{}", input["machine"].as_str().unwrap());
    let build = js.0.join(&id);
    fs::create_dir_all(&build).unwrap();
    fs::write(
        build.join("backend-input.json"),
        serde_json::to_string(input).unwrap(),
    )
    .unwrap();
    let out = scratch(&format!("{name}-out"));
    let toolchain = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let summary = xtask::pilot::run(&js.0, &out.0, &toolchain, &BTreeMap::new()).unwrap();
    let dir = out.0.join(&id);
    // Keep `js` alive through `out`'s lifetime by leaking nothing: the caller only needs `out`.
    drop(js);
    (out, dir, summary)
}

#[test]
fn a_build_writes_link_and_bytes() {
    let (_out, dir, summary) = run("ok", &fixture());
    let why = fs::read_to_string(dir.join("error.txt")).unwrap_or_default();
    assert_eq!((summary.built, summary.refused), (1, 0), "{why}");
    let bytes = fs::read_to_string(dir.join("bytes.hex")).unwrap();
    assert!(bytes.starts_with("01 08"), "a c64 prg loads at $0801");
    let link: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("link.json")).unwrap()).unwrap();
    assert!(link["symbols"].is_array() && link["layout"].is_array());
    assert!(!dir.join("error.txt").exists());
    assert!(!dir.join("size-report.json").exists());
}

#[test]
fn a_missing_entry_writes_error_txt() {
    let mut input = fixture();
    input["entry"] = Value::String("nowhere".to_string());
    let (_out, dir, summary) = run("entry", &input);
    assert_eq!((summary.built, summary.refused), (0, 1));
    assert_eq!(
        fs::read_to_string(dir.join("error.txt")).unwrap(),
        "the linked entry point 'nowhere' names no function in ir.functions\n"
    );
    assert!(!dir.join("bytes.hex").exists());
}

fn refusal(name: &str, input: &Value) -> String {
    let (_out, dir, summary) = run(name, input);
    assert_eq!((summary.built, summary.refused), (0, 1));
    fs::read_to_string(dir.join("error.txt")).unwrap()
}

#[test]
fn a_recursive_call_is_refused() {
    let mut input = fixture();
    input["functions"][0]["body"] = serde_json::json!([
        {"kind": "call", "args": [], "name": "main", "type": null, "start": 0, "length": 4}
    ]);
    assert_eq!(
        refusal("recursion", &input),
        "recursion isn't lowered yet: main -> main calls itself, directly or through another function\n"
    );
}

#[test]
fn a_pruned_frame_hook_is_refused() {
    let mut input = fixture();
    input["frameHook"] = serde_json::json!({"name": "tick", "used": true});
    let text = refusal("hook", &input);
    assert!(
        text.starts_with("the c64's frame runtime calls tick() after every hardware frame"),
        "{text}"
    );
}

#[test]
fn a_rom_image_array_without_a_ram_window_is_refused() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../crates/mos-ir/tests/fixtures/kinds-nes/backend-input.json");
    let mut input: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let defsym = input["hardware"]["build"]["defsym"]
        .as_object_mut()
        .unwrap();
    defsym.remove("__bss_origin");
    defsym.remove("__bss_ceiling");
    let text = refusal("bss", &input);
    assert!(
        text.contains("is a mutable array and the nes's image is a ROM")
            && text.contains("names no RAM window"),
        "{text}"
    );
}

#[test]
fn the_corpus_run_dumps_with_node_and_compares_native_stages_only() {
    let args = xtask::pilot::node_dump_args(Path::new("/s/dump"));
    let text: Vec<_> = args.iter().map(|a| a.to_string_lossy()).collect();
    assert_eq!(
        text,
        ["scripts/oracle/corpus.mjs", "--dump", "--out", "/s/dump"]
    );
    let opts = xtask::pilot::compare_options("toml".to_string());
    assert_eq!(
        opts.stages.unwrap(),
        ["link", "bytes", "size-report", "error"]
    );
    assert_eq!(opts.exclude, ["*/web", "*/release/*.wasm"]);
    assert_eq!(opts.divergences, "toml");
}
