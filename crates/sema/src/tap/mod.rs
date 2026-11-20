//! Replay of tapped JS calls for this crate's functions (`xtask tap --front`), one module per function.
//!
//! `scripts/oracle/front-tap` records `{seq, fn, args, result, after?}` for each call. A unit's `replay`
//! reads `args` from its record, runs the port, and compares with `result` (and `after`).

pub mod bind;
pub mod bind_imported_components;
pub mod check;
pub mod graph;
pub mod layout_template;
pub mod scan_declared_types;
