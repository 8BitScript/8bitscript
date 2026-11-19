//! Port of mos/startup/waitframe.ts
//!
//! `usesWaitFrame` (`waitframe.ts:76-86`) is ported with the IR walks in PR-G.

use crate::asm::assemble::{Directive, Half, Operand};
use crate::asm::encode::AddressingMode;
use crate::build::Machine;
use jsnum::{math_round, to_int32, to_uint32};

pub const WAIT_FRAME_LABEL: &str = "__8bs_wait_frame";
pub const WAIT_FRAME_ZP_BYTES: i64 = 8;

const CB1_FLAG: i64 = 0xe813;
const PIA1_PORT_B: i64 = 0xe812;
const VIA1_T2_LO: i64 = 0xe848;
const VIA1_T2_HI: i64 = 0xe849;
const DEN: f64 = 1_000_000.0;
const VERA_ISR: i64 = 0x9f27;
const PPU_STATUS: i64 = 0x2002;

#[derive(Clone, Copy)]
struct Ratio {
    num: f64,
    den: f64,
}

const fn ratio(num: f64, den: f64) -> Ratio {
    Ratio { num, den }
}

fn instr(
    mnemonic: &str,
    mode: AddressingMode,
    value: Option<i64>,
    label_name: Option<&str>,
) -> Directive {
    let operand = if let Some(name) = label_name {
        Some(Operand::Label {
            name: name.to_string(),
            byte: None::<Half>,
            offset: None,
        })
    } else {
        value.map(|value| Operand::Value { value })
    };
    Directive::Instruction {
        mnemonic: mnemonic.to_string(),
        mode,
        operand,
        prov: None,
    }
}

fn implied(mnemonic: &str) -> Directive {
    instr(mnemonic, AddressingMode::Implied, None, None)
}

fn imm(mnemonic: &str, v: i64) -> Directive {
    instr(mnemonic, AddressingMode::Immediate, Some(v), None)
}

fn label(name: &str) -> Directive {
    Directive::Label {
        name: name.to_string(),
        prov: None,
    }
}

fn branch(mnemonic: &str, target: &str) -> Directive {
    instr(mnemonic, AddressingMode::Relative, None, Some(target))
}

fn jmp(target: &str) -> Directive {
    instr("JMP", AddressingMode::Absolute, None, Some(target))
}

fn lda_imm(v: i64) -> Directive {
    imm("LDA", v)
}

fn lda_abs(v: i64) -> Directive {
    instr("LDA", AddressingMode::Absolute, Some(v), None)
}

fn sta_abs(v: i64) -> Directive {
    instr("STA", AddressingMode::Absolute, Some(v), None)
}

fn lda_zp(a: i64) -> Directive {
    instr("LDA", AddressingMode::Zeropage, Some(a), None)
}

fn sta_zp(a: i64) -> Directive {
    instr("STA", AddressingMode::Zeropage, Some(a), None)
}

fn zp_op(mnemonic: &str, a: i64) -> Directive {
    instr(mnemonic, AddressingMode::Zeropage, Some(a), None)
}

/// `Math.floor(n / 256 ** i) & 0xff`.
fn byte_of(n: f64, i: i32) -> i64 {
    i64::from(to_int32((n / 256f64.powi(i)).floor()) & 0xff)
}

fn add32(dst: i64, src: i64) -> Vec<Directive> {
    let mut out = vec![implied("CLC")];
    for i in 0..4 {
        out.push(lda_zp(dst + i));
        out.push(zp_op("ADC", src + i));
        out.push(sta_zp(dst + i));
    }
    out
}

fn shift_left32(addr: i64) -> Vec<Directive> {
    vec![
        zp_op("ASL", addr),
        zp_op("ROL", addr + 1),
        zp_op("ROL", addr + 2),
        zp_op("ROL", addr + 3),
    ]
}

#[derive(Clone, Copy)]
enum RasterKind {
    /// c64, mega65, c128: `$D012`/`$D011`.
    Vic2,
    /// vic20: `$9004`.
    Vic20,
    /// atari8, atari5200: `VCOUNT` `$D40B`.
    Antic,
}

struct RasterSync {
    kind: RasterKind,
    pal: Ratio,
    ntsc: Ratio,
    keeps_interrupts: bool,
}

impl RasterSync {
    fn top_half(&self) -> Vec<Directive> {
        match self.kind {
            RasterKind::Vic2 => vec![
                lda_abs(0xd012),
                instr("ORA", AddressingMode::Absolute, Some(0xd011), None),
                imm("AND", 0x80),
            ],
            RasterKind::Vic20 => vec![lda_abs(0x9004), imm("CMP", 64)],
            RasterKind::Antic => vec![lda_abs(0xd40b), imm("CMP", 64)],
        }
    }

