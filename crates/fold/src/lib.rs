//! Port of packages/compiler/src/fold/index.mjs:1-667
//!
//! The compile-time folds: `#frames(...)`, the duration builtin, `#system()`,
//! the machine a build is for, `#fact(...)`, `#locale(...)`, `#package(...)`
//! and `#define(...)`. `fold_compile_time` rewrites a program's calls in
//! place into plain literals (R1.7: the node keeps its span and takes a new
//! kind) and reports the misuse it finds.
//!
//! Every duration step is exact rational arithmetic (R2.9), never a float.

pub mod facts;
pub mod json;
pub mod package;
pub mod tap;

use diagnostics::{Severity, codes, diagnostic, is_locale_name};
use indexmap::IndexMap;
use jsnum::number_to_string;
use num_bigint::BigInt;
use num_rational::BigRational;
use num_traits::{FromPrimitive, One, ToPrimitive, Zero};
use serde::Serialize;
use std::collections::HashSet;
use syntax::{Node, NodeId, NodeKind, children_mut};

use facts::{FACTS, FactType, Json, fact_placeholder};
use package::{NearestPackage, PACKAGE_FIELDS, nearest_package};

/// What a duration literal can be measured in (`DURATION_UNITS`): the unit's
/// word and the exact seconds it makes of a rational.
/// A unit's name and its conversion to seconds.
pub type DurationUnit = (&'static str, fn(BigRational) -> BigRational);

pub const DURATION_UNITS: [DurationUnit; 1] = [("seconds", to_seconds)];

fn to_seconds(value: BigRational) -> BigRational {
    value
}

/// One clock a duration can be counted out in (`DURATION_CLOCKS`).
pub struct Clock {
    /// The compile-time function name, without the `#`.
    pub name: &'static str,
    /// Exact seconds to exact ticks.
    pub ticks: fn(BigRational, &BigInt) -> BigRational,
    /// One tick, for diagnostics.
    pub tick: &'static str,
    /// Names the rate the fold happened at.
    pub describe: fn(f64) -> String,
}

/// The clocks a duration can be counted out in: one per builtin function.
pub const DURATION_CLOCKS: [Clock; 1] = [Clock {
    name: "frames",
    ticks: |seconds, frame_rate| seconds * BigRational::from_integer(frame_rate.clone()),
    tick: "frame",
    describe: |frame_rate| {
        format!(
            "this project's frameRate ({})",
            number_to_string(frame_rate)
        )
    },
}];

/// The machines `#system()` can name, each with its number.
pub const SYSTEMS: [(&str, f64); 32] = [
    ("web", 0.0),
    ("vic20", 1.0),
    ("c64", 2.0),
    ("pet", 3.0),
    ("c128", 4.0),
    ("atari8", 5.0),
    ("nes", 6.0),
    ("cx16", 7.0),
    ("mega65", 8.0),
    ("plus4", 9.0),
    ("oric", 10.0),
    ("apple2", 11.0),
    ("bbc", 12.0),
    ("atari5200", 13.0),
    ("lynx", 14.0),
    ("pce", 15.0),
    ("supervision", 16.0),
    ("atari2600", 17.0),
    ("atari7800", 18.0),
    ("gb", 19.0),
    ("gbc", 20.0),
    ("sms", 21.0),
    ("gamegear", 22.0),
    ("sg1000", 23.0),
    ("msx", 24.0),
    ("coleco", 25.0),
    ("spectrum", 26.0),
    ("cpc", 27.0),
    ("coco", 28.0),
    ("vectrex", 29.0),
    ("odyssey2", 30.0),
    ("channelf", 31.0),
];

/// The `#name` a compile-time call names, or `None` for anything else.
fn compile_time_call_name(n: &Node) -> Option<String> {
    let NodeKind::CallExpression { callee, .. } = &n.kind else {
        return None;
    };
    match &callee.kind {
        NodeKind::Identifier {
            name,
            compile_time: Some(true),
            ..
        } => Some(name.clone()),
        _ => None,
    }
}

fn clock_named(name: &str) -> Option<&'static Clock> {
    DURATION_CLOCKS.iter().find(|clock| clock.name == name)
}

