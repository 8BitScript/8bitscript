//! The 6502 back end, ported from `packages/compiler/src/mos`.

pub mod asm;
pub mod basic_stub;
pub mod build;
pub mod chr_nes;
pub mod data;
pub mod image;
pub mod link;
pub mod lower;
pub mod machine;
pub mod native;
pub mod prg;
pub mod provenance;
pub mod startup;
pub mod tap;
pub mod types;
pub mod walk;
pub mod zp;

/// The error text a method returns until its unit is ported (R5.7).
#[must_use]
pub fn unported(js_name: &str) -> String {
    format!("unported: {js_name}")
}