    fn when_top(&self) -> &'static str {
        match self.kind {
            RasterKind::Vic2 => "BEQ",
            _ => "BCC",
        }
    }

    fn when_not_top(&self) -> &'static str {
        match self.kind {
            RasterKind::Vic2 => "BNE",
            _ => "BCS",
        }
    }

    fn pal_probe(&self, target: &str) -> Vec<Directive> {
        match self.kind {
            RasterKind::Vic2 => {
                let skip = format!("{target}_skip");
                vec![
                    lda_abs(0xd011),
                    imm("AND", 0x80),
                    branch("BEQ", &skip),
                    lda_abs(0xd012),
                    imm("CMP", 32),
                    branch("BCS", target),
                    label(&skip),
                ]
            }
            RasterKind::Vic20 => vec![lda_abs(0x9004), imm("CMP", 140), branch("BCS", target)],
            RasterKind::Antic => vec![lda_abs(0xd40b), imm("CMP", 140), branch("BCS", target)],
        }
    }
}

const VIC2_PAL: Ratio = ratio((312 * 63 * 18) as f64, 17_734_472.0);
const VIC2_NTSC: Ratio = ratio((263 * 65 * 14) as f64, 14_318_181.0);

fn raster(machine: Machine) -> Option<RasterSync> {
    let vic2 = |kind| RasterSync {
        kind,
        pal: VIC2_PAL,
        ntsc: VIC2_NTSC,
        keeps_interrupts: false,
    };
    let antic = || RasterSync {
        kind: RasterKind::Antic,
        pal: ratio((312 * 114) as f64, 1_773_447.0),
        ntsc: ratio((262 * 114) as f64, 1_789_790.0),
        keeps_interrupts: true,
    };
    match machine {
        Machine::C64 | Machine::Mega65 | Machine::C128 => Some(vic2(RasterKind::Vic2)),
        Machine::Vic20 => Some(RasterSync {
            kind: RasterKind::Vic20,
            pal: ratio((312 * 71 * 4) as f64, 4_433_618.0),
            ntsc: ratio((261 * 65 * 14) as f64, 14_318_181.0),
            keeps_interrupts: false,
        }),
        Machine::Atari8 | Machine::Atari5200 => Some(antic()),
        _ => None,
    }
}

#[derive(Clone, Copy)]
enum FlagWait {
    Vera,
    Ppu,
    Ted,
    AbsBit(i64, i64),
    Spin,
    Intim,
}

struct FlagSync {
    wait: FlagWait,
    ratio: Ratio,
    keeps_interrupts: bool,
}

fn flag(machine: Machine) -> Option<FlagSync> {
    let one_sixtieth = ratio(1.0, 60.0);
    let f = |wait, ratio| {
        Some(FlagSync {
            wait,
            ratio,
            keeps_interrupts: false,
        })
    };
    match machine {
        Machine::Cx16 => f(FlagWait::Vera, one_sixtieth),
        Machine::Nes => f(FlagWait::Ppu, ratio(59561.0, f64::from(2 * 1_789_773))),
        Machine::Plus4 => f(FlagWait::Ted, one_sixtieth),
        Machine::Apple2 => f(FlagWait::AbsBit(0xc019, 0x80), one_sixtieth),
        Machine::Oric => f(FlagWait::AbsBit(0x030d, 0x40), one_sixtieth),
        Machine::Bbc => f(FlagWait::AbsBit(0xfe4d, 0x02), one_sixtieth),
        Machine::Lynx | Machine::Pce | Machine::Supervision => f(FlagWait::Spin, one_sixtieth),
        Machine::Atari2600 => f(FlagWait::Intim, ratio(f64::from(76 * 262), 1_193_182.0)),
        Machine::Atari7800 => f(FlagWait::AbsBit(0x0028, 0x80), one_sixtieth),
        _ => None,
    }
}