fn known_compile_time() -> String {
    let mut parts: Vec<String> = DURATION_CLOCKS
        .iter()
        .map(|clock| format!("#{}(...)", clock.name))
        .collect();
    parts.extend(
        [
            "#system()",
            "#fact(...)",
            "#locale(...)",
            "#package(...)",
            "#define(...)",
        ]
        .map(String::from),
    );
    parts.join(", ")
}

fn builtin(name: &str) -> bool {
    clock_named(name).is_some()
        || matches!(name, "system" | "fact" | "locale" | "package" | "define")
}

/// Round a fraction to the nearest integer, ties rounding up. The
/// denominator is positive.
fn round_fraction(fraction: &BigRational) -> (BigInt, bool) {
    let quotient = fraction.numer() / fraction.denom();
    let remainder = fraction.numer() % fraction.denom();
    if remainder.is_zero() {
        return (quotient, true);
    }
    let up = &remainder * BigInt::from(2) >= *fraction.denom();
    (
        if up {
            quotient + BigInt::one()
        } else {
            quotient
        },
        false,
    )
}

/// What a fold writes in place of a call.
enum Folded {
    Integer(f64),
    Boolean(bool),
    Text(String),
}

/// A folded-away call becomes a literal, keeping its span (`start`/`length`)
/// so a later diagnostic underlines the whole call. The old callee and
/// arguments are gone with the old variant, so the walk below never revisits
/// them.
fn replace_with(n: &mut Node, value: Folded, raw: Option<String>) {
    n.kind = match (value, raw) {
        (Folded::Integer(value), raw) => NodeKind::IntegerLiteral {
            value,
            raw: raw.unwrap_or_default(),
            radix: 10,
        },
        (Folded::Boolean(value), raw) => NodeKind::BooleanLiteral { value, raw },
        (Folded::Text(value), raw) => NodeKind::StringLiteral {
            value,
            unterminated: None,
            raw,
        },
    };
}

fn replace_with_tick_count(n: &mut Node, name: &str, value: f64) {
    let raw = if name == "system" {
        "#system()".to_string()
    } else {
        format!("#{name}(...)")
    };
    replace_with(n, Folded::Integer(value), Some(raw));
}

/// The same, for a fact: a count becomes an IntegerLiteral, a flag a
/// BooleanLiteral.
fn replace_with_fact(n: &mut Node, key: &str, value: &Json) {
    let raw = Some(format!("#fact({key})"));
    match value {
        Json::Bool(flag) => replace_with(n, Folded::Boolean(*flag), raw),
        // A fact that is neither a flag nor a count cannot reach here: a
        // list fact is refused before, and a sheet holds numbers and flags.
        Json::Number(count) => replace_with(n, Folded::Integer(*count), raw),
        _ => replace_with(n, Folded::Integer(0.0), raw),
    }
}

fn example_calls(name: &str) -> String {
    match name {
        "system" => "#system()".to_string(),
        "fact" => "#fact(video.columns) or #fact(memory.ram)".to_string(),
        "locale" => "#locale(\"de\") or #locale(\"pt-br\")".to_string(),
        "package" => "#package(\"version\") or #package(\"name\")".to_string(),
        "define" => "#define(\"SEED\", 10), #define(\"FORCE_BONUS\", false) or #define(\"THEME\", \"classic\")".to_string(),
        _ => format!("#{name}(1, seconds) or #{name}(0.5, seconds)"),
    }
}

/// The dotted key a `#fact(...)` argument spells, or `None` for any other
/// shape.
fn fact_key_of(argument: Option<&Node>) -> Option<String> {
    let argument = argument?;
    match &argument.kind {
        NodeKind::Identifier {
            name, compile_time, ..
        } => {
            if *compile_time == Some(true) {
                None
            } else {
                Some(name.clone())
            }
        }
        NodeKind::MemberExpression { object, property } => {
            let NodeKind::Identifier { name, .. } = &property.kind else {
                return None;
            };
            let head = fact_key_of(Some(object))?;
            Some(format!("{head}.{name}"))
        }
        _ => None,
    }
}

/// The value of a `#define` and the kind it makes.
#[derive(Debug, Clone, PartialEq)]
pub enum DefineValue {
    Int(f64),
    Bool(bool),
    Str(String),
}

