//! Port of packages/compiler/src/fold/facts.mjs:1-367
//!
//! The fact sheet's keys: what a build knows about the machine it is for. A
//! fact is a number, a flag, or a list of names; the compiler owns the keys
//! and their types, the machine packages own the values. `when` says when a
//! fact is settled (`build`: fixed by the build; `run`: hardware the program
//! may or may not find at run time). `program: false` keys are the CLI's, not
//! a program's.
//!
//! Dynamic JS values (a `requires` block, a facts object) are [`Json`]: an
//! object keeps its keys in the order given, and [`Json::stringify`] is
//! `JSON.stringify`.

use std::sync::LazyLock;

pub use crate::json::Json;
use crate::json::{at_least, less};
use indexmap::IndexMap;
use jsnum::object_key_order;
use serde::{Deserialize, Serialize};

/// `Object.entries` order over an object given in insertion order.
fn entries(map: &IndexMap<String, Json>) -> Vec<(&String, &Json)> {
    let keys: Vec<&String> = map.keys().collect();
    object_key_order(&keys)
        .into_iter()
        .map(|i| (keys[i], &map[keys[i]]))
        .collect()
}

/// `'count'|'flag'` in the JS typedef, plus `'list'` for `input.controls`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FactType {
    Count,
    Flag,
    List,
}

/// `'build'|'run'`: see the module doc.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum When {
    Build,
    Run,
}

/// One entry of the fact table. `kinds` is the extra `list` carries for
/// `input.controls`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Fact {
    #[serde(rename = "type")]
    pub kind: FactType,
    pub when: When,
    pub program: bool,
    pub doc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<&'static [ControllerKind]>,
}

fn count(when: When, doc: &'static str, program: bool) -> Fact {
    Fact {
        kind: FactType::Count,
        when,
        program,
        doc,
        kinds: None,
    }
}

fn flag(when: When, doc: &'static str, program: bool) -> Fact {
    Fact {
        kind: FactType::Flag,
        when,
        program,
        doc,
        kinds: None,
    }
}

fn list(when: When, doc: &'static str) -> Fact {
    Fact {
        kind: FactType::List,
        when,
        program: false,
        doc,
        kinds: Some(&CONTROLLER_KINDS),
    }
}

/// 8BitScript's logical controls: the twelve digital ones first, then the
/// six analogue ones.
pub const LOGICAL_CONTROLS: [&str; 18] = [
    "up",
    "down",
    "left",
    "right",
    "a",
    "b",
    "x",
    "y",
    "l",
    "r",
    "start",
    "select",
    "leftStickX",
    "leftStickY",
    "rightStickX",
    "rightStickY",
    "lt",
    "rt",
];

/// A controller shape that has a name, and the exact set of controls it is.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ControllerKind {
    pub kind: &'static str,
    pub controls: &'static [&'static str],
}

/// The controller shapes that have a name. A kind is derived from a list of
/// controls by exact set equality, never declared.
pub static CONTROLLER_KINDS: [ControllerKind; 4] = [
    ControllerKind {
        kind: "atari-stick",
        controls: &["up", "down", "left", "right", "a"],
    },
    ControllerKind {
        kind: "nes-pad",
        controls: &["up", "down", "left", "right", "a", "b", "select", "start"],
    },
    ControllerKind {
        kind: "snes-pad",
        controls: &[
            "up", "down", "left", "right", "a", "b", "x", "y", "l", "r", "start", "select",
        ],
    },
    ControllerKind {
        kind: "xbox-style",
        controls: &LOGICAL_CONTROLS,
    },
];

/// The name for a list of controls, or `None` for a shape with no name.
/// Order and repetition do not matter.
#[must_use]
pub fn controller_kind(controls: &Json) -> Option<&'static str> {
    let Json::Array(items) = controls else {
        return None;
    };
    if items.is_empty() {
        return None;
    }
    let mut have: Vec<&Json> = Vec::new();
    for item in items {
        if !have.contains(&item) {
            have.push(item);
        }
    }
    CONTROLLER_KINDS
        .iter()
        .find(|k| {
            k.controls.len() == have.len()
                && k.controls
                    .iter()
                    .all(|c| have.iter().any(|h| matches!(h, Json::String(s) if s == c)))
        })
        .map(|k| k.kind)
}