impl FlagWait {
    fn directives(self, tag: &str) -> Vec<Directive> {
        match self {
            Self::Vera => {
                let poll = format!("{tag}_vsync");
                vec![
                    label(&poll),
                    lda_abs(VERA_ISR),
                    imm("AND", 0x01),
                    branch("BEQ", &poll),
                    lda_imm(0x01),
                    sta_abs(VERA_ISR),
                ]
            }
            Self::Ted => {
                let poll = format!("{tag}_ted");
                vec![
                    label(&poll),
                    lda_abs(0xff1c),
                    imm("AND", 0x01),
                    branch("BNE", &poll),
                    lda_abs(0xff1d),
                    branch("BNE", &poll),
                ]
            }
            Self::AbsBit(address, mask) => {
                let poll = format!("{tag}_bit");
                vec![
                    label(&poll),
                    lda_abs(address),
                    imm("AND", mask),
                    branch("BEQ", &poll),
                ]
            }
            Self::Spin => {
                let spin = format!("{tag}_spin");
                vec![
                    imm("LDX", 0),
                    label(&spin),
                    implied("DEX"),
                    branch("BNE", &spin),
                ]
            }
            Self::Intim => {
                let poll = format!("{tag}_intim");
                vec![label(&poll), lda_abs(0x0284), branch("BNE", &poll)]
            }
            Self::Ppu => {
                let poll = format!("{tag}_vblank");
                vec![label(&poll), lda_abs(PPU_STATUS), branch("BPL", &poll)]
            }
        }
    }
}

/// True when this machine's frame runtime must leave interrupts enabled.
#[must_use]
pub fn wait_frame_keeps_interrupts(machine: Machine) -> bool {
    raster(machine).is_some_and(|r| r.keeps_interrupts)
        || flag(machine).is_some_and(|f| f.keeps_interrupts)
}

/// The instructions that block until the machine's once-a-frame edge, or
/// `None` for a machine with no flag to poll.
#[must_use]
pub fn frame_edge_wait(machine: Machine, tag: &str) -> Option<Vec<Directive>> {
    flag(machine).map(|f| f.wait.directives(tag))
}

fn frame_credit(frame_rate: f64, ratio: Ratio) -> f64 {
    math_round(((frame_rate * ratio.num) * DEN) / ratio.den)
}

fn store_num(num: i64, value: f64) -> Vec<Directive> {
    let mut out = Vec::new();
    for i in 0..4 {
        out.push(lda_imm(byte_of(value, i32::try_from(i).unwrap_or(0))));
        out.push(sta_zp(num + i));
    }
    out
}

fn zero_acc(acc: i64) -> Vec<Directive> {
    vec![
        lda_imm(0),
        sta_zp(acc),
        sta_zp(acc + 1),
        sta_zp(acc + 2),
        sta_zp(acc + 3),
    ]
}

fn raster_setup(frame_rate: f64, acc: i64, num: i64, sync: &RasterSync) -> Vec<Directive> {
    let outer = "__8bs_wf_probe_outer";
    let inner = "__8bs_wf_probe_inner";
    let is_pal = "__8bs_wf_probe_pal";
    let done = "__8bs_wf_probe_done";
    let mut out = Vec::new();
    if !sync.keeps_interrupts {
        out.push(implied("SEI"));
    }
    out.extend(zero_acc(acc));
    out.extend([imm("LDY", 16), label(outer), imm("LDX", 0), label(inner)]);
    out.extend(sync.pal_probe(is_pal));
    out.extend([implied("DEX"), branch("BNE", inner)]);
    out.extend([implied("DEY"), branch("BNE", outer)]);
    out.extend(store_num(num, frame_credit(frame_rate, sync.ntsc)));
    out.push(jmp(done));
    out.push(label(is_pal));
    out.extend(store_num(num, frame_credit(frame_rate, sync.pal)));
    out.push(label(done));
    out
}

fn flag_setup(frame_rate: f64, acc: i64, num: i64, sync: &FlagSync) -> Vec<Directive> {
    let mut out = if sync.keeps_interrupts {
        Vec::new()
    } else {
        vec![implied("SEI")]
    };
    out.extend(zero_acc(acc));
    out.extend(store_num(num, frame_credit(frame_rate, sync.ratio)));
    out
}

fn raster_wait(sync: &RasterSync) -> Vec<Directive> {
    let leaving = format!("{WAIT_FRAME_LABEL}_leaving");
    let returning = format!("{WAIT_FRAME_LABEL}_returning");
    let mut out = vec![label(&leaving)];
    out.extend(sync.top_half());
    out.push(branch(sync.when_top(), &leaving));
    out.push(label(&returning));
    out.extend(sync.top_half());
    out.push(branch(sync.when_not_top(), &returning));
    out
}

fn pet_wait_edge(out: &mut Vec<Directive>, tag: &str) {
    let poll = format!("__8bs_wf_setup_{tag}");
    out.push(label(&poll));
    out.push(lda_abs(CB1_FLAG));
    out.push(imm("AND", 0x80));
    out.push(branch("BEQ", &poll));
    out.push(lda_abs(PIA1_PORT_B));
}