impl DefineValue {
    fn kind(&self) -> &'static str {
        match self {
            DefineValue::Bool(_) => "bool",
            DefineValue::Int(_) => "int",
            DefineValue::Str(_) => "string",
        }
    }

    /// `JSON.stringify(value)`.
    fn stringify(&self) -> String {
        match self {
            DefineValue::Bool(flag) => flag.to_string(),
            DefineValue::Int(n) => number_to_string(*n),
            DefineValue::Str(s) => Json::String(s.clone()).stringify(),
        }
    }

    /// A value handed in through `defines`. Only numbers, flags and strings
    /// come from a config or the command line; any other JSON counts as a
    /// string, as `defineKind` does, holding its JSON text.
    fn from_json(given: &Json) -> DefineValue {
        match given {
            Json::Bool(flag) => DefineValue::Bool(*flag),
            Json::Number(n) => DefineValue::Int(*n),
            Json::String(s) => DefineValue::Str(s.clone()),
            other => DefineValue::Str(other.stringify()),
        }
    }
}

/// The kind of a value a define can hold (`defineKind`).
#[must_use]
pub fn define_kind(value: &Json) -> &'static str {
    DefineValue::from_json(value).kind()
}

/// One `#define` read: name, kind, default, where (`defineSites`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DefineSite {
    pub name: String,
    pub kind: &'static str,
    #[serde(rename = "default")]
    pub default_value: DefineValue,
    pub file: String,
    pub start: u32,
}

impl Serialize for DefineValue {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            DefineValue::Int(n) => serializer.serialize_f64(*n),
            DefineValue::Bool(flag) => serializer.serialize_bool(*flag),
            DefineValue::Str(s) => serializer.serialize_str(s),
        }
    }
}

/// What a `#define` name looks like: `/^[A-Z][A-Z0-9_]*$/`.
#[must_use]
pub fn is_define_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_uppercase())
        && bytes.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

fn kind_words(kind: &str) -> &'static str {
    match kind {
        "int" => "a number",
        "bool" => "true or false",
        _ => "a string",
    }
}

/// `Number.isSafeInteger`.
fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

/// The options of `foldCompileTime`.
#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    /// The project's logical frame rate (default 60).
    pub frame_rate: f64,
    /// The target being built for; `None` when a file is checked.
    pub machine: Option<String>,
    /// The build's merged hardware facts.
    pub facts: Option<IndexMap<String, Json>>,
    /// The build's locale, if any.
    pub locale: Option<String>,
    /// The values the build was handed, by name.
    pub defines: Option<IndexMap<String, Json>>,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            frame_rate: 60.0,
            machine: None,
            facts: None,
            locale: None,
            defines: None,
        }
    }
}

/// What every fold reads and writes.
struct Fold<'a> {
    file: &'a str,
    options: &'a Options,
    sites: Option<&'a mut Vec<DefineSite>>,
    diagnostics: Vec<diagnostics::Diagnostic>,
    /// The ids of the nodes this fold rewrote. A shared JS node is one object in two places, so
    /// its second visit finds it already rewritten and reports nothing; the clone here keeps its
    /// id, and a repeat visit rewrites the same way but drops what it reported.
    folded: HashSet<NodeId>,
}