/// Every fact key, in the order the sheet lists them.
pub static FACTS: LazyLock<IndexMap<&'static str, Fact>> = LazyLock::new(|| {
    IndexMap::from([
        (
            "video.columns",
            count(
                When::Build,
                "Cells across the text grid the portable text draws on.",
                true,
            ),
        ),
        (
            "video.rows",
            count(When::Build, "Cells down the text grid.", true),
        ),
        (
            "video.cellWidth",
            count(When::Build, "Pixels across one cell.", true),
        ),
        (
            "video.cellHeight",
            count(When::Build, "Pixels down one cell.", true),
        ),
        (
            "video.palette",
            count(When::Build, "Colors the display can show at once.", true),
        ),
        (
            "video.cellColors",
            count(
                When::Build,
                "Colors one cell can hold in the text mode the grid uses.",
                true,
            ),
        ),
        (
            "video.colorPerCell",
            flag(
                When::Build,
                "A program can set one cell's color without changing its neighbors'.",
                true,
            ),
        ),
        (
            "video.glyphs",
            count(
                When::Build,
                "Characters a program can redefine at run time; 0 where the font is fixed.",
                true,
            ),
        ),
        (
            "video.blockWidth",
            count(
                When::Build,
                "Pseudo-pixels across one cell from the fixed font's block glyphs; 0 where there are none.",
                true,
            ),
        ),
        (
            "video.blockHeight",
            count(
                When::Build,
                "Pseudo-pixels down one cell from the block glyphs; 0 where there are none.",
                true,
            ),
        ),
        (
            "video.bitmap",
            flag(When::Build, "A pixel-addressable mode exists.", true),
        ),
        (
            "video.layers",
            count(When::Build, "Independent background layers.", true),
        ),
        (
            "video.scroll",
            flag(When::Build, "Hardware fine scroll exists.", true),
        ),
        (
            "video.raster",
            flag(
                When::Build,
                "The picture can be changed part-way down the screen — a per-scanline raster effect exists.",
                true,
            ),
        ),
        (
            "video.colorBlend",
            flag(
                When::Build,
                "Two of the fixed palette can be shown alternating frames and read, on this display, as a blended shade — @8bitscript/color has a real implementation, not a stub.",
                true,
            ),
        ),
        (
            "video.sprites",
            count(
                When::Build,
                "Hardware sprites in total; 0 where moving objects are drawn in software.",
                true,
            ),
        ),
        (
            "video.spritesPerLine",
            count(
                When::Build,
                "Hardware sprites one scanline can show — the number that decides whether a scene works.",
                true,
            ),
        ),
        (
            "video.spriteWidth",
            count(
                When::Build,
                "Pixels across the largest hardware sprite.",
                true,
            ),
        ),
        (
            "video.spriteHeight",
            count(
                When::Build,
                "Pixels down the largest hardware sprite.",
                true,
            ),
        ),
        (
            "video.spriteColors",
            count(
                When::Build,
                "Colors one hardware sprite can hold, not counting transparent.",
                true,
            ),
        ),
        (
            "video.spriteKib",
            count(
                When::Build,
                "KiB of the shared pool every sprite picture of the build is drawn from; 0 where the build models no such pool. KiB for the same reason as memory.bankedKib.",
                true,
            ),
        ),
        (
            "video.frameRate",
            count(
                When::Build,
                "Display refreshes a second, for timing a screenshot; not on the sheet, the machine may be NTSC or PAL at run time.",
                false,
            ),
        ),
        (
            "video.characterSetSwapped",
            flag(
                When::Build,
                "The two-set character ROM's upper/lower-case halves are the other way round from every other model (measured against the real ROM: the original PET 2001's 901447-08 only) — packages/pet/src/text.8bs's own asciiToScreenCode reads this, not a program.",
                false,
            ),
        ),
        (
            "video.bootsInTextMode",
            flag(
                When::Build,
                "The ROM leaves the machine in its mixed-case text character set at power-on rather than the upper-case/graphics one (the PET's business-keyboard editor ROMs do; the 3032 and 4032 do not). A target's text package draws in the text set, the only one holding both cases of the alphabet, so this decides only whether it has to select that set first: a machine already there is left alone and pays nothing — packages/pet/src/text.8bs reads it, not a program.",
                false,
            ),
        ),
        (
            "memory.chrget",
            count(
                When::Build,
                "Zero-page address of BASIC's CHRGET routine (24 bytes): $70 on BASIC 2/4, $C2 on BASIC 1 (the original PET 2001). The native backend leaves that window alone so a SYS return still has an interpreter. Not on the program sheet.",
                false,
            ),
        ),
        (
            "audio.voices",
            count(
                When::Build,
                "Voices the sound hardware plays at once.",
                true,
            ),
        ),
        (
            "audio.noise",
            flag(When::Build, "A noise voice exists.", true),
        ),
        (
            "audio.envelope",
            flag(
                When::Build,
                "Hardware volume envelopes (ADSR or similar) exist.",
                true,
            ),
        ),
        (
            "audio.filter",
            flag(When::Build, "A hardware filter exists.", true),
        ),
        (
            "audio.pcm",
            flag(When::Build, "Sample playback exists.", true),
        ),
        (
            "audio.volume",
            flag(When::Build, "Each voice has its own volume.", true),
        ),
        (
            "audio.entropy",
            flag(When::Build, "A hardware random source exists.", true),
        ),
        (
            "input.keyboard",
            flag(When::Build, "A keyboard the program can read.", true),
        ),
        (
            "input.joysticks",
            count(When::Build, "Joystick ports.", true),
        ),
        (
            "input.pads",
            count(When::Build, "Console-style controller ports.", true),
        ),
        (
            "input.controls",
            list(
                When::Build,
                "The logical controls the controller on this machine's ports actually carries — four directions and a fire button for an Atari-standard stick, eight bits for an NES pad, twelve for a SNES one. What the port *counts* cannot say: `input.pads: 2` is not projectable without knowing which pad. The kind (`atari-stick`, `nes-pad`, `snes-pad`, `xbox-style`) is derived from this list by controllerKind(), never declared beside it. A list, so it folds into nothing and is not on a program's sheet: the editor's Controller Setup panel and `8bs targets --json` read it, a program asks its input layer.",
            ),
        ),
        (
            "input.mouse",
            flag(
                When::Run,
                "A mouse this build may use; whether one is plugged in is the capability's answer at run time.",
                true,
            ),
        ),
        (
            "input.paddles",
            flag(
                When::Run,
                "Paddles this build may use; whether they are plugged in is the capability's answer at run time.",
                true,
            ),
        ),
        (
            "storage.save",
            flag(
                When::Build,
                "Somewhere this build can persist bytes: disk, SD card, battery RAM.",
                true,
            ),
        ),
        (
            "storage.kib",
            count(
                When::Build,
                "KiB that place holds — the medium's usable capacity, not its image size; 0 where there is nowhere to save. Where the route is a host directory or a card whose size is the owner's, it is the smallest real medium that route stands for, so a program that fits the fact fits the hardware. KiB rather than bytes because a disk does not fit in the 16 bits an 8-bit machine counts in — the same reason memory.bankedKib is KiB.",
                true,
            ),
        ),
        (
            "memory.ram",
            count(
                When::Build,
                "Bytes of RAM the program is linked to use, code and data together.",
                true,
            ),
        ),
        (
            "memory.banked",
            flag(
                When::Run,
                "RAM beyond the CPU's window this build may use (a REU, an MMU bank, VERA-style banks); whether it is there is the capability's answer at run time.",
                true,
            ),
        ),
        (
            "memory.bankedKib",
            count(
                When::Run,
                "KiB of that banked RAM the build was fitted with.",
                true,
            ),
        ),
    ])
});