/// The one-time program-start setup.
#[must_use]
pub fn wait_frame_setup(frame_rate: f64, acc: i64, num: i64, machine: Machine) -> Vec<Directive> {
    if let Some(sync) = raster(machine) {
        return raster_setup(frame_rate, acc, num, &sync);
    }
    if let Some(sync) = flag(machine) {
        return flag_setup(frame_rate, acc, num, &sync);
    }
    let mut out = vec![implied("SEI")];
    pet_wait_edge(&mut out, "start");
    out.push(lda_imm(0xff));
    out.push(sta_abs(VIA1_T2_LO));
    out.push(lda_imm(0xff));
    out.push(sta_abs(VIA1_T2_HI));
    pet_wait_edge(&mut out, "end");

    out.push(lda_abs(VIA1_T2_LO));
    out.push(imm("EOR", 0xff));
    out.push(sta_zp(acc));
    out.push(lda_abs(VIA1_T2_HI));
    out.push(imm("EOR", 0xff));
    out.push(sta_zp(acc + 1));
    out.extend([lda_imm(0), sta_zp(acc + 2), sta_zp(acc + 3)]);
    out.extend([
        lda_imm(0),
        sta_zp(num),
        sta_zp(num + 1),
        sta_zp(num + 2),
        sta_zp(num + 3),
    ]);

    let rate = frame_rate.floor();
    if rate > 0.0 && rate <= 255.0 {
        let loop_label = "__8bs_wf_mul";
        let skip = "__8bs_wf_mul_skip";
        out.push(imm("LDX", rate as i64));
        out.push(imm("LDY", 8));
        out.push(label(loop_label));
        out.extend([
            implied("TXA"),
            instr("LSR", AddressingMode::Accumulator, None, None),
            implied("TAX"),
        ]);
        out.push(branch("BCC", skip));
        out.extend(add32(num, acc));
        out.push(label(skip));
        out.extend(shift_left32(acc));
        out.extend([implied("DEY"), branch("BNE", loop_label)]);
    } else if rate > 255.0 {
        // rate is a finite integer above 255 here; Math.floor(Math.log2(rate)) + 1
        let bits = 64 - (rate as u64).leading_zeros();
        let rate32 = to_uint32(rate);
        for bit in 0..bits {
            if (rate32 >> bit) & 1 == 1 {
                out.extend(add32(num, acc));
            }
            if bit + 1 < bits {
                out.extend(shift_left32(acc));
            }
        }
    }
    out.extend(zero_acc(acc));
    out
}

/// The shared subroutine every `waitFrame()` call site `JSR`s.
#[must_use]
pub fn wait_frame_routine(
    acc: i64,
    num: i64,
    machine: Machine,
    frame_hook_label: Option<&str>,
) -> Vec<Directive> {
    let ge = format!("{WAIT_FRAME_LABEL}_ge");
    let wait = format!("{WAIT_FRAME_LABEL}_wait");
    let poll = format!("{WAIT_FRAME_LABEL}_poll");
    let loop_label = format!("{WAIT_FRAME_LABEL}_loop");
    let mut out = vec![label(WAIT_FRAME_LABEL), label(&loop_label)];

    for i in (1..=3).rev() {
        out.push(lda_zp(acc + i64::from(i)));
        out.push(imm("CMP", byte_of(DEN, i)));
        out.push(branch("BCC", &wait));
        out.push(branch("BNE", &ge));
    }
    out.push(lda_zp(acc));
    out.push(imm("CMP", byte_of(DEN, 0)));
    out.push(branch("BCC", &wait));

    out.push(label(&ge));
    out.push(implied("SEC"));
    for i in 0..4 {
        out.push(lda_zp(acc + i64::from(i)));
        out.push(imm("SBC", byte_of(DEN, i)));
        out.push(sta_zp(acc + i64::from(i)));
    }
    out.push(implied("RTS"));

    out.push(label(&wait));
    if let Some(sync) = raster(machine) {
        out.extend(raster_wait(&sync));
    } else if let Some(sync) = flag(machine) {
        out.extend(sync.wait.directives(WAIT_FRAME_LABEL));
    } else {
        out.push(label(&poll));
        out.push(lda_abs(CB1_FLAG));
        out.push(imm("AND", 0x80));
        out.push(branch("BEQ", &poll));
        out.push(lda_abs(PIA1_PORT_B));
    }
    if let Some(hook) = frame_hook_label.filter(|h| !h.is_empty()) {
        out.push(instr("JSR", AddressingMode::Absolute, None, Some(hook)));
    }
    out.extend(add32(acc, num));
    out.push(jmp(&loop_label));
    out
}