impl Fold<'_> {
    fn report(&mut self, code: &str, message: String, start: u32, length: u32) {
        self.diagnostics.push(diagnostic(
            code,
            message,
            self.file,
            start,
            length,
            Severity::Error,
        ));
    }

    /// `#fact(key)`: one fact about the machine this build is for.
    fn fold_fact_call(&mut self, n: &mut Node) {
        let args: &[Node] = match &n.kind {
            NodeKind::CallExpression { args, .. } => args,
            _ => &[],
        };
        let key = if args.len() == 1 {
            fact_key_of(args.first())
        } else {
            None
        };
        let known = key.as_deref().filter(|key| FACTS.contains_key(*key));
        let Some(key) = known else {
            let message = match &key {
                None => format!(
                    "#fact(...) takes one fact key, written as words — {}",
                    example_calls("fact")
                ),
                Some(key) => format!(
                    "'{key}' is not a fact — the keys are {}",
                    FACTS.keys().copied().collect::<Vec<_>>().join(", ")
                ),
            };
            let key = key.unwrap_or_else(|| "?".to_string());
            self.report(codes::UNKNOWN_FACT, message, n.start, n.length);
            replace_with_fact(n, &key, &Json::Number(0.0));
            return;
        };
        let key = key.to_string();
        // A list fact is a shape, not a quantity: there is no literal to fold
        // it into, so it is refused by name before the machine is looked at.
        if FACTS.get(key.as_str()).map(|fact| fact.kind) == Some(FactType::List) {
            self.report(
                codes::UNKNOWN_FACT,
                format!(
                    "'{key}' is a list of control names, not a number or a flag, so #fact() cannot fold it into a constant — the editor and `8bs targets --json` read it, a program asks its input layer"
                ),
                n.start,
                n.length,
            );
            replace_with_fact(n, &key, &Json::Number(0.0));
            return;
        }
        let Some(machine) = &self.options.machine else {
            replace_with_fact(n, &key, &fact_placeholder(&key));
            return;
        };
        let Some(facts) = &self.options.facts else {
            let message = format!(
                "#fact({key}) needs this build's hardware facts, and the {machine} build was given none — a build resolves its hardware first (8bs build does; link() takes 'facts')"
            );
            self.report(codes::NO_HARDWARE_FACTS, message, n.start, n.length);
            replace_with_fact(n, &key, &fact_placeholder(&key));
            return;
        };
        let value = facts
            .get(&key)
            .cloned()
            .unwrap_or_else(|| fact_placeholder(&key));
        replace_with_fact(n, &key, &value);
    }

    /// `#locale("de")`: whether this build's locale is the one named.
    fn fold_locale_call(&mut self, n: &mut Node) {
        let name = match &n.kind {
            NodeKind::CallExpression { args, .. } if args.len() == 1 => match &args[0].kind {
                NodeKind::StringLiteral { value, .. } => Some(value.clone()),
                _ => None,
            },
            _ => None,
        };
        let valid = name.as_deref().filter(|name| is_locale_name(name));
        let Some(name) = valid else {
            let message = match &name {
                None => format!(
                    "#locale(...) takes one locale name in quotes — {}",
                    example_calls("locale")
                ),
                Some(name) => format!(
                    "'{name}' is not a locale name: two to eight lower-case letters, with an optional -region (^[a-z]{{2,8}}(?:-[a-z0-9]{{2,8}})?$), and not a machine's name"
                ),
            };
            let name = name.unwrap_or_else(|| "?".to_string());
            self.report(codes::INVALID_LOCALE, message, n.start, n.length);
            replace_with_locale(n, &name, false);
            return;
        };
        let name = name.to_string();
        let same = self.options.locale.as_deref() == Some(name.as_str());
        replace_with_locale(n, &name, same);
    }

    /// `#package("version")`: a field of the program's own package.json.
    fn fold_package_call(&mut self, n: &mut Node) {
        let field = match &n.kind {
            NodeKind::CallExpression { args, .. } if args.len() == 1 => match &args[0].kind {
                NodeKind::StringLiteral { value, .. } => Some(value.clone()),
                _ => None,
            },
            _ => None,
        };
        let valid = field
            .as_deref()
            .filter(|field| PACKAGE_FIELDS.contains(field));
        let Some(field) = valid else {
            let message = match &field {
                None => format!(
                    "#package(...) takes one field name in quotes — {}",
                    example_calls("package")
                ),
                Some(field) => format!(
                    "'{field}' is not a package.json field a program can read — the fields are {}",
                    PACKAGE_FIELDS
                        .iter()
                        .map(|f| format!("\"{f}\""))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            };
            self.report(codes::INVALID_PACKAGE_FIELD, message, n.start, n.length);
            replace_with_string(n, field.as_deref().unwrap_or("?"), String::new());
            return;
        };
        let field = field.to_string();
        if self.file.is_empty() || self.file == "<unknown>" {
            replace_with_string(n, &field, String::new());
            return;
        }
        let dir = dirname(self.file);
        let quoted = Json::String(field.clone()).stringify();
        let found = nearest_package(&dir);
        let (problem, value) = match &found {
            None => (
                Some(format!(
                    "no package.json above {dir} — #package({quoted}) reads the nearest one"
                )),
                None,
            ),
            Some(NearestPackage::Failed { path, error }) if !error.is_empty() => {
                (Some(format!("{path} is not valid JSON: {error}")), None)
            }
            Some(NearestPackage::Failed { .. }) => (None, None),
            Some(NearestPackage::Found { path, json }) => match json {
                Json::Object(map) => match map.get(&field) {
                    Some(Json::String(value)) => (None, Some(value.clone())),
                    _ => (
                        Some(format!(
                            "{path} has no \"{field}\" — #package({quoted}) reads that field, as a string"
                        )),
                        None,
                    ),
                },
                _ => (
                    Some(format!(
                        "{path} has no \"{field}\" — #package({quoted}) reads that field, as a string"
                    )),
                    None,
                ),
            },
        };
        if let Some(problem) = problem {
            self.report(codes::PACKAGE_NOT_FOUND, problem, n.start, n.length);
            replace_with_string(n, &field, String::new());
            return;
        }
        replace_with_string(n, &field, value.unwrap_or_default());
    }

    /// `#define("SEED", 10)`: a value the build is handed.
    fn fold_define_call(&mut self, n: &mut Node) {
        let empty: &[Node] = &[];
        let args: &[Node] = match &n.kind {
            NodeKind::CallExpression { args, .. } => args,
            _ => empty,
        };
        let name = match args.first().map(|a| &a.kind) {
            Some(NodeKind::StringLiteral { value, .. }) => Some(value.clone()),
            _ => None,
        };
        let default_value = match args.get(1).map(|a| &a.kind) {
            Some(NodeKind::IntegerLiteral { value, .. })
                if is_safe_integer(*value) && *value >= 0.0 =>
            {
                Some(DefineValue::Int(*value))
            }
            Some(NodeKind::BooleanLiteral { value, .. }) => Some(DefineValue::Bool(*value)),
            Some(NodeKind::StringLiteral { value, .. }) => Some(DefineValue::Str(value.clone())),
            _ => None,
        };
        let well_formed = args.len() == 2
            && name.as_deref().is_some_and(is_define_name)
            && default_value.is_some();
        let (Some(name), Some(default_value), true) = (name.clone(), default_value, well_formed)
        else {
            let message = if args.len() == 2 && name.as_deref().is_some_and(|n| !is_define_name(n))
            {
                format!(
                    "'{}' is not a define name: capital letters, digits and '_', starting with a letter (SEED, START_CREDITS)",
                    name.clone().unwrap_or_default()
                )
            } else {
                format!(
                    "#define(...) takes a name in quotes and a default — {}; the default is a whole number, true or false, or a string, and is required so a build that is handed nothing still has a value",
                    example_calls("define")
                )
            };
            self.report(codes::INVALID_DEFINE, message, n.start, n.length);
            replace_with_define(n, name.as_deref().unwrap_or("?"), &DefineValue::Int(0.0));
            return;
        };
        let kind = default_value.kind();
        let given = self
            .options
            .defines
            .as_ref()
            .and_then(|defines| defines.get(&name))
            .map(|json| (DefineValue::from_json(json), json.stringify()));
        let mut value = default_value.clone();
        if let Some((given, text)) = given {
            if given.kind() == kind {
                value = given;
            } else {
                self.report(
                    codes::DEFINE_TYPE_MISMATCH,
                    format!(
                        "{name} was given {} ({}), but its default, {}, is {}; a define keeps the kind its default has",
                        kind_words(given.kind()),
                        text,
                        default_value.stringify(),
                        kind_words(kind)
                    ),
                    n.start,
                    n.length,
                );
            }
        }
        if let Some(sites) = self.sites.as_deref_mut() {
            let earlier = sites.iter().find(|site| site.name == name).cloned();
            match earlier {
                None => sites.push(DefineSite {
                    name: name.clone(),
                    kind,
                    default_value: default_value.clone(),
                    file: self.file.to_string(),
                    start: n.start,
                }),
                Some(earlier) if earlier.kind != kind || earlier.default_value != default_value => {
                    self.report(
                        codes::DEFINE_CONFLICT,
                        format!(
                            "#define({}, ...) has the default {} here and {} in {}; one name is one value, so give both the same default",
                            Json::String(name.clone()).stringify(),
                            default_value.stringify(),
                            earlier.default_value.stringify(),
                            earlier.file
                        ),
                        n.start,
                        n.length,
                    );
                }
                Some(_) => {}
            }
        }
        replace_with_define(n, &name, &value);
    }

    /// `#system()`: the machine this build is for, as its number in `SYSTEMS`.
    fn fold_system_call(&mut self, n: &mut Node) {
        let has_args = matches!(&n.kind, NodeKind::CallExpression { args, .. } if !args.is_empty());
        if has_args {
            self.report(
                codes::SYSTEM_TAKES_NO_ARGUMENTS,
                "#system() takes no arguments: it is the machine this build is for, and the build already knows which".to_string(),
                n.start,
                n.length,
            );
            replace_with_tick_count(n, "system", 0.0);
            return;
        }
        let Some(machine) = &self.options.machine else {
            replace_with_tick_count(n, "system", 0.0);
            return;
        };
        let number = SYSTEMS
            .iter()
            .find(|(name, _)| name == machine)
            .map(|(_, number)| *number);
        let Some(number) = number else {
            self.report(
                codes::NOT_ON_THIS_TARGET,
                format!(
                    "#system() has no number for '{machine}' — the machines are {}",
                    SYSTEMS
                        .iter()
                        .map(|(name, _)| *name)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                n.start,
                n.length,
            );
            replace_with_tick_count(n, "system", 0.0);
            return;
        };
        replace_with_tick_count(n, "system", number);
    }

    fn fold_clock_call(&mut self, n: &mut Node, clock: &Clock) -> Result<(), String> {
        let name = clock.name;
        let empty: &[Node] = &[];
        let args: &[Node] = match &n.kind {
            NodeKind::CallExpression { args, .. } => args,
            _ => empty,
        };
        let argument = args.first();
        let literal = argument.and_then(|a| match &a.kind {
            NodeKind::IntegerLiteral { value, raw, .. } => Some((*value, 1.0, raw.clone())),
            NodeKind::DecimalLiteral {
                numerator,
                denominator,
                raw,
            } => Some((*numerator, *denominator, raw.clone())),
            _ => None,
        });
        let unit = match args.get(1).map(|a| (&a.kind, a.start, a.length)) {
            Some((NodeKind::Identifier { name, .. }, start, length)) if args.len() == 2 => {
                Some((name.clone(), start, length))
            }
            _ => None,
        };
        let (Some((numerator, denominator, raw)), Some((unit_name, unit_start, unit_length))) =
            (literal, unit)
        else {
            self.report(
                codes::INVALID_DURATION_ARGUMENT,
                format!(
                    "#{name}(...) takes one integer or decimal literal and the unit it is measured in, e.g. {}",
                    example_calls(name)
                ),
                n.start,
                n.length,
            );
            replace_with_tick_count(n, name, 0.0);
            return Ok(());
        };

        let Some((_, to_seconds)) = DURATION_UNITS.iter().find(|(word, _)| *word == unit_name)
        else {
            self.report(
                codes::UNKNOWN_DURATION_UNIT,
                format!(
                    "'{unit_name}' is not a unit #{name}(...) can measure — the units are {}",
                    DURATION_UNITS
                        .iter()
                        .map(|(word, _)| *word)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                unit_start,
                unit_length,
            );
            replace_with_tick_count(n, name, 0.0);
            return Ok(());
        };

        let frame_rate = self.options.frame_rate;
        let numerator = big_int(numerator)?;
        let denominator = big_int(denominator)?;
        if denominator.is_zero() {
            return Err("Division by zero".to_string());
        }
        let seconds = to_seconds(BigRational::new(numerator, denominator));
        let ticks = (clock.ticks)(seconds, &big_int(frame_rate)?);
        let (value, exact) = round_fraction(&ticks);
        let written = format!("#{name}({raw}, {unit_name})");
        let describe = (clock.describe)(frame_rate);

        if value.is_zero() {
            self.report(
                codes::ZERO_DURATION,
                format!(
                    "{written} rounds to 0 {}s at {describe} — every #{name}(...) call must round to at least one {}",
                    clock.tick, clock.tick
                ),
                n.start,
                n.length,
            );
        } else if !exact {
            self.diagnostics.push(diagnostic(
                codes::INEXACT_DURATION,
                format!(
                    "{written} is not exact at {describe} — rounded to {value} {}{}",
                    clock.tick,
                    if value.is_one() { "" } else { "s" }
                ),
                self.file,
                n.start,
                n.length,
                Severity::Warning,
            ));
        }

        replace_with_tick_count(n, name, value.to_f64().unwrap_or(f64::INFINITY));
        Ok(())
    }

    /// One node of the walk: fold a compile-time call, flag a bare `#name` or
    /// a stray decimal literal.
    fn visit(&mut self, n: &mut Node) -> Result<(), String> {
        let rewrites = compile_time_call_name(n).is_some()
            || matches!(n.kind, NodeKind::DecimalLiteral { .. });
        if !rewrites {
            return self.visit_node(n);
        }
        let first = self.folded.insert(n.id);
        let reported = self.diagnostics.len();
        let sites = self.sites.as_ref().map_or(0, |sites| sites.len());
        let outcome = self.visit_node(n);
        if !first {
            self.diagnostics.truncate(reported);
            if let Some(list) = self.sites.as_deref_mut() {
                list.truncate(sites);
            }
        }
        outcome
    }

    fn visit_node(&mut self, n: &mut Node) -> Result<(), String> {
        if let Some(name) = compile_time_call_name(n) {
            match name.as_str() {
                "system" => self.fold_system_call(n),
                "fact" => self.fold_fact_call(n),
                "locale" => self.fold_locale_call(n),
                "package" => self.fold_package_call(n),
                "define" => self.fold_define_call(n),
                _ => match clock_named(&name) {
                    None => {
                        let (start, length) = match &n.kind {
                            NodeKind::CallExpression { callee, .. } => {
                                (callee.start, callee.length)
                            }
                            _ => (n.start, n.length),
                        };
                        self.report(
                            codes::UNKNOWN_COMPILE_TIME_FUNCTION,
                            format!(
                                "'#{name}' is not a function the compiler evaluates — the compile-time functions are {}",
                                known_compile_time()
                            ),
                            start,
                            length,
                        );
                        replace_with_tick_count(n, &name, 0.0);
                    }
                    Some(clock) => self.fold_clock_call(n, clock)?,
                },
            }
            return Ok(());
        }
        match &n.kind {
            NodeKind::Identifier {
                name,
                compile_time: Some(true),
                ..
            } => {
                // Every called one was consumed above, so this one is bare:
                // `#frames` with no argument list.
                let message = if builtin(name) {
                    format!(
                        "'#{name}' is a compile-time function and must be called: {}",
                        example_calls(name)
                    )
                } else {
                    format!(
                        "'#{name}' is not a function the compiler evaluates — the compile-time functions are {}",
                        known_compile_time()
                    )
                };
                self.report(
                    codes::UNKNOWN_COMPILE_TIME_FUNCTION,
                    message,
                    n.start,
                    n.length,
                );
            }
            NodeKind::DecimalLiteral { raw, .. } => {
                let raw = raw.clone();
                self.report(
                    codes::MISPLACED_DECIMAL_LITERAL,
                    format!(
                        "a decimal literal ('{raw}') is only valid as the first argument to {}",
                        known_compile_time()
                    ),
                    n.start,
                    n.length,
                );
                // Replaced, like a folded call is, so nothing downstream
                // reports the same mistake a second time in its own words.
                n.kind = NodeKind::IntegerLiteral {
                    value: 0.0,
                    raw,
                    radix: 10,
                };
            }
            _ => {}
        }
        Ok(())
    }

    /// `walk`: a node, then its children as they are once it has been folded.
    fn walk(&mut self, n: &mut Node) -> Result<(), String> {
        self.visit(n)?;
        for child in children_mut(n) {
            self.walk(child)?;
        }
        Ok(())
    }
}

/// `BigInt(value)` of a number: exact for an integer, a `RangeError` text
/// otherwise.
fn big_int(value: f64) -> Result<BigInt, String> {
    if value.fract() == 0.0
        && let Some(big) = BigInt::from_f64(value)
    {
        return Ok(big);
    }
    Err(format!(
        "The number {} cannot be converted to a BigInt because it is not an integer",
        number_to_string(value)
    ))
}

/// A `#locale(...)` folds to a BooleanLiteral the same way a flag fact does.
fn replace_with_locale(n: &mut Node, name: &str, value: bool) {
    let raw = format!("#locale({})", Json::String(name.to_string()).stringify());
    replace_with(n, Folded::Boolean(value), Some(raw));
}

/// A `#package(...)` folds to a StringLiteral.
fn replace_with_string(n: &mut Node, field: &str, value: String) {
    let raw = format!("#package({})", Json::String(field.to_string()).stringify());
    replace_with(n, Folded::Text(value), Some(raw));
}

/// A `#define(...)` folds to the literal of its value's kind.
fn replace_with_define(n: &mut Node, name: &str, value: &DefineValue) {
    let raw = Some(format!(
        "#define({})",
        Json::String(name.to_string()).stringify()
    ));
    match value {
        DefineValue::Bool(flag) => replace_with(n, Folded::Boolean(*flag), raw),
        DefineValue::Int(count) => replace_with(n, Folded::Integer(*count), raw),
        DefineValue::Str(text) => replace_with(n, Folded::Text(text.clone()), raw),
    }
}

/// `path.dirname` for the posix paths a file name is.
fn dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return if path.is_empty() { "." } else { "/" }.to_string();
    }
    match trimmed.rfind('/') {
        None => ".".to_string(),
        Some(at) => {
            let head = trimmed[..at].trim_end_matches('/');
            if head.is_empty() { "/" } else { head }.to_string()
        }
    }
}