/// The keys a program's sheet carries, in order.
pub static PROGRAM_FACTS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    FACTS
        .iter()
        .filter(|(_, fact)| fact.program)
        .map(|(key, _)| *key)
        .collect()
});

/// The name `@8bitscript/system` gives a key: `video.spritesPerLine` is
/// `Video.SPRITES_PER_LINE`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FactConstName {
    pub namespace: String,
    pub name: String,
}

/// `factConstName(key)`. A key with an empty first word makes JS throw on
/// `group[0].toUpperCase()`; here the namespace is empty.
#[must_use]
pub fn fact_const_name(key: &str) -> FactConstName {
    let mut parts = key.split('.');
    let group = parts.next().unwrap_or("");
    let member = parts.collect::<Vec<&str>>().join(".");
    let mut chars = group.chars();
    let namespace = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    };
    // /([a-z])([A-Z])/g -> '$1_$2'
    let chars: Vec<char> = member.chars().collect();
    let mut snake = String::new();
    let mut i = 0;
    while i < chars.len() {
        if i + 1 < chars.len() && chars[i].is_ascii_lowercase() && chars[i + 1].is_ascii_uppercase()
        {
            snake.push(chars[i]);
            snake.push('_');
            snake.push(chars[i + 1]);
            i += 2;
        } else {
            snake.push(chars[i]);
            i += 1;
        }
    }
    FactConstName {
        namespace,
        name: snake.to_uppercase(),
    }
}

