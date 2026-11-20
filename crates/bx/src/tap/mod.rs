//! Replay of tapped JS calls for this crate's functions (`xtask tap --front`), one module per function.
//!
//! `scripts/oracle/front-tap` records `{seq, fn, args, result, after?}` for each call. A unit's `replay`
//! reads `args` from its record, runs the port, and compares with `result` (and `after`).

pub mod check_bx;
pub mod elaborate_bx;
