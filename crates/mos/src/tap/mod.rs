//! Replay of tapped JS calls, one module per tapped function (`xtask tap`).

pub mod allocate;
pub mod assemble_native;
pub mod build_data_section;
pub mod layout_frames;
pub mod link;
pub mod lower;