/// The value a fact has when nothing set it: 0, false, or an empty list.
#[must_use]
pub fn fact_placeholder(key: &str) -> Json {
    match FACTS.get(key).map(|f| f.kind) {
        Some(FactType::Flag) => Json::Bool(false),
        Some(FactType::List) => Json::Array(Vec::new()),
        _ => Json::Number(0.0),
    }
}

/// Check a `requires` block against the table: what a program needs of the
/// machine it is built for, before the machine is known. Returns the
/// problems, in words; empty when clean.
#[must_use]
pub fn requires_problems(requires: Option<&IndexMap<String, Json>>) -> Vec<String> {
    let mut problems = Vec::new();
    let empty = IndexMap::new();
    for (key, need) in entries(requires.unwrap_or(&empty)) {
        let Some(fact) = FACTS.get(key.as_str()) else {
            problems.push(format!(
                "'{key}' is not a fact — the keys are {}",
                PROGRAM_FACTS.join(", ")
            ));
            continue;
        };
        if !fact.program {
            problems.push(format!(
                "'{key}' is not on a program's sheet, so a program cannot require it"
            ));
            continue;
        }
        if fact.when == When::Run {
            problems.push(format!(
                "'{key}' is settled on the machine, not by the build, so it cannot be required — ask the capability at run time instead"
            ));
            continue;
        }
        if fact.kind == FactType::Flag && *need != Json::Bool(true) {
            problems.push(format!(
                "'{key}' is a flag: require it with true, or leave it out — not {}",
                need.stringify()
            ));
        }
        if fact.kind == FactType::Count
            && !(need.is_integer() && matches!(need, Json::Number(n) if *n > 0.0))
        {
            problems.push(format!(
                "'{key}' is a count: require a whole number above zero, not {}",
                need.stringify()
            ));
        }
    }
    problems
}

/// One requirement a build's facts do not meet.
#[derive(Debug, Clone, PartialEq)]
pub struct Unmet {
    pub key: String,
    pub need: Json,
    pub have: Json,
}

impl Unmet {
    /// The JS object `{ key, need, have }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        Json::Object(IndexMap::from([
            ("key".to_string(), Json::String(self.key.clone())),
            ("need".to_string(), self.need.clone()),
            ("have".to_string(), self.have.clone()),
        ]))
    }
}

/// `facts?.[key] ?? factPlaceholder(key)`.
fn fact_or_placeholder(facts: Option<&IndexMap<String, Json>>, key: &str) -> Json {
    match facts.and_then(|f| f.get(key)) {
        None | Some(Json::Null) => fact_placeholder(key),
        Some(v) => v.clone(),
    }
}

