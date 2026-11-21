//! Port of mos/lower/index.ts `:668-1336`: the 16-bit value paths, strings,
//! array indexing and call sites.
//!
//! `alloc`/`alloc16` are `self.locals.alloc`/`alloc16` here, which is exactly
//! what the JS wrappers do; the wrappers themselves live in `flow.rs`.

use jsnum::to_int32;
use mos_ir::{Call, Expr, Stmt, StoreIndex};

use super::{
    Binding, Lowerer, const_value, expr_kind, expr_type, has_type, imm_byte, indexed, instr,
    is_const_num, is_pure, is_ref_named, is_signed, lda_addr, lda_imm, lda_imm_hi, lda_imm_lo,
    lda_zp, require16_bit, split_index_offset, sta_addr, sta_zp, type_is_bytes,
};
use crate::asm::assemble::Half;
use crate::asm::encode::AddressingMode;
use crate::data::{array_label, string_label};
use crate::types::storage_bytes;

/// `value & 0xffff` as JS computes it (ToInt32 first).
fn mask16(value: i64) -> i64 {
    i64::from(to_int32(value as f64) & 0xffff)
}

/// `value & 0xff` as JS computes it.
fn mask8(value: i64) -> i64 {
    i64::from(to_int32(value as f64) & 0xff)
}

/// `node.name` of a `ref`; JS reads `undefined` off any other node.
fn name_of(node: &Expr) -> String {
    match node {
        Expr::Ref(r) => r.name.clone(),
        _ => "undefined".to_string(),
    }
}

fn imp(mnemonic: &str) -> super::Directive {
    instr(mnemonic, AddressingMode::Implied, None, None)
}

fn acc(mnemonic: &str) -> super::Directive {
    instr(mnemonic, AddressingMode::Accumulator, None, None)
}

fn zp(mnemonic: &str, address: i64) -> super::Directive {
    instr(mnemonic, AddressingMode::Zeropage, Some(address), None)
}

fn imm(mnemonic: &str, value: i64) -> super::Directive {
    instr(mnemonic, AddressingMode::Immediate, Some(value), None)
}

fn indirect_y(mnemonic: &str, pointer: i64) -> super::Directive {
    instr(mnemonic, AddressingMode::IndirectY, Some(pointer), None)
}

fn abs_y(mnemonic: &str, label: &str) -> super::Directive {
    instr(mnemonic, AddressingMode::AbsoluteY, None, Some(label))
}