/// Fold every compile-time call in `ast` into a plain literal, mutating the
/// tree in place, and flag any decimal literal found outside a valid clock
/// call argument, any `#name` the compiler does not evaluate, and any
/// `#frames` or `#system` that is not called.
///
/// `file` is `<unknown>` when none is given. `define_sites`, when given,
/// collects one site per `#define` name read. A JS exception (a frame rate
/// that is not an integer) is the `Err` text.
///
/// # Errors
///
/// The `RangeError` text JS throws when `BigInt` is given a number that is
/// not an integer.
pub fn fold_compile_time(
    ast: Option<&mut Node>,
    file: &str,
    options: &Options,
    define_sites: Option<&mut Vec<DefineSite>>,
) -> Result<Vec<diagnostics::Diagnostic>, String> {
    let mut fold = Fold {
        file,
        options,
        sites: define_sites,
        diagnostics: Vec::new(),
        folded: HashSet::new(),
    };
    if let Some(ast) = ast {
        fold.walk(ast)?;
    }
    Ok(fold.diagnostics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirname_is_posix() {
        assert_eq!(dirname("a/b/c.8bs"), "a/b");
        assert_eq!(dirname("c.8bs"), ".");
        assert_eq!(dirname("/c.8bs"), "/");
        assert_eq!(dirname("/a//b/"), "/a");
        assert_eq!(dirname(""), ".");
        assert_eq!(dirname("/"), "/");
    }

    #[test]
    fn define_names_are_upper_snake() {
        assert!(is_define_name("SEED_2"));
        assert!(!is_define_name("seed"));
        assert!(!is_define_name("1A"));
        assert!(!is_define_name(""));
    }

    #[test]
    fn big_int_rejects_what_bigint_rejects() {
        assert_eq!(big_int(12.0).unwrap(), BigInt::from(12));
        let message = big_int(1.5).unwrap_err();
        assert!(
            message.contains("cannot be converted to a BigInt"),
            "{message}"
        );
        assert!(big_int(f64::INFINITY).is_err());
    }

    #[test]
    fn literal_raw_round_trips() {
        let boolean: NodeKind =
            serde_json::from_str(r##"{"type":"BooleanLiteral","value":true,"raw":"#fact(x)"}"##)
                .unwrap();
        assert!(
            matches!(&boolean, NodeKind::BooleanLiteral { raw: Some(r), .. } if r == "#fact(x)")
        );
        let text: NodeKind =
            serde_json::from_str(r#"{"type":"StringLiteral","value":"v"}"#).unwrap();
        assert!(matches!(&text, NodeKind::StringLiteral { raw: None, .. }));
        assert!(!serde_json::to_string(&text).unwrap().contains("raw"));
        assert!(
            serde_json::to_string(&boolean)
                .unwrap()
                .contains(r##""raw":"#fact(x)""##)
        );
    }
}
