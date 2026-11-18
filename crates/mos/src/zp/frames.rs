//! Port of mos/zp/frames.ts
//!
//! Call-graph-aware zero-page frames: each function's parameters, 16-bit
//! return slot and locals form one contiguous frame, and a frame starts where
//! the deepest frame that can be live at the same time ends. A call named
//! anywhere inside arguments 2..n of a call to `f` counts as called by `f`,
//! because `f`'s earlier parameter slots already hold values while it runs.

use indexmap::{IndexMap, IndexSet};
use jsnum::hex_upper;
use mos_ir::{Call, Expr, Function};

use super::ZpHole;
use crate::walk::{Flow, Node, visit_body, visit_expr};

/// What one function's frame must hold: parameter bytes, return-slot bytes and
/// the locals/temporaries high-water mark the measurement pass observed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameNeed {
    pub bytes: i64,
}

/// `FrameLayout` when `ok`: every function's frame start, and one past the
/// deepest byte any frame reaches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameLayout {
    pub starts: IndexMap<String, i64>,
    pub floor: i64,
}

/// Every call under `body` in F5 order (`collectCalls`, `frames.ts:52`).
fn collect_calls(body: &[mos_ir::Stmt]) -> Vec<&Call> {
    let mut out = Vec::new();
    visit_body(body, &mut |node| {
        if let Some(call) = node.as_call() {
            out.push(call);
        }
        Flow::Continue
    });
    out
}

fn collect_calls_in_expr(expr: &Expr) -> Vec<&Call> {
    let mut out = Vec::new();
    visit_expr(expr, &mut |node| {
        if let Node::Expr(Expr::Call(call)) = node {
            out.push(call);
        }
        Flow::Continue
    });
    out
}

/// Every function's live-parents: the functions whose frames must sit below
/// its own. That is its real callers, plus any function `f` whose call
/// carries this one inside arguments 2..n (`collectLiveParents`,
/// `frames.ts:70`).
#[must_use]
pub fn collect_live_parents(functions: &[Function]) -> IndexMap<String, IndexSet<String>> {
    let known: IndexSet<&str> = functions.iter().map(|f| f.name.as_str()).collect();
    let mut parents: IndexMap<String, IndexSet<String>> = functions
        .iter()
        .map(|f| (f.name.clone(), IndexSet::new()))
        .collect();
    let mut add = |child: &str, parent: &str| {
        if !known.contains(child) || child == parent {
            if child == parent {
                // a self-edge is a real cycle, keep it visible
                if let Some(set) = parents.get_mut(child) {
                    set.insert(parent.to_string());
                }
            }
            return;
        }
        if let Some(set) = parents.get_mut(child) {
            set.insert(parent.to_string());
        }
    };
    for function in functions {
        for call in collect_calls(&function.body) {
            add(&call.name, &function.name);
            // Argument one needs no edge: it is evaluated before any slot of
            // the callee is written (`frames.ts:81`).
            for arg in call.args.iter().skip(1) {
                for inner in collect_calls_in_expr(arg) {
                    add(&inner.name, &call.name);
                }
            }
        }
    }
    parents
}

fn hex(value: i64) -> String {
    format!("${}", hex_upper(value, 2))
}

/// The lowest start >= `from` where a whole frame of `bytes` avoids every
/// hole (`pastHoles`, `frames.ts:99`).
fn past_holes(from: i64, bytes: i64, holes: &[ZpHole]) -> i64 {
    let mut start = from;
    while let Some(hole) = holes
        .iter()
        .find(|h| start < h.end && start + bytes > h.start)
    {
        start = hole.end;
    }
    start
}

/// Assigns every function's frame start: topological over the live-parent
/// graph, each frame starting where its deepest live parent's frame ends (the
/// entry's at `origin`), skipped past any hole it would straddle. Errors carry
/// the JS `error` text (`layoutFrames`, `frames.ts:114`).
///
/// # Errors
/// A frame that no longer fits below `ceiling`, or a cycle in the live-parent graph.
pub fn layout_frames(
    functions: &[Function],
    entry: &str,
    needs: &IndexMap<String, FrameNeed>,
    origin: i64,
    ceiling: i64,
    holes: &[ZpHole],
) -> Result<FrameLayout, String> {
    let parents = collect_live_parents(functions);
    let mut remaining: IndexMap<String, usize> = IndexMap::new();
    let mut children: IndexMap<String, Vec<String>> = functions
        .iter()
        .map(|f| (f.name.clone(), Vec::new()))
        .collect();
    for (child, parent_set) in &parents {
        remaining.insert(child.clone(), parent_set.len());
        for parent in parent_set {
            if let Some(list) = children.get_mut(parent) {
                list.push(child.clone());
            }
        }
    }

    let mut starts: IndexMap<String, i64> = IndexMap::new();
    let mut ends: IndexMap<String, i64> = IndexMap::new();
    let mut floor = origin;
    let mut ready: Vec<String> = functions
        .iter()
        .filter(|f| remaining.get(&f.name).copied().unwrap_or(0) == 0)
        .map(|f| f.name.clone())
        .collect();
    if !ready.iter().any(|n| n == entry) && remaining.get(entry).copied().unwrap_or(0) == 0 {
        ready.push(entry.to_string());
    }
    let mut processed = 0usize;
    while let Some(name) = ready.pop() {
        processed += 1;
        let mut from = origin;
        if let Some(set) = parents.get(&name) {
            for parent in set {
                from = from.max(ends.get(parent).copied().unwrap_or(from));
            }
        }
        let bytes = needs.get(&name).map_or(0, |n| n.bytes);
        let start = past_holes(from, bytes, holes);
        if start + bytes > ceiling {
            return Err(format!(
                "out of zero page: '{name}'s frame needs {bytes} byte(s) at {} but the budget ends at {} \u{2014} the deepest call chain's frames ({} up) no longer fit",
                hex(start),
                hex(ceiling - 1),
                hex(origin)
            ));
        }
        starts.insert(name.clone(), start);
        ends.insert(name.clone(), start + bytes);
        floor = floor.max(start + bytes);
        if let Some(list) = children.get(&name) {
            for child in list {
                let left = remaining.get(child).copied().unwrap_or(0).wrapping_sub(1);
                remaining.insert(child.clone(), left);
                if left == 0 {
                    ready.push(child.clone());
                }
            }
        }
    }
    if processed < functions.len() {
        let stuck: Vec<&str> = functions
            .iter()
            .filter(|f| !starts.contains_key(&f.name))
            .map(|f| f.name.as_str())
            .collect();
        return Err(format!(
            "frame layout found a cycle through {}: a function reappearing inside its own call's later arguments (f(a, f(b))) isn't layable-out \u{2014} hoist the inner call into a local first",
            stuck.join(" -> ")
        ));
    }
    Ok(FrameLayout { starts, floor })
}