impl Lowerer<'_> {
    /// A 16-bit value into a zero-page pair; returns the pair's address.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn expr16(&mut self, node: &Expr) -> Result<i64, String> {
        if has_type(node) {
            require16_bit(expr_type(node), &format!("'{}'", expr_kind(node)))?;
        }
        match node {
            Expr::Const(c) => {
                let address = self.locals.alloc16("a 16-bit literal")?;
                let value = mask16(c.value);
                self.emit([
                    lda_imm(value & 0xff),
                    sta_zp(address),
                    lda_imm((value >> 8) & 0xff),
                    sta_zp(address + 1),
                ]);
                Ok(address)
            }
            Expr::Ref(r) => {
                if r.ty.as_option().map(String::as_str) == Some("string")
                    && self.arrays.contains_key(&r.name)
                {
                    let address = self.locals.alloc16(&format!("'{}'s own address", r.name))?;
                    let target = array_label(&r.name);
                    self.emit([
                        lda_imm_lo(&target),
                        sta_zp(address),
                        lda_imm_hi(&target),
                        sta_zp(address + 1),
                    ]);
                    return Ok(address);
                }
                Ok(self.binding(&r.name)?.address)
            }
            Expr::Binop(_) => self.binop16(node),
            Expr::String(s) => {
                let address = self.locals.alloc16("a string literal's address")?;
                let target = string_label(s.index);
                self.emit([
                    lda_imm_lo(&target),
                    sta_zp(address),
                    lda_imm_hi(&target),
                    sta_zp(address + 1),
                ]);
                Ok(address)
            }
            Expr::Index(_) => self.index_read16(node),
            Expr::Call(call) => {
                let functions = self.functions;
                let Some(target) = functions.get(&call.name) else {
                    return Err(format!(
                        "call to '{}' resolves to nothing this backend knows about — a linker bug, not a missing lowering rule",
                        call.name
                    ));
                };
                let Some(return_pair) = target.return_pair else {
                    return Err(format!(
                        "call to '{}' used as a 16-bit value, but it returns '{}' — a checker or linker bug, not a missing lowering rule",
                        call.name, target.return_type
                    ));
                };
                self.call_site(call)?;
                let result = self
                    .locals
                    .alloc16(&format!("a temporary for '{}'s return value", call.name))?;
                self.emit([
                    lda_zp(return_pair),
                    sta_zp(result),
                    lda_zp(return_pair + 1),
                    sta_zp(result + 1),
                ]);
                Ok(result)
            }
            _ => Err(format!(
                "no 16-bit instruction-selection rule yet for the '{}' expression — it lands in a later milestone",
                expr_kind(node)
            )),
        }
    }

    /// A 16-bit destination's own value, accepting either width.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn expr_to16(&mut self, node: &Expr) -> Result<i64, String> {
        let Some(ty) = expr_type(node) else {
            return Err(format!(
                "'{}': no type on this IR node — the checker/linker should have set one",
                expr_kind(node)
            ));
        };
        let width = storage_bytes(Some(ty));
        if width == 2 {
            return self.expr16(node);
        }
        if width == 1 && ty == "bool" {
            return Err(format!(
                "'{}' is 'bool': can't widen a bool into a 16-bit value",
                expr_kind(node)
            ));
        }
        if width == 1 && is_signed(ty) {
            return Err(format!(
                "'{}' is '{ty}': a signed value narrower than 16 bits can't widen into one yet — sign-extension isn't lowered",
                expr_kind(node)
            ));
        }
        if width == 1 {
            self.expr(node)?;
            let address = self.locals.alloc16("a zero-extended 16-bit value")?;
            self.emit([sta_zp(address), lda_imm(0), sta_zp(address + 1)]);
            return Ok(address);
        }
        Err(format!(
            "'{}' is '{ty}' ({width} bytes): only an 8-bit value can widen into 16 bits",
            expr_kind(node)
        ))
    }

    /// A 16-bit value stored straight into the pair at `address`/`address+1`.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn store16_into(&mut self, node: &Expr, address: i64) -> Result<(), String> {
        let typed = expr_type(node).is_some();
        let narrow_signed = typed
            && type_is_bytes(node, 1)
            && expr_type(node).is_some_and(|t| t == "bool" || is_signed(t));
        if is_const_num(Some(node), None) && typed && !narrow_signed {
            let value = mask16(const_value(node).unwrap_or(0));
            let lo = value & 0xff;
            let hi = (value >> 8) & 0xff;
            self.emit([lda_imm(lo), sta_addr(address)]);
            if hi != lo {
                self.emit([lda_imm(hi)]);
            }
            self.emit([sta_addr(address + 1)]);
            return Ok(());
        }
        if let Expr::Ref(r) = node {
            if r.ty.as_option().map(String::as_str) == Some("string")
                && self.arrays.contains_key(&r.name)
            {
                let target = array_label(&r.name);
                self.emit([
                    lda_imm_lo(&target),
                    sta_addr(address),
                    lda_imm_hi(&target),
                    sta_addr(address + 1),
                ]);
                return Ok(());
            }
            if has_type(node) && type_is_bytes(node, 2) {
                let src = self.binding(&r.name)?.address;
                self.emit([
                    lda_addr(src),
                    sta_addr(address),
                    lda_addr(src + 1),
                    sta_addr(address + 1),
                ]);
                return Ok(());
            }
        }
        if let Expr::String(s) = node {
            let target = string_label(s.index);
            self.emit([
                lda_imm_lo(&target),
                sta_addr(address),
                lda_imm_hi(&target),
                sta_addr(address + 1),
            ]);
            return Ok(());
        }
        if let Expr::Binop(b) = node
            && (b.operator == "+" || b.operator == "-")
            && has_type(node)
            && type_is_bytes(node, 2)
        {
            return self.add_sub16_into(node, address);
        }
        if has_type(node) && type_is_bytes(node, 1) && !narrow_signed {
            self.expr(node)?;
            self.emit([sta_addr(address), lda_imm(0), sta_addr(address + 1)]);
            return Ok(());
        }
        let mark = self.locals.mark();
        let src = self.expr_to16(node)?;
        self.emit([
            lda_zp(src),
            sta_addr(address),
            lda_zp(src + 1),
            sta_addr(address + 1),
        ]);
        self.locals.release(mark);
        Ok(())
    }

    /// `x = x + 1` (and +2, -1, -2) as INC/DEC on a zero-page target.
    ///
    /// # Errors
    /// Never in practice; the `Result` matches the declared stub signature.
    pub fn emit_inc_dec(
        &mut self,
        target: &str,
        binding: &Binding,
        value: &Expr,
    ) -> Result<bool, String> {
        if binding.address > 0xff {
            return Ok(false);
        }
        let Expr::Binop(b) = value else {
            return Ok(false);
        };
        if b.operator != "+" && b.operator != "-" {
            return Ok(false);
        }
        let amount = if is_ref_named(Some(&b.left), target) && is_const_num(Some(&b.right), None) {
            Some(mask8(const_value(&b.right).unwrap_or(0)))
        } else if b.operator == "+"
            && is_const_num(Some(&b.left), None)
            && is_ref_named(Some(&b.right), target)
        {
            Some(mask8(const_value(&b.left).unwrap_or(0)))
        } else {
            None
        };
        let Some(amount) = amount else {
            return Ok(false);
        };
        if !(1..=2).contains(&amount) {
            return Ok(false);
        }
        let mnemonic = if b.operator == "+" { "INC" } else { "DEC" };
        for _ in 0..amount {
            self.emit([zp(mnemonic, binding.address)]);
        }
        Ok(true)
    }

    /// Addition, subtraction, multiplication, bitwise and shift at 16 bits.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn binop16(&mut self, node: &Expr) -> Result<i64, String> {
        let Expr::Binop(b) = node else {
            return Err("binop16: not a binary expression".to_string());
        };
        let operator = b.operator.as_str();
        if operator == "*" {
            self.multiply_into(node)?;
            let cells = self.require_multiply()?;
            let result = self.locals.alloc16("a temporary for 16-bit '*'")?;
            self.emit([
                lda_zp(cells.result),
                sta_zp(result),
                lda_zp(cells.result + 1),
                sta_zp(result + 1),
            ]);
            return Ok(result);
        }
        if operator == "<<" || operator == ">>" {
            return self.shift16(node);
        }
        if operator == "&" || operator == "|" || operator == "^" {
            return self.bitwise16(node);
        }
        if operator != "+" && operator != "-" {
            return Err(format!(
                "no 16-bit instruction-selection rule yet for the '{operator}' operator — only +, -, *, bitwise &/|/^, and constant-amount shifts are lowered at 16 bits"
            ));
        }
        let result = self
            .locals
            .alloc16(&format!("a temporary for 16-bit '{operator}'"))?;
        self.add_sub16_into(node, result)?;
        Ok(result)
    }

    /// `&`, `|` and `^` at 16 bits, a byte at a time.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn bitwise16(&mut self, node: &Expr) -> Result<i64, String> {
        let Expr::Binop(b) = node else {
            return Err("bitwise16: not a binary expression".to_string());
        };
        let operator = b.operator.as_str();
        let mnemonic = match operator {
            "&" => "AND",
            "|" => "ORA",
            _ => "EOR",
        };
        let result = self
            .locals
            .alloc16(&format!("a temporary for 16-bit '{operator}'"))?;
        let mark = self.locals.mark();
        if is_const_num(Some(&b.right), None) {
            let value = mask16(const_value(&b.right).unwrap_or(0));
            let left = self.expr_to16(&b.left)?;
            self.emit([lda_zp(left), imm(mnemonic, value & 0xff), sta_addr(result)]);
            self.emit([
                lda_zp(left + 1),
                imm(mnemonic, (value >> 8) & 0xff),
                sta_addr(result + 1),
            ]);
        } else {
            let left = self.expr_to16(&b.left)?;
            let right = self.expr_to16(&b.right)?;
            self.emit([lda_zp(left), zp(mnemonic, right), sta_addr(result)]);
            self.emit([
                lda_zp(left + 1),
                zp(mnemonic, right + 1),
                sta_addr(result + 1),
            ]);
        }
        self.locals.release(mark);
        Ok(result)
    }

    /// `left + right` / `left - right` at 16 bits, straight into `target`.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn add_sub16_into(&mut self, node: &Expr, target: i64) -> Result<(), String> {
        let Expr::Binop(b) = node else {
            return Err("addSub16Into: not a binary expression".to_string());
        };
        let plus = b.operator == "+";
        let mark = self.locals.mark();
        let carry = if plus { imp("CLC") } else { imp("SEC") };
        let mnemonic = if plus { "ADC" } else { "SBC" };
        if is_const_num(Some(&b.right), None) {
            let value = mask16(const_value(&b.right).unwrap_or(0));
            let left = self.expr_to16(&b.left)?;
            self.emit([carry]);
            self.emit([lda_zp(left), imm(mnemonic, value & 0xff), sta_addr(target)]);
            self.emit([
                lda_zp(left + 1),
                imm(mnemonic, (value >> 8) & 0xff),
                sta_addr(target + 1),
            ]);
        } else if plus && is_const_num(Some(&b.left), None) {
            let value = mask16(const_value(&b.left).unwrap_or(0));
            let right = self.expr_to16(&b.right)?;
            self.emit([carry]);
            self.emit([lda_zp(right), imm(mnemonic, value & 0xff), sta_addr(target)]);
            self.emit([
                lda_zp(right + 1),
                imm(mnemonic, (value >> 8) & 0xff),
                sta_addr(target + 1),
            ]);
        } else {
            let left = self.expr_to16(&b.left)?;
            let right = self.expr_to16(&b.right)?;
            self.emit([carry]);
            self.emit([lda_zp(left), zp(mnemonic, right), sta_addr(target)]);
            self.emit([
                lda_zp(left + 1),
                zp(mnemonic, right + 1),
                sta_addr(target + 1),
            ]);
        }
        self.locals.release(mark);
        Ok(())
    }

    /// A 16-bit shift by a compile-time amount.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn shift16(&mut self, node: &Expr) -> Result<i64, String> {
        let Expr::Binop(b) = node else {
            return Err("shift16: not a binary expression".to_string());
        };
        let operator = b.operator.as_str();
        let Some(amount) = const_value(&b.right) else {
            return Err(format!(
                "the '{operator}' operator needs a compile-time shift amount — a runtime amount isn't lowered (index a table of masks instead)"
            ));
        };
        let result = self
            .locals
            .alloc16(&format!("a temporary for 16-bit '{operator}'"))?;
        let mark = self.locals.mark();
        let src = self.expr_to16(&b.left)?;
        self.emit([
            lda_zp(src),
            sta_zp(result),
            lda_zp(src + 1),
            sta_zp(result + 1),
        ]);
        self.locals.release(mark);
        if amount >= 16 {
            self.emit([lda_imm(0), sta_zp(result), sta_zp(result + 1)]);
            return Ok(result);
        }
        let mut remaining = amount;
        if remaining >= 8 {
            if operator == ">>" {
                self.emit([
                    lda_zp(result + 1),
                    sta_zp(result),
                    lda_imm(0),
                    sta_zp(result + 1),
                ]);
            } else {
                self.emit([
                    lda_zp(result),
                    sta_zp(result + 1),
                    lda_imm(0),
                    sta_zp(result),
                ]);
            }
            remaining -= 8;
        }
        for _ in 0..remaining {
            if operator == ">>" {
                self.emit([zp("LSR", result + 1), zp("ROR", result)]);
            } else {
                self.emit([zp("ASL", result), zp("ROL", result + 1)]);
            }
        }
        Ok(result)
    }

    /// A string's length byte, through its pointer.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn string_length(&mut self, node: &Expr) -> Result<(), String> {
        let Expr::StringLength(s) = node else {
            return Err("stringLength: not a string length".to_string());
        };
        let mark = self.locals.mark();
        let pointer = self.expr16(&s.string)?;
        self.emit([imm("LDY", 0)]);
        self.emit([indirect_y("LDA", pointer)]);
        self.locals.release(mark);
        Ok(())
    }

    /// A string's byte at an index, skipping the length byte.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn string_byte(&mut self, node: &Expr) -> Result<(), String> {
        let Expr::StringByte(s) = node else {
            return Err("stringByte: not a string byte".to_string());
        };
        let mark = self.locals.mark();
        let pointer = self.expr16(&s.string)?;
        self.expr(&s.index)?;
        self.emit([imp("TAY"), imp("INY")]);
        self.emit([indirect_y("LDA", pointer)]);
        self.locals.release(mark);
        Ok(())
    }

    /// The data-section label an `index` node's own array resolves to.
    ///
    /// # Errors
    /// A `LowerError` text when the array was not placed.
    pub fn array_target(&mut self, node: &Expr) -> Result<String, String> {
        let Expr::Index(i) = node else {
            return Err("arrayTarget: not an index expression".to_string());
        };
        let name = name_of(&i.array);
        if !self.arrays.contains_key(&name) {
            return Err(format!(
                "'{name}' resolves to no array this backend placed — an array parameter isn't lowered yet, and reaching this any other way is a linker or checker bug, not a missing lowering rule"
            ));
        }
        Ok(array_label(&name))
    }

    /// `base + index` in a zero-page pointer, for an index too wide for Y.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn array_pointer(&mut self, label: &str, index: &Expr, offset: i64) -> Result<i64, String> {
        let pointer = self
            .locals
            .alloc16(&format!("'{label}'s own address plus a 16-bit index"))?;
        let wide = self.expr16(index)?;
        self.emit([imp("CLC")]);
        self.emit([
            imm_byte(label, Half::Lo, offset),
            zp("ADC", wide),
            sta_zp(pointer),
        ]);
        self.emit([
            imm_byte(label, Half::Hi, offset),
            zp("ADC", wide + 1),
            sta_zp(pointer + 1),
        ]);
        Ok(pointer)
    }

    /// `name[index] = value`, 1-byte elements.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn store_index(&mut self, node: &Stmt) -> Result<(), String> {
        let Stmt::StoreIndex(n) = node else {
            return Err("storeIndex: not an index store".to_string());
        };
        let name = name_of(&n.array);
        let arrays = self.arrays;
        let Some(entry) = arrays.get(&name) else {
            return Err(format!(
                "'{name}' resolves to no array this backend placed — an array parameter isn't lowered yet, and anything else reaching this is a linker or checker bug"
            ));
        };
        if entry.mutable != Some(true) {
            return Err(format!(
                "'{name}' is a const array — data in the program, not RAM — and the checker should already have refused writing it"
            ));
        }
        if storage_bytes(Some(&entry.element_type)) == 2 {
            return self.store_index16(node, &name);
        }
        let (index, offset) = match split_index_offset(Some(&n.index)) {
            Some((index, offset)) => (index, offset),
            None => (&n.index, 0),
        };
        if type_is_bytes(index, 2) && !is_const_num(Some(index), None) {
            let mark = self.locals.mark();
            let pointer = self.array_pointer(&array_label(&name), index, offset)?;
            self.expr8(&n.value)?;
            self.emit([imm("LDY", 0)]);
            self.emit([indirect_y("STA", pointer)]);
            self.locals.release(mark);
            return Ok(());
        }
        let direct = is_const_num(Some(index), None) || {
            if let Expr::Ref(r) = index
                && has_type(index)
                && type_is_bytes(index, 1)
            {
                self.binding(&r.name)?.address <= 0xff && is_pure(Some(&n.value))
            } else {
                false
            }
        };
        if direct {
            self.expr8(&n.value)?;
            self.index_into_y(index)?;
            self.emit([indexed("STA", &array_label(&name), offset)]);
            return Ok(());
        }
        let mark = self.locals.mark();
        self.index_value(index)?;
        let temp = self
            .locals
            .alloc(&format!("a temporary for '{name}[...]'s own index"))?;
        self.emit([sta_zp(temp)]);
        self.expr8(&n.value)?;
        self.emit([zp("LDY", temp)]);
        self.emit([indexed("STA", &array_label(&name), offset)]);
        self.locals.release(mark);
        Ok(())
    }

    /// `name[index] = value`, 2-byte elements.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn store_index16(&mut self, node: &Stmt, name: &str) -> Result<(), String> {
        let Stmt::StoreIndex(StoreIndex { index, value, .. }) = node else {
            return Err("storeIndex16: not an index store".to_string());
        };
        let wide = self.wide_elements(name)?;
        if !wide && type_is_bytes(index, 2) && !is_const_num(Some(index), None) {
            return Err(format!(
                "storing into '{name}': a 2-byte element under a 16-bit index isn't written yet — an array of 2-byte elements has at most 128 of them, so index it with a utinyint"
            ));
        }
        let mark = self.locals.mark();
        let cell = self.locals.alloc16(&format!(
            "a temporary for the value stored into '{name}[...]'"
        ))?;
        self.store16_into(value, cell)?;
        let double = const_value(index).map(|v| v.saturating_mul(2));
        if let Some(double) = double
            && double.saturating_add(1) > 0xff
        {
            self.emit([imm("LDY", 0)]);
            self.emit([lda_zp(cell), indexed("STA", &array_label(name), double)]);
            self.emit([imp("INY")]);
            self.emit([lda_zp(cell + 1), indexed("STA", &array_label(name), double)]);
            self.locals.release(mark);
            return Ok(());
        }
        if wide && !is_const_num(Some(index), None) {
            let pointer = self.array_pointer16(&array_label(name), index)?;
            self.emit([imm("LDY", 0)]);
            self.emit([lda_zp(cell), indirect_y("STA", pointer)]);
            self.emit([imp("INY")]);
            self.emit([lda_zp(cell + 1), indirect_y("STA", pointer)]);
            self.locals.release(mark);
            return Ok(());
        }
        if let Some(double) = double {
            self.emit([imm("LDY", mask8(double))]);
        } else {
            self.index_value(index)?;
            self.emit([acc("ASL"), imp("TAY")]);
        }
        self.emit([lda_zp(cell), abs_y("STA", &array_label(name))]);
        self.emit([imp("INY")]);
        self.emit([lda_zp(cell + 1), abs_y("STA", &array_label(name))]);
        self.locals.release(mark);
        Ok(())
    }

    /// Whether `name`'s 2-byte elements can lie past byte 255 (more than 128 of them).
    ///
    /// # Errors
    /// Never in practice; the `Result` matches the declared stub signature.
    pub fn wide_elements(&mut self, name: &str) -> Result<bool, String> {
        Ok(self
            .arrays
            .get(name)
            .and_then(|a| a.length)
            .is_some_and(|length| length > 128))
    }

    /// `base + 2 * index` in a zero-page pointer, for 2-byte elements Y cannot reach.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn array_pointer16(&mut self, label: &str, index: &Expr) -> Result<i64, String> {
        let pointer = self.locals.alloc16(&format!(
            "'{label}'s own address plus a doubled 16-bit index"
        ))?;
        let doubled = self
            .locals
            .alloc16(&format!("the byte offset of an element of '{label}'"))?;
        self.store16_into(index, doubled)?;
        self.emit([zp("ASL", doubled), zp("ROL", doubled + 1)]);
        self.emit([imp("CLC")]);
        self.emit([
            imm_byte(label, Half::Lo, 0),
            zp("ADC", doubled),
            sta_zp(pointer),
        ]);
        self.emit([
            imm_byte(label, Half::Hi, 0),
            zp("ADC", doubled + 1),
            sta_zp(pointer + 1),
        ]);
        Ok(pointer)
    }

    /// The index straight into Y.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn index_into_y(&mut self, node: &Expr) -> Result<(), String> {
        if let Some(value) = const_value(node) {
            self.emit([imm("LDY", mask8(value))]);
            return Ok(());
        }
        if let Expr::Ref(r) = node
            && has_type(node)
            && type_is_bytes(node, 1)
        {
            let address = self.binding(&r.name)?.address;
            if address <= 0xff {
                self.emit([zp("LDY", address)]);
                return Ok(());
            }
        }
        self.index_value(node)?;
        self.emit([imp("TAY")]);
        Ok(())
    }

    /// An index expression, either width, into A.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn index_value(&mut self, node: &Expr) -> Result<(), String> {
        let width = match expr_type(node) {
            Some(t) if !t.is_empty() => storage_bytes(Some(t)),
            _ => 1,
        };
        if width == 2 {
            let mark = self.locals.mark();
            let addr = self.expr16(node)?;
            self.emit([lda_zp(addr)]);
            self.locals.release(mark);
            return Ok(());
        }
        self.expr(node)
    }

    /// An array read of a 1-byte element.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn index_read(&mut self, node: &Expr) -> Result<(), String> {
        let Expr::Index(n) = node else {
            return Err("indexRead: not an index expression".to_string());
        };
        let target = self.array_target(node)?;
        let (index, offset) = match split_index_offset(Some(&n.index)) {
            Some((index, offset)) => (index, offset),
            None => (&*n.index, 0),
        };
        if type_is_bytes(index, 2) && !is_const_num(Some(index), None) {
            let mark = self.locals.mark();
            let pointer = self.array_pointer(&target, index, offset)?;
            self.emit([imm("LDY", 0)]);
            self.emit([indirect_y("LDA", pointer)]);
            self.locals.release(mark);
            return Ok(());
        }
        self.index_into_y(index)?;
        self.emit([indexed("LDA", &target, offset)]);
        Ok(())
    }

    /// An array read of a 2-byte element; returns the result pair.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn index_read16(&mut self, node: &Expr) -> Result<i64, String> {
        let Expr::Index(n) = node else {
            return Err("indexRead16: not an index expression".to_string());
        };
        let target = self.array_target(node)?;
        let index: &Expr = &n.index;
        let array_name = name_of(&n.array);
        let result = self
            .locals
            .alloc16(&format!("a temporary for reading '{array_name}'"))?;
        let double = const_value(index).map(|v| v.saturating_mul(2));
        if let Some(double) = double
            && double.saturating_add(1) > 0xff
        {
            self.emit([imm("LDY", 0)]);
            self.emit([indexed("LDA", &target, double), sta_zp(result)]);
            self.emit([imp("INY")]);
            self.emit([indexed("LDA", &target, double), sta_zp(result + 1)]);
            return Ok(result);
        }
        if !is_const_num(Some(index), None) && self.wide_elements(&array_name)? {
            let mark = self.locals.mark();
            let pointer = self.array_pointer16(&target, index)?;
            self.emit([imm("LDY", 0)]);
            self.emit([indirect_y("LDA", pointer), sta_zp(result)]);
            self.emit([imp("INY")]);
            self.emit([indirect_y("LDA", pointer), sta_zp(result + 1)]);
            self.locals.release(mark);
            return Ok(result);
        }
        if let Some(double) = double {
            self.emit([imm("LDY", mask8(double))]);
        } else {
            self.index_value(index)?;
            self.emit([acc("ASL"), imp("TAY")]);
        }
        self.emit([abs_y("LDA", &target), sta_zp(result)]);
        self.emit([imp("INY")]);
        self.emit([abs_y("LDA", &target), sta_zp(result + 1)]);
        Ok(result)
    }

    /// Every argument into the callee's own slot, then `JSR`.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn call_site(&mut self, node: &Call) -> Result<(), String> {
        let functions = self.functions;
        let Some(target) = functions.get(&node.name) else {
            return Err(format!(
                "call to '{}' resolves to nothing this backend knows about — a linker bug, not a missing lowering rule",
                node.name
            ));
        };
        let args = &node.args;
        if args.len() != target.params.len() {
            return Err(format!(
                "call to '{}': {} argument(s) but the function has {} parameter(s) — the linker should already have matched these (completeCall)",
                node.name,
                args.len(),
                target.params.len()
            ));
        }
        for (arg, param) in args.iter().zip(&target.params) {
            if param.width == 2 {
                let mark = self.locals.mark();
                self.store16_into(arg, param.address)?;
                self.locals.release(mark);
            } else {
                self.expr8(arg)?;
                self.emit([sta_zp(param.address)]);
            }
        }
        self.emit([instr(
            "JSR",
            AddressingMode::Absolute,
            None,
            Some(&target.label),
        )]);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use indexmap::IndexMap;
    use jsnum::Nullable;
    use mos_ir::{Binop, Const, Index, Ref, StringByte, StringLength, StringLiteral};

    use super::*;
    use crate::build::Counters;
    use crate::lower::allocator::LocalAllocator;
    use crate::lower::{
        ArrayInfo, FunctionSite, LowerOptions, SiteParam, lda_zp as lz, sta_zp as sz,
    };

    fn konst(value: i64, ty: &str) -> Expr {
        Expr::Const(Const {
            value,
            ty: Some(ty.to_string()),
        })
    }

    fn var(name: &str, ty: &str) -> Expr {
        Expr::Ref(Ref {
            name: name.to_string(),
            ty: jsnum::Nullable::Value(ty.to_string()),
            start: None,
            length: None,
        })
    }

    fn bin(op: &str, left: Expr, right: Expr, ty: &str) -> Expr {
        Expr::Binop(Binop {
            operator: op.to_string(),
            left: Box::new(left),
            right: Box::new(right),
            ty: Some(ty.to_string()),
        })
    }

    fn at(array: &str, index: Expr, ty: &str) -> Expr {
        Expr::Index(Index {
            array: Box::new(var(array, "array")),
            index: Box::new(index),
            element_type: Some(ty.to_string()),
            ty: Some(ty.to_string()),
        })
    }

    fn store(array: &str, index: Expr, value: Expr, ty: &str) -> Stmt {
        Stmt::StoreIndex(StoreIndex {
            array: var(array, "array"),
            index,
            value,
            element_type: Some(ty.to_string()),
            start: 0,
            length: 0,
        })
    }

    fn literal(index: i64) -> Expr {
        Expr::String(StringLiteral {
            index,
            ty: Nullable::Value("string".to_string()),
            start: None,
            length: None,
        })
    }

    fn options() -> LowerOptions {
        let global = |address, ty: &str| Binding {
            address,
            ty: ty.to_string(),
        };
        let array = |ty: &str, mutable: bool, length: Option<i64>| ArrayInfo {
            element_type: ty.to_string(),
            mutable: Some(mutable),
            length,
        };
        LowerOptions {
            globals: IndexMap::from([
                ("a".to_string(), global(0x10, "usmallint")),
                ("b".to_string(), global(0x12, "usmallint")),
                ("n".to_string(), global(0x14, "utinyint")),
                ("hi".to_string(), global(0x200, "utinyint")),
                ("s".to_string(), global(0x16, "string")),
                ("neg".to_string(), global(0x18, "tinyint")),
                ("flag".to_string(), global(0x19, "bool")),
            ]),
            locals: LocalAllocator::new(0x80, 0xa0, &[]),
            params: Vec::new(),
            functions: IndexMap::from([
                (
                    "f8".to_string(),
                    FunctionSite {
                        label: "f8_label".to_string(),
                        params: vec![
                            SiteParam {
                                address: 0x30,
                                width: 1,
                            },
                            SiteParam {
                                address: 0x32,
                                width: 2,
                            },
                        ],
                        return_type: "utinyint".to_string(),
                        return_pair: None,
                    },
                ),
                (
                    "f16".to_string(),
                    FunctionSite {
                        label: "f16_label".to_string(),
                        params: Vec::new(),
                        return_type: "usmallint".to_string(),
                        return_pair: Some(0x40),
                    },
                ),
            ]),
            arrays: IndexMap::from([
                ("bytes".to_string(), array("utinyint", true, Some(10))),
                ("words".to_string(), array("usmallint", true, Some(10))),
                ("big".to_string(), array("usmallint", true, Some(200))),
                ("ro".to_string(), array("utinyint", false, None)),
                ("s".to_string(), array("utinyint", true, None)),
            ]),
            multiply: None,
            return_pair: None,
            fn_name: None,
            fn_file: None,
            origin_files: IndexMap::new(),
        }
    }

    fn run<T>(
        f: impl FnOnce(&mut Lowerer<'_>) -> Result<T, String>,
    ) -> (Result<T, String>, Vec<super::super::Directive>, i64) {
        let mut opts = options();
        let mut counters = Counters::default();
        let mut l = Lowerer::new(&mut opts, &mut counters);
        let result = f(&mut l);
        let program = std::mem::take(&mut l.program);
        let next = l.locals.mark();
        (result, program, next)
    }

    fn ok<T>(r: Result<T, String>) -> T {
        r.unwrap_or_else(|e| panic!("unexpected error: {e}"))
    }

    #[test]
    fn expr16_const_ref_string_and_errors() {
        let (r, p, _) = run(|l| l.expr16(&konst(0x1234, "usmallint")));
        assert_eq!(ok(r), 0x80);
        assert_eq!(p, [lda_imm(0x34), sz(0x80), lda_imm(0x12), sz(0x81)]);

        let (r, p, next) = run(|l| l.expr16(&var("a", "usmallint")));
        assert_eq!((ok(r), p.len(), next), (0x10, 0, 0x80));

        let (r, p, _) = run(|l| l.expr16(&var("s", "string")));
        assert_eq!(ok(r), 0x80);
        assert_eq!(
            p,
            [
                lda_imm_lo("__8bs_arr_s"),
                sz(0x80),
                lda_imm_hi("__8bs_arr_s"),
                sz(0x81)
            ]
        );

        let (r, p, _) = run(|l| l.expr16(&literal(3)));
        assert_eq!(ok(r), 0x80);
        assert_eq!(p[0], lda_imm_lo("__8bs_str_3"));
    }

    #[test]
    fn expr16_rejects_narrow_unknown_and_missing() {
        let (r, _, _) = run(|l| l.expr16(&konst(1, "utinyint")));
        assert_eq!(
            r.unwrap_err(),
            "'const' is 'utinyint' (1 bytes): only 16-bit values take this path — mixed-width arithmetic and anything wider than 16 bits isn't lowered yet"
        );
        let unop = Expr::Unop(mos_ir::Unop {
            operator: "-".into(),
            argument: Box::new(konst(1, "usmallint")),
            ty: Some("usmallint".into()),
        });
        let (r, _, _) = run(|l| l.expr16(&unop));
        assert_eq!(
            r.unwrap_err(),
            "no 16-bit instruction-selection rule yet for the 'unop' expression — it lands in a later milestone"
        );
        let (r, _, _) = run(|l| l.expr16(&var("nope", "usmallint")));
        assert!(r.unwrap_err().starts_with("'nope' resolves to nothing"));
    }

    #[test]
    fn expr16_call_copies_the_return_pair() {
        let call = Expr::Call(Call {
            name: "f16".into(),
            args: Vec::new(),
            ty: Nullable::Value("usmallint".into()),
            start: None,
            length: None,
            instance: None,
        });
        let (r, p, _) = run(|l| l.expr16(&call));
        assert_eq!(ok(r), 0x80);
        assert_eq!(
            p,
            [
                instr("JSR", AddressingMode::Absolute, None, Some("f16_label")),
                lz(0x40),
                sz(0x80),
                lz(0x41),
                sz(0x81)
            ]
        );
        let narrow = Expr::Call(Call {
            name: "f8".into(),
            args: Vec::new(),
            ty: Nullable::Value("usmallint".into()),
            start: None,
            length: None,
            instance: None,
        });
        let (r, _, _) = run(|l| l.expr16(&narrow));
        assert_eq!(
            r.unwrap_err(),
            "call to 'f8' used as a 16-bit value, but it returns 'utinyint' — a checker or linker bug, not a missing lowering rule"
        );
        let missing = Expr::Call(Call {
            name: "zz".into(),
            args: Vec::new(),
            ty: Nullable::Value("usmallint".into()),
            start: None,
            length: None,
            instance: None,
        });
        let (r, _, _) = run(|l| l.expr16(&missing));
        assert!(
            r.unwrap_err()
                .starts_with("call to 'zz' resolves to nothing")
        );
    }

    #[test]
    fn expr_to16_widens_or_refuses() {
        let (r, _, _) = run(|l| l.expr_to16(&var("a", "usmallint")));
        assert_eq!(ok(r), 0x10);
        let (r, p, _) = run(|l| l.expr_to16(&var("n", "utinyint")));
        assert_eq!(ok(r), 0x80);
        assert_eq!(p, [lda_zp(0x14), sz(0x80), lda_imm(0), sz(0x81)]);
        let (r, _, _) = run(|l| l.expr_to16(&var("flag", "bool")));
        assert_eq!(
            r.unwrap_err(),
            "'ref' is 'bool': can't widen a bool into a 16-bit value"
        );
        let (r, _, _) = run(|l| l.expr_to16(&var("neg", "tinyint")));
        assert!(r.unwrap_err().contains("sign-extension isn't lowered"));
        let untyped = Expr::Ref(Ref {
            name: "a".into(),
            ty: jsnum::Nullable::Absent,
            start: None,
            length: None,
        });
        let (r, _, _) = run(|l| l.expr_to16(&untyped));
        assert_eq!(
            r.unwrap_err(),
            "'ref': no type on this IR node — the checker/linker should have set one"
        );
        let (r, _, _) = run(|l| l.expr_to16(&var("a", "ulargeint")));
        assert!(r.unwrap_err().contains("only an 8-bit value can widen"));
    }

    #[test]
    fn store16_into_shapes() {
        let case = |node: Expr| run(|l| l.store16_into(&node, 0x300)).1;
        assert_eq!(
            case(konst(0x1234, "usmallint")),
            [
                lda_imm(0x34),
                sta_addr(0x300),
                lda_imm(0x12),
                sta_addr(0x301)
            ]
        );
        assert_eq!(
            case(konst(0x0505, "usmallint")),
            [lda_imm(5), sta_addr(0x300), sta_addr(0x301)]
        );
        assert_eq!(
            case(var("s", "string")),
            [
                lda_imm_lo("__8bs_arr_s"),
                sta_addr(0x300),
                lda_imm_hi("__8bs_arr_s"),
                sta_addr(0x301)
            ]
        );
        assert_eq!(
            case(var("a", "usmallint")),
            [
                lda_addr(0x10),
                sta_addr(0x300),
                lda_addr(0x11),
                sta_addr(0x301)
            ]
        );
        assert_eq!(case(literal(1))[0], lda_imm_lo("__8bs_str_1"));
        let sum = bin(
            "+",
            var("a", "usmallint"),
            konst(1, "usmallint"),
            "usmallint",
        );
        assert_eq!(
            case(sum)[0],
            instr("CLC", AddressingMode::Implied, None, None)
        );
        assert_eq!(
            case(var("n", "utinyint")),
            [lda_zp(0x14), sta_addr(0x300), lda_imm(0), sta_addr(0x301)]
        );
        let (r, _, next) = run(|l| l.store16_into(&var("flag", "bool"), 0x300));
        assert_eq!(
            r.unwrap_err(),
            "'ref' is 'bool': can't widen a bool into a 16-bit value"
        );
        assert_eq!(next, 0x80);
        let shifted = bin(
            ">>",
            var("a", "usmallint"),
            konst(8, "utinyint"),
            "usmallint",
        );
        let (r, p, next) = run(|l| l.store16_into(&shifted, 0x300));
        ok(r);
        assert_eq!(p[0], lda_zp(0x10));
        assert_eq!(next, 0x80);
    }

    #[test]
    fn inc_dec_shapes() {
        let b = Binding {
            address: 0x14,
            ty: "utinyint".into(),
        };
        let go = |value: Expr, binding: &Binding| {
            let (r, p, _) = run(|l| l.emit_inc_dec("n", binding, &value));
            (ok(r), p)
        };
        let inc = |n| zp("INC", n);
        let n = |t| var("n", t);
        let (hit, p) = go(
            bin("+", n("utinyint"), konst(1, "utinyint"), "utinyint"),
            &b,
        );
        assert!(hit);
        assert_eq!(p, [inc(0x14)]);
        let (hit, p) = go(
            bin("+", konst(2, "utinyint"), n("utinyint"), "utinyint"),
            &b,
        );
        assert!(hit);
        assert_eq!(p, [inc(0x14), inc(0x14)]);
        let (hit, p) = go(
            bin("-", n("utinyint"), konst(1, "utinyint"), "utinyint"),
            &b,
        );
        assert!(hit);
        assert_eq!(p, [zp("DEC", 0x14)]);
        assert!(
            !go(
                bin("-", konst(1, "utinyint"), n("utinyint"), "utinyint"),
                &b
            )
            .0
        );
        assert!(
            !go(
                bin("+", n("utinyint"), konst(3, "utinyint"), "utinyint"),
                &b
            )
            .0
        );
        assert!(
            !go(
                bin("+", n("utinyint"), konst(0, "utinyint"), "utinyint"),
                &b
            )
            .0
        );
        assert!(
            !go(
                bin("*", n("utinyint"), konst(1, "utinyint"), "utinyint"),
                &b
            )
            .0
        );
        assert!(!go(konst(1, "utinyint"), &b).0);
        let high = Binding {
            address: 0x200,
            ty: "utinyint".into(),
        };
        assert!(
            !go(
                bin("+", n("utinyint"), konst(1, "utinyint"), "utinyint"),
                &high
            )
            .0
        );
    }

    #[test]
    fn binop16_dispatch() {
        let a = || var("a", "usmallint");
        let (r, p, _) = run(|l| l.binop16(&bin("+", a(), konst(0x0102, "usmallint"), "usmallint")));
        assert_eq!(ok(r), 0x80);
        assert_eq!(
            p,
            [
                instr("CLC", AddressingMode::Implied, None, None),
                lda_zp(0x10),
                imm("ADC", 2),
                sta_addr(0x80),
                lda_zp(0x11),
                imm("ADC", 1),
                sta_addr(0x81)
            ]
        );
        let (r, _, _) = run(|l| l.binop16(&bin("&", a(), a(), "usmallint")));
        assert_eq!(ok(r), 0x80);
        let (r, _, _) = run(|l| l.binop16(&bin("<<", a(), konst(1, "utinyint"), "usmallint")));
        assert_eq!(ok(r), 0x80);
        let (r, _, _) = run(|l| l.binop16(&bin("/", a(), a(), "usmallint")));
        assert_eq!(
            r.unwrap_err(),
            "no 16-bit instruction-selection rule yet for the '/' operator — only +, -, *, bitwise &/|/^, and constant-amount shifts are lowered at 16 bits"
        );
        // '*' goes through the control-flow methods, still stubs here.
        let (r, _, _) = run(|l| l.binop16(&bin("*", a(), a(), "usmallint")));
        assert!(
            r.unwrap_err()
                .starts_with("a '*' reached instruction selection with no multiply routine placed")
        );
    }

    #[test]
    fn bitwise16_constant_and_variable() {
        let a = || var("a", "usmallint");
        let (r, p, next) =
            run(|l| l.bitwise16(&bin("|", a(), konst(0x1234, "usmallint"), "usmallint")));
        assert_eq!(ok(r), 0x80);
        assert_eq!(next, 0x82);
        assert_eq!(
            p,
            [
                lda_zp(0x10),
                imm("ORA", 0x34),
                sta_addr(0x80),
                lda_zp(0x11),
                imm("ORA", 0x12),
                sta_addr(0x81)
            ]
        );
        let b = || var("b", "usmallint");
        let (r, p, _) = run(|l| l.bitwise16(&bin("^", a(), b(), "usmallint")));
        assert_eq!(ok(r), 0x80);
        assert_eq!(
            p,
            [
                lda_zp(0x10),
                zp("EOR", 0x12),
                sta_addr(0x80),
                lda_zp(0x11),
                zp("EOR", 0x13),
                sta_addr(0x81)
            ]
        );
        let (_, p, _) = run(|l| l.bitwise16(&bin("&", a(), b(), "usmallint")));
        assert_eq!(p[1], zp("AND", 0x12));
    }

    #[test]
    fn add_sub16_into_three_shapes() {
        let a = || var("a", "usmallint");
        let b = || var("b", "usmallint");
        let (r, p, next) = run(|l| l.add_sub16_into(&bin("-", a(), b(), "usmallint"), 0x50));
        ok(r);
        assert_eq!(next, 0x80);
        assert_eq!(
            p,
            [
                instr("SEC", AddressingMode::Implied, None, None),
                lda_zp(0x10),
                zp("SBC", 0x12),
                sta_addr(0x50),
                lda_zp(0x11),
                zp("SBC", 0x13),
                sta_addr(0x51)
            ]
        );
        let (_, p, _) = run(|l| {
            l.add_sub16_into(
                &bin("+", konst(0x0301, "usmallint"), b(), "usmallint"),
                0x50,
            )
        });
        assert_eq!(p[1..3], [lda_zp(0x12), imm("ADC", 1)]);
        let (_, p, _) = run(|l| {
            l.add_sub16_into(
                &bin("-", konst(0x0301, "usmallint"), b(), "usmallint"),
                0x50,
            )
        });
        // A constant left under '-' is evaluated as a pair of its own.
        assert_eq!(p[0], lda_imm(1));
        let (_, p, _) = run(|l| {
            l.add_sub16_into(
                &bin("-", a(), konst(0xffff, "usmallint"), "usmallint"),
                0x50,
            )
        });
        assert_eq!(p[2], imm("SBC", 0xff));
        assert_eq!(p[5], imm("SBC", 0xff));
    }

    #[test]
    fn shift16_amounts() {
        let a = || var("a", "usmallint");
        let shift =
            |op: &str, n: i64| run(|l| l.shift16(&bin(op, a(), konst(n, "utinyint"), "usmallint")));
        let copy = [lda_zp(0x10), sz(0x80), lda_zp(0x11), sz(0x81)];
        let (r, p, _) = shift("<<", 2);
        assert_eq!(ok(r), 0x80);
        assert_eq!(
            p[4..],
            [
                zp("ASL", 0x80),
                zp("ROL", 0x81),
                zp("ASL", 0x80),
                zp("ROL", 0x81)
            ]
        );
        assert_eq!(p[..4], copy);
        let (_, p, _) = shift(">>", 9);
        assert_eq!(
            p[4..],
            [
                lda_zp(0x81),
                sz(0x80),
                lda_imm(0),
                sz(0x81),
                zp("LSR", 0x81),
                zp("ROR", 0x80)
            ]
        );
        let (_, p, _) = shift("<<", 8);
        assert_eq!(p[4..], [lda_zp(0x80), sz(0x81), lda_imm(0), sz(0x80)]);
        let (_, p, _) = shift(">>", 16);
        assert_eq!(p[4..], [lda_imm(0), sz(0x80), sz(0x81)]);
        let (r, _, _) = run(|l| l.shift16(&bin("<<", a(), var("n", "utinyint"), "usmallint")));
        assert_eq!(
            r.unwrap_err(),
            "the '<<' operator needs a compile-time shift amount — a runtime amount isn't lowered (index a table of masks instead)"
        );
    }

    #[test]
    fn string_length_and_byte() {
        let len = Expr::StringLength(StringLength {
            string: Box::new(var("s", "string")),
            ty: "utinyint".into(),
            start: None,
            length: None,
        });
        let (r, p, _) = run(|l| l.string_length(&len));
        ok(r);
        assert_eq!(p.len(), 6);
        assert_eq!(p[4], imm("LDY", 0));
        assert_eq!(p[5], indirect_y("LDA", 0x80));
        let byte = Expr::StringByte(StringByte {
            string: Box::new(literal(0)),
            index: Box::new(konst(2, "utinyint")),
            ty: "utinyint".into(),
        });
        let (r, p, next) = run(|l| l.string_byte(&byte));
        ok(r);
        assert_eq!(next, 0x80);
        assert_eq!(
            p[4..],
            [
                lda_imm(2),
                instr("TAY", AddressingMode::Implied, None, None),
                instr("INY", AddressingMode::Implied, None, None),
                indirect_y("LDA", 0x80)
            ]
        );
    }

    #[test]
    fn array_target_resolves_or_refuses() {
        let (r, _, _) = run(|l| l.array_target(&at("bytes", konst(0, "utinyint"), "utinyint")));
        assert_eq!(ok(r), "__8bs_arr_bytes");
        let (r, _, _) = run(|l| l.array_target(&at("zz", konst(0, "utinyint"), "utinyint")));
        assert!(r.unwrap_err().starts_with("'zz' resolves to no array"));
    }

    #[test]
    fn array_pointer_adds_the_wide_index() {
        let (r, p, _) = run(|l| l.array_pointer("L", &var("a", "usmallint"), 3));
        assert_eq!(ok(r), 0x80);
        assert_eq!(
            p,
            [
                instr("CLC", AddressingMode::Implied, None, None),
                imm_byte("L", Half::Lo, 3),
                zp("ADC", 0x10),
                sz(0x80),
                imm_byte("L", Half::Hi, 3),
                zp("ADC", 0x11),
                sz(0x81)
            ]
        );
    }

    #[test]
    fn array_pointer16_doubles_the_index() {
        let (r, p, _) = run(|l| l.array_pointer16("L", &var("a", "usmallint")));
        assert_eq!(ok(r), 0x80);
        assert_eq!(
            p[..4],
            [
                lda_addr(0x10),
                sta_addr(0x82),
                lda_addr(0x11),
                sta_addr(0x83)
            ]
        );
        assert_eq!(p[4], zp("ASL", 0x82));
        assert_eq!(p[5], zp("ROL", 0x83));
        assert_eq!(p[7], imm_byte("L", Half::Lo, 0));
        assert_eq!(p[9], sz(0x80));
        assert_eq!(p[12], sz(0x81));
    }

    #[test]
    fn store_index_byte_elements() {
        let n = || var("n", "utinyint");
        let (r, p, _) = run(|l| {
            l.store_index(&store(
                "bytes",
                konst(2, "utinyint"),
                konst(7, "utinyint"),
                "utinyint",
            ))
        });
        ok(r);
        assert_eq!(
            p,
            [
                lda_imm(7),
                imm("LDY", 2),
                indexed("STA", "__8bs_arr_bytes", 0)
            ]
        );
        // A plain ref index with a pure value skips the temp.
        let (_, p, next) =
            run(|l| l.store_index(&store("bytes", n(), konst(7, "utinyint"), "utinyint")));
        assert_eq!(
            p,
            [
                lda_imm(7),
                zp("LDY", 0x14),
                indexed("STA", "__8bs_arr_bytes", 0)
            ]
        );
        assert_eq!(next, 0x80);
        // `n + 250` splits into a Y index and an address offset.
        let (_, p, _) = run(|l| {
            l.store_index(&store(
                "bytes",
                bin("+", n(), konst(250, "utinyint"), "usmallint"),
                konst(1, "utinyint"),
                "utinyint",
            ))
        });
        assert_eq!(p[2], indexed("STA", "__8bs_arr_bytes", 250));
        // A value that may write (a call) forces the temp form.
        let call = Expr::Call(Call {
            name: "f16".into(),
            args: Vec::new(),
            ty: Nullable::Value("utinyint".into()),
            start: None,
            length: None,
            instance: None,
        });
        let (r, _, _) = run(|l| l.store_index(&store("bytes", n(), call.clone(), "utinyint")));
        // expr8 of a 1-byte call reaches the stubbed control-flow side only for 16-bit; here it is call_site.
        ok(r);
        // A 16-bit index uses the pointer form.
        let (r, p, next) = run(|l| {
            l.store_index(&store(
                "bytes",
                var("a", "usmallint"),
                konst(9, "utinyint"),
                "utinyint",
            ))
        });
        ok(r);
        assert_eq!(next, 0x80);
        assert_eq!(p.last(), Some(&indirect_y("STA", 0x80)));
        let (r, _, _) = run(|l| {
            l.store_index(&store(
                "ro",
                konst(0, "utinyint"),
                konst(1, "utinyint"),
                "utinyint",
            ))
        });
        assert_eq!(
            r.unwrap_err(),
            "'ro' is a const array — data in the program, not RAM — and the checker should already have refused writing it"
        );
        let (r, _, _) = run(|l| {
            l.store_index(&store(
                "zz",
                konst(0, "utinyint"),
                konst(1, "utinyint"),
                "utinyint",
            ))
        });
        assert!(r.unwrap_err().starts_with("'zz' resolves to no array"));
    }

    #[test]
    fn store_index_temp_form_for_a_computed_index() {
        // An index the direct shapes can't take: parks in a temp while the value evaluates.
        let idx = bin("+", var("n", "utinyint"), var("n", "utinyint"), "utinyint");
        let (r, p, next) =
            run(|l| l.store_index(&store("bytes", idx, konst(1, "utinyint"), "utinyint")));
        ok(r);
        assert_eq!(next, 0x80);
        // The index lands in a temp, the value follows, then Y reads the temp back.
        let n = p.len();
        assert_eq!(p[n - 3], lda_imm(1));
        assert_eq!(p[n - 2], zp("LDY", 0x80));
        assert_eq!(p[n - 1], indexed("STA", "__8bs_arr_bytes", 0));
        assert_eq!(p[n - 4], sz(0x80));
    }

    #[test]
    fn store_index16_forms() {
        // Constant index inside Y's reach.
        let (r, p, next) = run(|l| {
            l.store_index(&store(
                "words",
                konst(3, "utinyint"),
                konst(0x0102, "usmallint"),
                "usmallint",
            ))
        });
        ok(r);
        assert_eq!(next, 0x80);
        assert_eq!(p[0..3], [lda_imm(2), sta_addr(0x80), lda_imm(1)]);
        assert!(p.contains(&imm("LDY", 6)));
        assert!(p.contains(&abs_y("STA", "__8bs_arr_words")));
        // Constant index past byte 255 folds into the address.
        let (_, p, _) = run(|l| {
            l.store_index(&store(
                "big",
                konst(150, "usmallint"),
                konst(1, "usmallint"),
                "usmallint",
            ))
        });
        assert!(p.contains(&indexed("STA", "__8bs_arr_big", 300)));
        // A runtime index into a wide array takes the pointer form.
        let (_, p, _) = run(|l| {
            l.store_index(&store(
                "big",
                var("n", "utinyint"),
                konst(1, "usmallint"),
                "usmallint",
            ))
        });
        assert_eq!(p.last(), Some(&indirect_y("STA", 0x82)));
        // A runtime byte index into a short array doubles in A.
        let (_, p, _) = run(|l| {
            l.store_index(&store(
                "words",
                var("n", "utinyint"),
                konst(1, "usmallint"),
                "usmallint",
            ))
        });
        assert!(p.contains(&acc("ASL")));
        // A 16-bit index into a short array is refused.
        let (r, _, _) = run(|l| {
            l.store_index(&store(
                "words",
                var("a", "usmallint"),
                konst(1, "usmallint"),
                "usmallint",
            ))
        });
        assert_eq!(
            r.unwrap_err(),
            "storing into 'words': a 2-byte element under a 16-bit index isn't written yet — an array of 2-byte elements has at most 128 of them, so index it with a utinyint"
        );
    }

    #[test]
    fn wide_elements_threshold() {
        let (r, _, _) = run(|l| l.wide_elements("big"));
        assert!(ok(r));
        let (r, _, _) = run(|l| l.wide_elements("words"));
        assert!(!ok(r));
        let (r, _, _) = run(|l| l.wide_elements("ro"));
        assert!(!ok(r));
        let (r, _, _) = run(|l| l.wide_elements("missing"));
        assert!(!ok(r));
    }

    #[test]
    fn index_into_y_shapes() {
        let (_, p, _) = run(|l| l.index_into_y(&konst(0x1ff, "usmallint")));
        assert_eq!(p, [imm("LDY", 0xff)]);
        let (_, p, _) = run(|l| l.index_into_y(&var("n", "utinyint")));
        assert_eq!(p, [zp("LDY", 0x14)]);
        let (_, p, _) = run(|l| l.index_into_y(&var("hi", "utinyint")));
        assert_eq!(
            p,
            [
                lda_addr(0x200),
                instr("TAY", AddressingMode::Implied, None, None)
            ]
        );
    }

    #[test]
    fn index_value_widths() {
        let (_, p, next) = run(|l| l.index_value(&var("a", "usmallint")));
        assert_eq!((p, next), ([lda_zp(0x10)].to_vec(), 0x80));
        let (_, p, _) = run(|l| l.index_value(&var("n", "utinyint")));
        assert_eq!(p, [lda_addr(0x14)]);
        let untyped = Expr::Ref(Ref {
            name: "n".into(),
            ty: jsnum::Nullable::Absent,
            start: None,
            length: None,
        });
        let (r, p, _) = run(|l| l.index_value(&untyped));
        ok(r);
        assert_eq!(p, [lda_addr(0x14)]);
    }

    #[test]
    fn index_read_forms() {
        let (_, p, _) = run(|l| l.index_read(&at("bytes", var("n", "utinyint"), "utinyint")));
        assert_eq!(p, [zp("LDY", 0x14), indexed("LDA", "__8bs_arr_bytes", 0)]);
        let (_, p, _) = run(|l| {
            l.index_read(&at(
                "bytes",
                bin("+", var("n", "utinyint"), konst(3, "utinyint"), "usmallint"),
                "utinyint",
            ))
        });
        assert_eq!(p[1], indexed("LDA", "__8bs_arr_bytes", 3));
        let (r, p, next) = run(|l| l.index_read(&at("bytes", var("a", "usmallint"), "utinyint")));
        ok(r);
        assert_eq!(next, 0x80);
        assert_eq!(p.last(), Some(&indirect_y("LDA", 0x80)));
    }

    #[test]
    fn index_read16_forms() {
        let (r, p, _) = run(|l| l.index_read16(&at("words", konst(2, "utinyint"), "usmallint")));
        assert_eq!(ok(r), 0x80);
        assert_eq!(
            p,
            [
                imm("LDY", 4),
                abs_y("LDA", "__8bs_arr_words"),
                sz(0x80),
                instr("INY", AddressingMode::Implied, None, None),
                abs_y("LDA", "__8bs_arr_words"),
                sz(0x81)
            ]
        );
        let (_, p, _) = run(|l| l.index_read16(&at("big", konst(200, "usmallint"), "usmallint")));
        assert_eq!(p[1], indexed("LDA", "__8bs_arr_big", 400));
        let (r, p, next) = run(|l| l.index_read16(&at("big", var("n", "utinyint"), "usmallint")));
        assert_eq!(ok(r), 0x80);
        assert_eq!(next, 0x82);
        assert!(p.contains(&indirect_y("LDA", 0x82)));
        let (_, p, _) = run(|l| l.index_read16(&at("words", var("n", "utinyint"), "usmallint")));
        assert!(p.contains(&acc("ASL")));
    }

    #[test]
    fn call_site_stores_each_argument() {
        let call = Call {
            name: "f8".into(),
            args: vec![konst(5, "utinyint"), var("a", "usmallint")],
            ty: Nullable::Absent,
            start: None,
            length: None,
            instance: None,
        };
        let (r, p, next) = run(|l| l.call_site(&call));
        ok(r);
        assert_eq!(next, 0x80);
        assert_eq!(
            p,
            [
                lda_imm(5),
                sz(0x30),
                lda_addr(0x10),
                sta_addr(0x32),
                lda_addr(0x11),
                sta_addr(0x33),
                instr("JSR", AddressingMode::Absolute, None, Some("f8_label"))
            ]
        );
        let bad = Call {
            args: Vec::new(),
            ..call.clone()
        };
        let (r, _, _) = run(|l| l.call_site(&bad));
        assert_eq!(
            r.unwrap_err(),
            "call to 'f8': 0 argument(s) but the function has 2 parameter(s) — the linker should already have matched these (completeCall)"
        );
        let missing = Call {
            name: "zz".into(),
            ..call
        };
        let (r, _, _) = run(|l| l.call_site(&missing));
        assert!(
            r.unwrap_err()
                .starts_with("call to 'zz' resolves to nothing")
        );
    }
}
