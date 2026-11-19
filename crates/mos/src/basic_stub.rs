//! Port of mos/basic-stub.ts: the one-line BASIC program `0 SYS <codeStart>`
//! every Commodore `.prg` boots through. Its length depends on the digit
//! count of `codeStart`, which depends on its length, so the digit count is
//! found by iterating.

use jsnum::number_to_string;

/// Bytes before the digits: line link, line number, SYS token, line end and
/// the two-byte end-of-program link.
const STUB_OVERHEAD_BYTES: i64 = 8;

const SYS_TOKEN: u8 = 0x9e;

fn decimal_digits(n: i64) -> i64 {
    number_to_string(n as f64).chars().count() as i64
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BasicStub {
    /// The stub's bytes, starting at the load address (not including it).
    pub bytes: Vec<u8>,
    /// Where the SYS line sends control: right after these bytes.
    pub code_start: i64,
}

/// The BASIC stub for a program loaded at `load`.
pub fn basic_stub(load: i64) -> Result<BasicStub, String> {
    let mut digits = decimal_digits(load + STUB_OVERHEAD_BYTES);
    let mut code_start = load + STUB_OVERHEAD_BYTES + digits;
    let mut guard = 0;
    while decimal_digits(code_start) != digits {
        if guard >= 5 {
            return Err(format!(
                "basicStub: SYS-line digit count did not converge for load address {}",
                number_to_string(load as f64)
            ));
        }
        digits = decimal_digits(code_start);
        code_start = load + STUB_OVERHEAD_BYTES + digits;
        guard += 1;
    }

    let mut bytes = Vec::with_capacity((STUB_OVERHEAD_BYTES + digits) as usize);
    let next_line = load + STUB_OVERHEAD_BYTES - 2 + digits;
    bytes.push((next_line & 0xff) as u8);
    bytes.push(((next_line >> 8) & 0xff) as u8);
    bytes.push(0x00); // line number 0, low byte
    bytes.push(0x00); // line number 0, high byte
    bytes.push(SYS_TOKEN);
    bytes.extend(number_to_string(code_start as f64).bytes());
    bytes.push(0x00); // end of line
    bytes.push(0x00); // end of program, low byte
    bytes.push(0x00); // end of program, high byte

    Ok(BasicStub { bytes, code_start })
}

#[cfg(test)]
mod tests {
    use super::basic_stub;

    #[test]
    fn c64_stub_is_the_known_bytes() {
        let s = basic_stub(0x0801).unwrap();
        assert_eq!(s.code_start, 2061);
        assert_eq!(
            s.bytes,
            vec![0x0b, 0x08, 0, 0, 0x9e, b'2', b'0', b'6', b'1', 0, 0, 0]
        );
    }

    #[test]
    fn digit_count_grows_across_a_power_of_ten() {
        // 9999 + 8 crosses into five digits.
        let s = basic_stub(0x9999).unwrap();
        assert_eq!(s.bytes.len(), 8 + 5);
        assert_eq!(s.code_start, 0x9999 + 13);
    }
}
