//! The per-machine media modules (`packages/<machine>/media/index.cjs`).
//! Each is a stub until the elaborate unit ports its lowering; a stub
//! lowers nothing, which the caller reads as "use the default lowering".

pub mod atari8;
pub mod c64;
pub mod cx16;
pub mod nes;
pub mod pet;
pub mod vic20;
pub mod web;

use crate::machine::MachineMedia;

/// The media module of `machine`, or `None` for a machine without one.
#[must_use]
pub fn for_machine(machine: &str) -> Option<Box<dyn MachineMedia>> {
    match machine {
        "atari8" => Some(Box::new(atari8::Atari8)),
        "c64" => Some(Box::new(c64::C64)),
        "cx16" => Some(Box::new(cx16::Cx16)),
        "nes" => Some(Box::new(nes::Nes)),
        "pet" => Some(Box::new(pet::Pet)),
        "vic20" => Some(Box::new(vic20::Vic20)),
        "web" => Some(Box::new(web::Web)),
        _ => None,
    }
}