/// What a `requires` block asks for that a build's facts do not give.
#[must_use]
pub fn unmet_requirements(
    requires: Option<&IndexMap<String, Json>>,
    facts: Option<&IndexMap<String, Json>>,
) -> Vec<Unmet> {
    let mut unmet = Vec::new();
    let empty = IndexMap::new();
    for (key, need) in entries(requires.unwrap_or(&empty)) {
        let have = fact_or_placeholder(facts, key);
        let met = if FACTS.get(key.as_str()).map(|f| f.kind) == Some(FactType::Flag) {
            have == Json::Bool(true)
        } else {
            at_least(&have, need)
        };
        if !met {
            unmet.push(Unmet {
                key: key.clone(),
                need: need.clone(),
                have,
            });
        }
    }
    unmet
}

/// A fact where one build's sheet is short of the baseline's.
#[derive(Debug, Clone, PartialEq)]
pub struct Short {
    pub key: String,
    pub baseline: Json,
    pub have: Json,
}

impl Short {
    /// The JS object `{ key, baseline, have }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        Json::Object(IndexMap::from([
            ("key".to_string(), Json::String(self.key.clone())),
            ("baseline".to_string(), self.baseline.clone()),
            ("have".to_string(), self.have.clone()),
        ]))
    }
}

/// Where one build's sheet is short of the baseline's: a flag the baseline
/// has and this build does not; a count the baseline has more of.
#[must_use]
pub fn short_of_baseline(
    baseline: Option<&IndexMap<String, Json>>,
    facts: Option<&IndexMap<String, Json>>,
) -> Vec<Short> {
    let mut short = Vec::new();
    for (key, fact) in FACTS.iter() {
        if !fact.program || fact.when == When::Run || fact.kind == FactType::List {
            continue;
        }
        let has = fact_or_placeholder(baseline, key);
        let have = fact_or_placeholder(facts, key);
        let behind = if fact.kind == FactType::Flag {
            has == Json::Bool(true) && have != Json::Bool(true)
        } else {
            less(&have, &has)
        };
        if behind {
            short.push(Short {
                key: (*key).to_string(),
                baseline: has,
                have,
            });
        }
    }
    short
}

/// Check one facts object against the table: every key known, every value of
/// its key's type. Returns the problems, in words; empty when clean.
#[must_use]
pub fn fact_problems(facts: Option<&IndexMap<String, Json>>) -> Vec<String> {
    let mut problems = Vec::new();
    let empty = IndexMap::new();
    for (key, value) in entries(facts.unwrap_or(&empty)) {
        let Some(fact) = FACTS.get(key.as_str()) else {
            let keys: Vec<&str> = FACTS.keys().copied().collect();
            problems.push(format!(
                "'{key}' is not a fact — the keys are {}",
                keys.join(", ")
            ));
            continue;
        };
        if fact.kind == FactType::Flag && !matches!(value, Json::Bool(_)) {
            problems.push(format!(
                "'{key}' is a flag: true or false, not {}",
                value.stringify()
            ));
        }
        if fact.kind == FactType::Count
            && !(value.is_integer() && matches!(value, Json::Number(n) if *n >= 0.0))
        {
            problems.push(format!(
                "'{key}' is a count: a whole number, not {}",
                value.stringify()
            ));
        }
        if fact.kind == FactType::List {
            let Json::Array(names) = value else {
                problems.push(format!(
                    "'{key}' is a list of control names: an array, not {}",
                    value.stringify()
                ));
                continue;
            };
            for name in names {
                let known =
                    matches!(name, Json::String(s) if LOGICAL_CONTROLS.contains(&s.as_str()));
                if !known {
                    problems.push(format!(
                        "'{key}' holds {}, which is not a control — the controls are {}",
                        name.stringify(),
                        LOGICAL_CONTROLS.join(", ")
                    ));
                }
            }
        }
    }
    problems
}
