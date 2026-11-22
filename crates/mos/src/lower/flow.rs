//! Port of mos/lower/index.ts `:1337-2180`: operands and arithmetic selection,
//! conditions, statements, `asm6502` operands, string copy, memory access and
//! the control-flow statements.

use jsnum::{hex_upper, to_int32};
use mos_ir::{Binop, Expr, For, If, Local, MemoryWrite, Stmt, StringCopy, While};

use super::{
    Binding, BlockRange, BranchPlan, Declared, LoopLabels, Lowerer, SETS_FLAGS_FROM_A, addr_mode,
    branch, cmp_zp, const_value, expr_kind, expr_type, has_type, instr, is_comparison_operator,
    is_const_num, is_equality_operator, is_ordering_operator, is_pure, is_signed, jmp, label,
    lda_imm, lda_zp, match_const_fill, mirror, negate, order_branch_if_true, require8_bit,
    require16_bit, sta_addr, sta_zp,
};
use crate::asm::assemble::{Directive, Half, Operand};
use crate::asm::encode::{AddressingMode, OPCODES};
use crate::asm::parse::parse_asm;
use crate::provenance::SourceSpan;
use crate::startup::multiply::{MULTIPLY_LABEL, MultiplyCells};
use crate::startup::waitframe::WAIT_FRAME_LABEL;
use crate::types::storage_bytes;

/// `value & 0xff` on a JS number.
fn low_byte(value: i64) -> i64 {
    i64::from(to_int32(value as f64) & 0xff)
}

/// The `start` and `length` a statement carries, when it has a `start`.
fn statement_span(node: &Stmt) -> Option<(i64, i64)> {
    match node {
        Stmt::Asm(n) => Some((n.start, n.length)),
        Stmt::Assign(n) => n.start.map(|s| (s, n.length.unwrap_or(0))),
        Stmt::Block(n) => n.start.map(|s| (s, n.length.unwrap_or(0))),
        Stmt::Break(n) => Some((n.start, n.length)),
        Stmt::Call(n) => n.start.map(|s| (s, n.length.unwrap_or(0))),
        Stmt::Continue(n) => Some((n.start, n.length)),
        Stmt::For(n) => n.start.map(|s| (s, n.length.unwrap_or(0))),
        Stmt::If(n) => Some((n.start, n.length)),
        Stmt::Local(n) => n.start.map(|s| (s, n.length.unwrap_or(0))),
        Stmt::MemoryRead(n) => Some((n.start, n.length)),
        Stmt::MemoryWrite(n) => Some((n.start, n.length)),
        Stmt::Return(n) => Some((n.start, n.length)),
        Stmt::StoreIndex(n) => Some((n.start, n.length)),
        Stmt::WaitFrame(n) => Some((n.start, n.length)),
        Stmt::While(n) => Some((n.start, n.length)),
        Stmt::PortWrite(n) => Some((n.start, n.length)),
        Stmt::StringCopy(n) => Some((n.start, n.length)),
        Stmt::NamespaceCall(n) => Some((n.start, n.length)),
        Stmt::PortRead(n) => Some((n.start, n.length)),
    }
}

/// The `kind` of a statement node.
fn statement_kind(node: &Stmt) -> &'static str {
    match node {
        Stmt::Asm(_) => "asm",
        Stmt::Assign(_) => "assign",
        Stmt::Block(_) => "block",
        Stmt::Break(_) => "break",
        Stmt::Call(_) => "call",
        Stmt::Continue(_) => "continue",
        Stmt::For(_) => "for",
        Stmt::If(_) => "if",
        Stmt::Local(_) => "local",
        Stmt::MemoryRead(_) => "memoryRead",
        Stmt::MemoryWrite(_) => "memoryWrite",
        Stmt::Return(_) => "return",
        Stmt::StoreIndex(_) => "storeIndex",
        Stmt::WaitFrame(_) => "waitFrame",
        Stmt::While(_) => "while",
        Stmt::PortWrite(_) => "portWrite",
        Stmt::StringCopy(_) => "stringCopy",
        Stmt::NamespaceCall(_) => "namespaceCall",
        Stmt::PortRead(_) => "portRead",
    }
}

fn not_binop(what: &str) -> String {
    format!("{what}: not a binary operation — an instruction-selection bug, not a missing rule")
}

impl Lowerer<'_> {
    /// Both operands evaluated, the left parked in a fresh temporary and the
    /// right left in A.
    ///
    /// # Errors
    /// A `LowerError` text from the operands, or the allocator's.
    pub fn emit_operands(&mut self, left: &Expr, right: &Expr, what: &str) -> Result<i64, String> {
        self.expr(left)?;
        let temp = self.alloc(&format!("a temporary for the left side of {what}"))?;
        self.emit([sta_zp(temp)]);
        self.expr(right)?;
        Ok(temp)
    }

    /// An 8-bit binary operation into A.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn binop(&mut self, node: &Expr) -> Result<(), String> {
        let Expr::Binop(Binop {
            operator,
            left,
            right,
            ..
        }) = node
        else {
            return Err(not_binop("binop"));
        };
        let operator = operator.as_str();
        if operator == "&&" || operator == "||" {
            self.materialize_bool(node)?;
            return Ok(());
        }
        if is_comparison_operator(operator) {
            self.materialize_bool(node)?;
            return Ok(());
        }
        if operator == "*" {
            self.multiply_into(node)?;
            let result = self.require_multiply()?.result;
            self.emit([lda_zp(result)]);
            return Ok(());
        }
        if operator == "%" {
            return self.modulo8(node);
        }
        if operator == "/" {
            return Err("the '/' operator isn't lowered yet — the 6502 has no hardware divide, and nothing on this backend's critical path needs one ('%' subtracts instead)".to_string());
        }
        if operator == "&" || operator == "|" || operator == "^" {
            return self.bitwise8(node);
        }
        if operator == "<<" || operator == ">>" {
            return self.shift8(node);
        }
        if operator != "+" && operator != "-" {
            return Err(format!(
                "no instruction-selection rule yet for the '{operator}' operator"
            ));
        }
        let carry = if operator == "+" {
            instr("CLC", AddressingMode::Implied, None, None)
        } else {
            instr("SEC", AddressingMode::Implied, None, None)
        };
        let mnemonic = if operator == "+" { "ADC" } else { "SBC" };
        if let Some((mode, value)) = self.simple_operand(right)? {
            self.expr(left)?;
            self.emit([carry, instr(mnemonic, mode, Some(value), None)]);
            return Ok(());
        }
        if operator == "+"
            && let Some((mode, value)) = self.simple_operand(left)?
            && (matches!(**left, Expr::Const(_)) || is_pure(Some(right)))
        {
            self.expr(right)?;
            self.emit([carry, instr(mnemonic, mode, Some(value), None)]);
            return Ok(());
        }
        let mark = self.locals.mark();
        let temp = self.emit_operands(left, right, &format!("'{operator}'"))?;
        if operator == "+" {
            self.emit([
                instr("CLC", AddressingMode::Implied, None, None),
                instr("ADC", AddressingMode::Zeropage, Some(temp), None),
            ]);
        } else {
            let right_temp = self.alloc("a temporary for the right side of '-'")?;
            self.emit([
                sta_zp(right_temp),
                lda_zp(temp),
                instr("SEC", AddressingMode::Implied, None, None),
                instr("SBC", AddressingMode::Zeropage, Some(right_temp), None),
            ]);
        }
        self.locals.release(mark);
        Ok(())
    }

    /// Whether the last instruction emitted left Z/N describing A.
    ///
    /// # Errors
    /// Never: the `Result` keeps the stub's signature.
    pub fn last_sets_flags_from_a(&mut self) -> Result<bool, String> {
        let Some(Directive::Instruction { mnemonic, mode, .. }) = self.program.last() else {
            return Ok(false);
        };
        if *mode == AddressingMode::Accumulator {
            return Ok(true);
        }
        Ok(SETS_FLAGS_FROM_A.contains(&mnemonic.as_str()))
    }

    /// An operand ADC/SBC/CMP/AND/ORA/EOR can read directly, or `None`.
    ///
    /// # Errors
    /// The `LowerError` text when a `ref` resolves to nothing.
    pub fn simple_operand(&mut self, node: &Expr) -> Result<Option<(AddressingMode, i64)>, String> {
        if is_const_num(Some(node), None) {
            let value = const_value(node).unwrap_or(0);
            return Ok(Some((AddressingMode::Immediate, low_byte(value))));
        }
        if let Expr::Ref(r) = node {
            let address = self.binding(&r.name)?.address;
            return Ok(Some((addr_mode(address), address)));
        }
        Ok(None)
    }

    /// The multiply routine's cells.
    ///
    /// # Errors
    /// The `LowerError` text when no routine was placed.
    pub fn require_multiply(&mut self) -> Result<MultiplyCells, String> {
        self.multiply.ok_or_else(|| {
            "a '*' reached instruction selection with no multiply routine placed — the placement scan (mos/startup/multiply.ts's usesMultiply) disagrees with the tree, a build() bug rather than a missing rule".to_string()
        })
    }

    /// Both operands into the shared routine's cells, then `JSR`.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn multiply_into(&mut self, node: &Expr) -> Result<(), String> {
        let Expr::Binop(Binop { left, right, .. }) = node else {
            return Err(not_binop("multiplyInto"));
        };
        let cells = self.require_multiply()?;
        let mark = self.locals.mark();
        let left_addr = self.expr_to16(left)?;
        let right_addr = self.expr_to16(right)?;
        self.emit([
            lda_zp(left_addr),
            sta_zp(cells.a),
            lda_zp(left_addr + 1),
            sta_zp(cells.a + 1),
        ]);
        self.emit([
            lda_zp(right_addr),
            sta_zp(cells.b),
            lda_zp(right_addr + 1),
            sta_zp(cells.b + 1),
        ]);
        self.emit([instr(
            "JSR",
            AddressingMode::Absolute,
            None,
            Some(MULTIPLY_LABEL),
        )]);
        self.locals.release(mark);
        Ok(())
    }

    /// `value % bound`, both 8-bit, by repeated subtraction.
    ///
    /// # Errors
    /// A `LowerError` text, or the allocator's.
    pub fn modulo8(&mut self, node: &Expr) -> Result<(), String> {
        let Expr::Binop(Binop { left, right, .. }) = node else {
            return Err(not_binop("modulo8"));
        };
        let mark = self.locals.mark();
        self.expr(left)?;
        let value = self.alloc("a temporary for the left side of '%'")?;
        self.emit([sta_zp(value)]);
        self.expr(right)?;
        let bound = self.alloc("a temporary for the right side of '%'")?;
        self.emit([sta_zp(bound)]);
        let loop_label = self.fresh_label("mod");
        let done = self.fresh_label("mod_done");
        self.emit([
            lda_zp(value),
            label(&loop_label),
            cmp_zp(bound),
            branch("BCC", &done),
        ]);
        self.emit([
            instr("SBC", AddressingMode::Zeropage, Some(bound), None),
            jmp(&loop_label),
            label(&done),
        ]);
        self.locals.release(mark);
        Ok(())
    }

    /// `&`, `|` and `^`.
    ///
    /// # Errors
    /// A `LowerError` text, or the allocator's.
    pub fn bitwise8(&mut self, node: &Expr) -> Result<(), String> {
        let Expr::Binop(Binop {
            operator,
            left,
            right,
            ..
        }) = node
        else {
            return Err(not_binop("bitwise8"));
        };
        let mnemonic = match operator.as_str() {
            "&" => "AND",
            "|" => "ORA",
            _ => "EOR",
        };
        if let Some((mode, value)) = self.simple_operand(right)? {
            self.expr(left)?;
            self.emit([instr(mnemonic, mode, Some(value), None)]);
            return Ok(());
        }
        if let Some((mode, value)) = self.simple_operand(left)?
            && (matches!(**left, Expr::Const(_)) || is_pure(Some(right)))
        {
            self.expr(right)?;
            self.emit([instr(mnemonic, mode, Some(value), None)]);
            return Ok(());
        }
        let mark = self.locals.mark();
        let temp = self.emit_operands(left, right, &format!("'{operator}'"))?;
        self.emit([instr(mnemonic, AddressingMode::Zeropage, Some(temp), None)]);
        self.locals.release(mark);
        Ok(())
    }

    /// A shift by a compile-time amount, unrolled on the accumulator.
    ///
    /// # Errors
    /// A `LowerError` text when the amount is not a constant.
    pub fn shift8(&mut self, node: &Expr) -> Result<(), String> {
        let Expr::Binop(Binop {
            operator,
            left,
            right,
            ..
        }) = node
        else {
            return Err(not_binop("shift8"));
        };
        let Some(amount) = const_value(right) else {
            return Err(format!(
                "the '{operator}' operator needs a compile-time shift amount — a runtime amount isn't lowered (index a table of masks instead)"
            ));
        };
        self.expr(left)?;
        if amount >= 8 {
            self.emit([lda_imm(0)]);
            return Ok(());
        }
        let mnemonic = if operator == "<<" { "ASL" } else { "LSR" };
        for _ in 0..amount {
            self.emit([instr(mnemonic, AddressingMode::Accumulator, None, None)]);
        }
        Ok(())
    }

    /// A unary operation into A.
    ///
    /// # Errors
    /// A `LowerError` text for an operator with no rule.
    pub fn unop(&mut self, node: &Expr) -> Result<(), String> {
        let Expr::Unop(u) = node else {
            return Err(not_binop("unop"));
        };
        if u.operator == "!" {
            return self.materialize_bool(node);
        }
        self.expr(&u.argument)?;
        match u.operator.as_str() {
            "~" => {
                self.emit([instr("EOR", AddressingMode::Immediate, Some(0xff), None)]);
            }
            "-" => {
                self.emit([
                    instr("EOR", AddressingMode::Immediate, Some(0xff), None),
                    instr("CLC", AddressingMode::Implied, None, None),
                    instr("ADC", AddressingMode::Immediate, Some(1), None),
                ]);
            }
            "+" => {}
            other => {
                return Err(format!(
                    "no instruction-selection rule yet for the unary '{other}' operator"
                ));
            }
        }
        Ok(())
    }

    /// A bool-typed expression evaluated to a plain 0/1 in A.
    ///
    /// # Errors
    /// A `LowerError` text from the condition.
    pub fn materialize_bool(&mut self, node: &Expr) -> Result<(), String> {
        let t = self.fresh_label("true");
        let end = self.fresh_label("end");
        self.branch_if_true(node, &t)?;
        self.emit([lda_imm(0), jmp(&end), label(&t), lda_imm(1), label(&end)]);
        Ok(())
    }

    /// Jumps to `target` iff `node` is true, and otherwise falls through.
    ///
    /// # Errors
    /// A `LowerError` text from the condition.
    pub fn branch_if_true(&mut self, node: &Expr, target: &str) -> Result<(), String> {
        self.condition(node, target, true)
    }

    /// Jumps to `target` iff `node` is false, and otherwise falls through.
    ///
    /// # Errors
    /// A `LowerError` text from the condition.
    pub fn branch_if_false(&mut self, node: &Expr, target: &str) -> Result<(), String> {
        self.condition(node, target, false)
    }

    /// The branch for one condition, as the flags allow.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn condition(&mut self, node: &Expr, target: &str, want_true: bool) -> Result<(), String> {
        if has_type(node) {
            require8_bit(expr_type(node), &format!("'{}'", expr_kind(node)))?;
        }
        if let Expr::Const(c) = node {
            if (low_byte(c.value) != 0) == want_true {
                self.emit([jmp(target)]);
            }
            return Ok(());
        }
        if let Expr::Unop(u) = node
            && u.operator == "!"
        {
            return self.condition(&u.argument, target, !want_true);
        }
        if let Expr::Binop(Binop {
            operator,
            left,
            right,
            ..
        }) = node
        {
            if operator == "&&" {
                if want_true {
                    let skip = self.fresh_label("and_skip");
                    self.branch_if_false(left, &skip)?;
                    self.branch_if_true(right, target)?;
                    self.emit([label(&skip)]);
                    return Ok(());
                }
                self.branch_if_false(left, target)?;
                self.branch_if_false(right, target)?;
                return Ok(());
            }
            if operator == "||" {
                if want_true {
                    self.branch_if_true(left, target)?;
                    self.branch_if_true(right, target)?;
                    return Ok(());
                }
                let skip = self.fresh_label("or_skip");
                self.branch_if_true(left, &skip)?;
                self.branch_if_false(right, target)?;
                self.emit([label(&skip)]);
                return Ok(());
            }
            if is_comparison_operator(operator) {
                return self.comparison_branch(node, target, want_true);
            }
        }
        self.expr(node)?;
        self.emit([branch(if want_true { "BNE" } else { "BEQ" }, target)]);
        Ok(())
    }

    /// A comparison branched straight off the flags.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn comparison_branch(
        &mut self,
        node: &Expr,
        target: &str,
        want_true: bool,
    ) -> Result<(), String> {
        let Expr::Binop(Binop {
            operator: node_operator,
            left,
            right,
            ..
        }) = node
        else {
            return Err(not_binop("comparisonBranch"));
        };
        let operator = if want_true {
            node_operator.as_str()
        } else {
            negate(node_operator).ok_or_else(|| {
                format!("no instruction-selection rule yet for the '{node_operator}' operator")
            })?
        };
        let left_type = expr_type(left).unwrap_or("");
        let right_type = expr_type(right).unwrap_or("");
        if is_ordering_operator(operator) && (is_signed(left_type) || is_signed(right_type)) {
            return Err(format!(
                "the '{node_operator}' comparison on a signed type isn't lowered yet — only unsigned ordering comparisons are implemented (equality/inequality work on either); this needs the N/V-flag branch tree, a separate design not settled yet"
            ));
        }
        let left_width = storage_bytes(expr_type(left));
        let right_width = storage_bytes(expr_type(right));
        let width = left_width.max(right_width);
        let mark = self.locals.mark();
        if width == 2 {
            let left_addr = self.expr_to16(left)?;
            let right_addr = self.expr_to16(right)?;
            if operator == "==" || operator == "!=" {
                let skip_high = self.fresh_label("cmp16_hi");
                self.emit([
                    lda_zp(left_addr),
                    cmp_zp(right_addr),
                    branch("BNE", &skip_high),
                ]);
                self.emit([
                    lda_zp(left_addr + 1),
                    cmp_zp(right_addr + 1),
                    label(&skip_high),
                ]);
                self.emit([branch(if operator == "==" { "BEQ" } else { "BNE" }, target)]);
            } else {
                let (lo, hi, other, mnemonic) = match operator {
                    "<" => (left_addr, left_addr + 1, right_addr, "BCC"),
                    ">=" => (left_addr, left_addr + 1, right_addr, "BCS"),
                    ">" => (right_addr, right_addr + 1, left_addr, "BCC"),
                    _ => (right_addr, right_addr + 1, left_addr, "BCS"),
                };
                self.emit([
                    lda_zp(lo),
                    cmp_zp(other),
                    lda_zp(hi),
                    instr("SBC", AddressingMode::Zeropage, Some(other + 1), None),
                ]);
                self.emit([branch(mnemonic, target)]);
            }
            self.locals.release(mark);
            return Ok(());
        }
        if width != 1 {
            return Err(format!(
                "the '{node_operator}' comparison operates on a {width}-byte type — only 1- and 2-byte comparisons are lowered yet"
            ));
        }
        let right_simple = self.simple_operand(right)?;
        let left_simple = self.simple_operand(left)?;
        let plan_for = |op: &str| {
            order_branch_if_true(op)
                .ok_or_else(|| format!("no instruction-selection rule yet for the '{op}' operator"))
        };
        let plan: BranchPlan;
        if let Some((mode, value)) = right_simple {
            self.expr(left)?;
            if mode == AddressingMode::Immediate
                && value == 0
                && is_equality_operator(operator)
                && self.last_sets_flags_from_a()?
            {
                self.emit([branch(if operator == "==" { "BEQ" } else { "BNE" }, target)]);
                self.locals.release(mark);
                return Ok(());
            }
            self.emit([instr("CMP", mode, Some(value), None)]);
            let mirrored = mirror(operator).ok_or_else(|| {
                format!("no instruction-selection rule yet for the '{operator}' operator")
            })?;
            plan = plan_for(mirrored)?;
        } else if let Some((mode, value)) = left_simple
            && (matches!(**left, Expr::Const(_)) || is_pure(Some(right)))
        {
            self.expr(right)?;
            if mode == AddressingMode::Immediate
                && value == 0
                && is_equality_operator(operator)
                && self.last_sets_flags_from_a()?
            {
                self.emit([branch(if operator == "==" { "BEQ" } else { "BNE" }, target)]);
                self.locals.release(mark);
                return Ok(());
            }
            self.emit([instr("CMP", mode, Some(value), None)]);
            plan = plan_for(operator)?;
        } else {
            let temp = self.emit_operands(left, right, &format!("'{node_operator}'"))?;
            self.emit([cmp_zp(temp)]);
            plan = plan_for(operator)?;
        }
        match plan {
            BranchPlan::Mnemonic(mnemonic) => {
                self.emit([branch(mnemonic, target)]);
            }
            BranchPlan::Double(skip_mnemonic, take_mnemonic) => {
                let skip = self.fresh_label("cmp_skip");
                self.emit([
                    branch(skip_mnemonic, &skip),
                    branch(take_mnemonic, target),
                    label(&skip),
                ]);
            }
            BranchPlan::Either(first, second) => {
                self.emit([branch(first, target), branch(second, target)]);
            }
        }
        self.locals.release(mark);
        Ok(())
    }

    /// One zero-page byte.
    ///
    /// # Errors
    /// The allocator's `ZpBudgetError` text.
    pub fn alloc(&mut self, what: &str) -> Result<i64, String> {
        self.locals.alloc(what)
    }

    /// A zero-page pair.
    ///
    /// # Errors
    /// The allocator's `ZpBudgetError` text.
    pub fn alloc16(&mut self, what: &str) -> Result<i64, String> {
        self.locals.alloc16(what)
    }

    /// Lowers a statement list, returning each statement's range of `program`.
    ///
    /// # Errors
    /// The first error a statement raises.
    pub fn block(&mut self, body: &[Stmt]) -> Result<Vec<BlockRange>, String> {
        let mark = self.locals.mark();
        let mut declared: Vec<Declared> = Vec::new();
        let mut ranges = Vec::new();
        for statement in body {
            let start = self.program.len();
            let previous_span = self.current_span.clone();
            if let Some((span_start, length)) = statement_span(statement) {
                let from_origin = self
                    .current_origin
                    .as_deref()
                    .filter(|o| !o.is_empty())
                    .and_then(|o| self.origin_files.get(o))
                    .filter(|f| !f.is_empty())
                    .cloned();
                let file = from_origin
                    .or_else(|| self.fn_file.clone().filter(|f| !f.is_empty()))
                    .unwrap_or_default();
                self.current_span = Some(SourceSpan {
                    file,
                    start: span_start,
                    length,
                });
            }
            let result = self.statement(statement)?;
            if let Some(result) = result {
                declared.push(result);
            }
            ranges.push(BlockRange {
                origin: match statement {
                    Stmt::Block(b) => b.origin.clone(),
                    _ => None,
                },
                start,
                end: self.program.len(),
            });
            self.current_span = previous_span;
        }
        self.unscope(&declared)?;
        self.locals.release(mark);
        Ok(ranges)
    }

    /// Puts every name a block's own locals shadowed back the way it found them.
    ///
    /// # Errors
    /// Never: the `Result` keeps the stub's signature.
    pub fn unscope(&mut self, declared: &[Declared]) -> Result<(), String> {
        for Declared { name, shadowed } in declared {
            if let Some(shadowed) = shadowed {
                self.symbols.insert(name.clone(), shadowed.clone());
            } else {
                self.symbols.shift_remove(name);
            }
            let depth = self.frame.get(name).copied().unwrap_or(1) - 1;
            if depth > 0 {
                self.frame.insert(name.clone(), depth);
            } else {
                self.frame.shift_remove(name);
            }
        }
        Ok(())
    }

    /// Binds a `local` in `symbols` and the frame, returning what it shadowed.
    fn declare(&mut self, name: &str, address: i64, ty: &str) -> Declared {
        let shadowed = self.symbols.get(name).cloned();
        self.symbols.insert(
            name.to_string(),
            Binding {
                address,
                ty: ty.to_string(),
            },
        );
        let depth = self.frame.get(name).copied().unwrap_or(0) + 1;
        self.frame.insert(name.to_string(), depth);
        Declared {
            name: name.to_string(),
            shadowed,
        }
    }

    /// Lowers one statement, returning what it declared.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn statement(&mut self, node: &Stmt) -> Result<Option<Declared>, String> {
        match node {
            Stmt::MemoryWrite(_) => {
                self.memory_write(node)?;
                Ok(None)
            }
            Stmt::Assign(assign) => {
                let binding = self.binding(&assign.target)?;
                let width = storage_bytes(Some(&binding.ty));
                if width == 2 {
                    let mark = self.locals.mark();
                    self.store16_into(&assign.value, binding.address)?;
                    self.locals.release(mark);
                } else {
                    require8_bit(
                        Some(&binding.ty),
                        &format!("assignment to '{}'", assign.target),
                    )?;
                    if !self.emit_inc_dec(&assign.target, &binding, &assign.value)? {
                        self.expr8(&assign.value)?;
                        self.emit([sta_addr(binding.address)]);
                    }
                }
                Ok(None)
            }
            Stmt::Local(Local { name, ty, init, .. }) => {
                let width = storage_bytes(Some(ty));
                if width == 2 {
                    let address = self.alloc16(&format!("local '{name}'"))?;
                    let mark = self.locals.mark();
                    self.store16_into(init, address)?;
                    self.locals.release(mark);
                    return Ok(Some(self.declare(name, address, ty)));
                }
                require8_bit(Some(ty), &format!("local '{name}'"))?;
                self.expr8(init)?;
                let address = self.alloc(&format!("local '{name}'"))?;
                self.emit([sta_zp(address)]);
                Ok(Some(self.declare(name, address, ty)))
            }
            Stmt::Block(block) => {
                let previous_origin = self.current_origin.clone();
                if let Some(origin) = &block.origin {
                    self.current_origin = Some(origin.clone());
                }
                self.block(&block.body)?;
                self.current_origin = previous_origin;
                Ok(None)
            }
            Stmt::If(_) => {
                self.if_statement(node)?;
                Ok(None)
            }
            Stmt::While(_) => {
                self.while_statement(node)?;
                Ok(None)
            }
            Stmt::For(_) => {
                self.for_statement(node)?;
                Ok(None)
            }
            Stmt::Break(_) => {
                let Some(top) = self.loops.last() else {
                    return Err("break outside any loop — a checker bug, not a missing lowering rule".to_string());
                };
                let target = top.break_label.clone();
                self.emit([jmp(&target)]);
                Ok(None)
            }
            Stmt::Continue(_) => {
                let Some(top) = self.loops.last() else {
                    return Err("continue outside any loop — a checker bug, not a missing lowering rule".to_string());
                };
                let target = top.continue_label.clone();
                self.emit([jmp(&target)]);
                Ok(None)
            }
            Stmt::Return(ret) => {
                if let (Some(value), Some(pair)) = (&ret.value, self.return_pair) {
                    let mark = self.locals.mark();
                    self.store16_into(value, pair)?;
                    self.locals.release(mark);
                } else if let Some(value) = &ret.value {
                    self.expr8(value)?;
                }
                let exit = self.exit_label.clone();
                self.emit([jmp(&exit)]);
                Ok(None)
            }
            Stmt::Call(call) => {
                self.call_site(call)?;
                Ok(None)
            }
            Stmt::MemoryRead(read) => {
                self.memory_read(&Expr::MemoryRead(read.clone()))?;
                Ok(None)
            }
            Stmt::WaitFrame(_) => {
                self.emit([instr(
                    "JSR",
                    AddressingMode::Absolute,
                    None,
                    Some(WAIT_FRAME_LABEL),
                )]);
                Ok(None)
            }
            Stmt::StoreIndex(_) => {
                self.store_index(node)?;
                Ok(None)
            }
            Stmt::StringCopy(_) => {
                self.string_copy(node)?;
                Ok(None)
            }
            Stmt::Asm(asm) => {
                let id = self.fresh_label("asm");
                let block_id = id.strip_prefix("__8bs_").unwrap_or(&id);
                let parsed = parse_asm(&asm.text, block_id)?;
                let mut directives = Vec::with_capacity(parsed.len());
                for directive in &parsed {
                    directives.push(self.frame_operand(directive)?);
                }
                self.emit(directives);
                Ok(None)
            }
            Stmt::PortWrite(_) => Err("port.write is Z80 / SM83 port I/O — this 6502 has none; use memory.write for a memory-mapped register".to_string()),
            Stmt::NamespaceCall(_) | Stmt::PortRead(_) => Err(format!(
                "no instruction-selection rule yet for the '{}' statement — it lands in a later milestone",
                statement_kind(node)
            )),
        }
    }

    /// An `asm6502` operand that names the function's own frame becomes that
    /// slot's zero-page address.
    ///
    /// # Errors
    /// A `LowerError` text for a frame name used where it cannot be.
    pub fn frame_operand(&mut self, directive: &Directive) -> Result<Directive, String> {
        let Directive::Instruction {
            mnemonic,
            mode,
            operand: Some(Operand::Label { name, byte, offset }),
            prov,
        } = directive
        else {
            return Ok(directive.clone());
        };
        if !self.frame.contains_key(name) {
            return Ok(directive.clone());
        }
        let binding = self.binding(name)?;
        let address = binding.address + offset.unwrap_or(0);
        let context = format!("asm6502 names '{name}', a parameter or local of this function");
        let with = |mode: AddressingMode, value: i64| Directive::Instruction {
            mnemonic: mnemonic.clone(),
            mode,
            operand: Some(Operand::Value { value }),
            prov: prov.clone(),
        };
        if let Some(half) = byte {
            let value = match half {
                Half::Lo => i64::from(to_int32(address as f64) & 0xff),
                Half::Hi => i64::from((to_int32(address as f64) >> 8) & 0xff),
            };
            return Ok(with(*mode, value));
        }
        if *mode == AddressingMode::Immediate {
            return Err(format!(
                "{context}, as an immediate: write '{name}' for its value or '#<{name}' / '#>{name}' for a byte of its address"
            ));
        }
        if mnemonic == "JSR"
            || mnemonic == "JMP"
            || *mode == AddressingMode::Relative
            || *mode == AddressingMode::Indirect
        {
            return Err(format!(
                "{context}, where {mnemonic} needs an address to run: a frame slot is data, not code"
            ));
        }
        if address > 0xff {
            return Err(format!(
                "{context}, at ${} — past the zero page a frame slot is always placed in",
                hex_upper(address, 0)
            ));
        }
        let wanted = match mode {
            AddressingMode::Absolute => Some(AddressingMode::Zeropage),
            AddressingMode::AbsoluteX => Some(AddressingMode::ZeropageX),
            AddressingMode::AbsoluteY => Some(AddressingMode::ZeropageY),
            _ => None,
        };
        let has_form = |wanted: AddressingMode| {
            OPCODES
                .iter()
                .find(|(m, _)| *m == mnemonic)
                .is_some_and(|(_, forms)| forms.iter().any(|(am, _)| *am == wanted))
        };
        let mode = match wanted {
            Some(w) if has_form(w) => w,
            _ => *mode,
        };
        Ok(with(mode, address))
    }

    /// Copies a string into a `string<N>` buffer: the length byte, then that
    /// many characters, through two zero-page pointers.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn string_copy(&mut self, node: &Stmt) -> Result<(), String> {
        let Stmt::StringCopy(StringCopy { target, source, .. }) = node else {
            return Err("stringCopy: needs both a source and a target".to_string());
        };
        let mark = self.locals.mark();
        let to = self.expr16(target)?;
        let from = self.expr16(source)?;
        let loop_label = self.fresh_label("strcpy");
        let done = self.fresh_label("strcpy_done");
        let ind = AddressingMode::IndirectY;
        self.emit([instr("LDY", AddressingMode::Immediate, Some(0), None)]);
        self.emit([instr("LDA", ind, Some(from), None)]);
        self.emit([instr("STA", ind, Some(to), None)]);
        self.emit([instr("TAX", AddressingMode::Implied, None, None)]);
        self.emit([branch("BEQ", &done)]);
        self.emit([label(&loop_label)]);
        self.emit([instr("INY", AddressingMode::Implied, None, None)]);
        self.emit([instr("LDA", ind, Some(from), None)]);
        self.emit([instr("STA", ind, Some(to), None)]);
        self.emit([instr("DEX", AddressingMode::Implied, None, None)]);
        self.emit([branch("BNE", &loop_label)]);
        self.emit([label(&done)]);
        self.locals.release(mark);
        Ok(())
    }

    /// `memory.read(address)` into A.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn memory_read(&mut self, node: &Expr) -> Result<(), String> {
        let Expr::MemoryRead(read) = node else {
            return Err("memoryRead: no address to read from".to_string());
        };
        let address = &*read.address;
        if let Expr::Const(c) = address {
            let target = c.value;
            let mode = if target <= 0xff {
                AddressingMode::Zeropage
            } else {
                AddressingMode::Absolute
            };
            self.emit([instr("LDA", mode, Some(target), None)]);
            return Ok(());
        }
        require16_bit(expr_type(address), "memoryRead: a computed address")?;
        let mark = self.locals.mark();
        let pointer = self.expr16(address)?;
        self.emit([instr("LDY", AddressingMode::Immediate, Some(0), None)]);
        self.emit([instr("LDA", AddressingMode::IndirectY, Some(pointer), None)]);
        self.locals.release(mark);
        Ok(())
    }

    /// `memory.write(address, value)`.
    ///
    /// # Errors
    /// A `LowerError` text.
    pub fn memory_write(&mut self, statement: &Stmt) -> Result<(), String> {
        let Stmt::MemoryWrite(MemoryWrite { address, value, .. }) = statement else {
            return Err("memoryWrite: no address to write to".to_string());
        };
        if let Expr::Const(c) = address {
            self.expr8(value)?;
            let target = c.value;
            let mode = if target <= 0xff {
                AddressingMode::Zeropage
            } else {
                AddressingMode::Absolute
            };
            self.emit([instr("STA", mode, Some(target), None)]);
            return Ok(());
        }
        require16_bit(expr_type(address), "memoryWrite: a computed address")?;
        let mark = self.locals.mark();
        let pointer = self.expr16(address)?;
        self.expr8(value)?;
        self.emit([instr("LDY", AddressingMode::Immediate, Some(0), None)]);
        self.emit([instr("STA", AddressingMode::IndirectY, Some(pointer), None)]);
        self.locals.release(mark);
        Ok(())
    }

    /// `if`, with or without an `else`.
    ///
    /// # Errors
    /// A `LowerError` text from the test or either arm.
    pub fn if_statement(&mut self, node: &Stmt) -> Result<(), String> {
        let Stmt::If(If {
            test, then, r#else, ..
        }) = node
        else {
            return Err(format!(
                "no instruction-selection rule yet for the '{}' statement — it lands in a later milestone",
                statement_kind(node)
            ));
        };
        if let Some(else_body) = r#else.as_ref().filter(|b| !b.is_empty()) {
            let else_label = self.fresh_label("else");
            let end = self.fresh_label("endif");
            self.branch_if_false(test, &else_label)?;
            self.block(then)?;
            self.emit([jmp(&end), label(&else_label)]);
            self.block(else_body)?;
            self.emit([label(&end)]);
        } else {
            let end = self.fresh_label("endif");
            self.branch_if_false(test, &end)?;
            self.block(then)?;
            self.emit([label(&end)]);
        }
        Ok(())
    }

    /// `while`.
    ///
    /// # Errors
    /// A `LowerError` text from the test or the body.
    pub fn while_statement(&mut self, node: &Stmt) -> Result<(), String> {
        let Stmt::While(While { test, body, .. }) = node else {
            return Err(format!(
                "no instruction-selection rule yet for the '{}' statement — it lands in a later milestone",
                statement_kind(node)
            ));
        };
        let top = self.fresh_label("while");
        let end = self.fresh_label("endwhile");
        self.emit([label(&top)]);
        self.branch_if_false(test, &end)?;
        self.loops.push(LoopLabels {
            continue_label: top.clone(),
            break_label: end.clone(),
        });
        self.block(body)?;
        self.loops.pop();
        self.emit([jmp(&top), label(&end)]);
        Ok(())
    }

    /// `for`, or a constant fill when `emit_const_fill` matches.
    ///
    /// # Errors
    /// A `LowerError` text from any part of the loop.
    pub fn for_statement(&mut self, node: &Stmt) -> Result<(), String> {
        let Stmt::For(For {
            init,
            test,
            update,
            body,
            ..
        }) = node
        else {
            return Err(format!(
                "no instruction-selection rule yet for the '{}' statement — it lands in a later milestone",
                statement_kind(node)
            ));
        };
        if self.emit_const_fill(node)? {
            return Ok(());
        }
        let mark = self.locals.mark();
        let mut declared: Option<Declared> = None;
        if let Some(init) = init.as_option() {
            declared = self.statement(init)?;
        }
        let top = self.fresh_label("for");
        let cont = self.fresh_label("forcont");
        let end = self.fresh_label("endfor");
        self.emit([label(&top)]);
        if let Some(test) = test.as_option() {
            self.branch_if_false(test, &end)?;
        }
        self.loops.push(LoopLabels {
            continue_label: cont.clone(),
            break_label: end.clone(),
        });
        self.block(body)?;
        self.loops.pop();
        self.emit([label(&cont)]);
        if let Some(update) = update.as_option() {
            self.statement(update)?;
        }
        self.emit([jmp(&top), label(&end)]);
        if let Some(declared) = declared {
            self.unscope(&[declared])?;
        }
        self.locals.release(mark);
        Ok(())
    }

    /// `for (let i = 0; i < N; i++) memory.write(BASE + i, VALUE)` as page-sized
    /// `STA abs,X` loops.
    ///
    /// # Errors
    /// Never: the `Result` keeps the stub's signature.
    pub fn emit_const_fill(&mut self, node: &Stmt) -> Result<bool, String> {
        let Some(fill) = match_const_fill(node) else {
            return Ok(false);
        };
        let (base, count, value) = (fill.base, fill.count, fill.value);
        let pages = count.div_euclid(256);
        let rem = count.rem_euclid(256);
        self.emit([lda_imm(value)]);
        if pages > 0 || rem > 0 {
            self.emit([instr("LDX", AddressingMode::Immediate, Some(0), None)]);
        }
        let mode_for = |page_base: i64| {
            if page_base <= 0xff {
                AddressingMode::ZeropageX
            } else {
                AddressingMode::AbsoluteX
            }
        };
        for page in 0..pages {
            let page_base = base + page * 256;
            let top = self.fresh_label("fill");
            self.emit([label(&top)]);
            self.emit([instr("STA", mode_for(page_base), Some(page_base), None)]);
            self.emit([instr("INX", AddressingMode::Implied, None, None)]);
            self.emit([branch("BNE", &top)]);
        }
        if rem > 0 {
            let page_base = base + pages * 256;
            let top = self.fresh_label("fillrem");
            self.emit([label(&top)]);
            self.emit([instr("STA", mode_for(page_base), Some(page_base), None)]);
            self.emit([instr("INX", AddressingMode::Implied, None, None)]);
            self.emit([instr("CPX", AddressingMode::Immediate, Some(rem), None)]);
            self.emit([branch("BNE", &top)]);
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::Counters;
    use crate::lower::allocator::LocalAllocator;
    use crate::lower::{LowerOptions, ParamBinding};
    use indexmap::IndexMap;
    use jsnum::Nullable;
    use mos_ir::{Assign, Block, Break, Const, Continue, MemoryRead, Ref, Return, Unop, WaitFrame};

    fn konst(value: i64) -> Expr {
        Expr::Const(Const { value, ty: None })
    }

    fn typed(value: i64, ty: &str) -> Expr {
        Expr::Const(Const {
            value,
            ty: Some(ty.into()),
        })
    }

    fn reference(name: &str, ty: &str) -> Expr {
        Expr::Ref(Ref {
            name: name.into(),
            ty: jsnum::Nullable::Value(ty.into()),
            start: None,
            length: None,
        })
    }

    fn bin(op: &str, left: Expr, right: Expr, ty: &str) -> Expr {
        Expr::Binop(Binop {
            operator: op.into(),
            left: Box::new(left),
            right: Box::new(right),
            ty: Some(ty.into()),
        })
    }

    fn not(arg: Expr) -> Expr {
        Expr::Unop(Unop {
            operator: "!".into(),
            argument: Box::new(arg),
            ty: Some("bool".into()),
        })
    }

    fn options() -> LowerOptions {
        LowerOptions {
            globals: IndexMap::from([
                (
                    "g".to_string(),
                    Binding {
                        address: 0x10,
                        ty: "utinyint".into(),
                    },
                ),
                (
                    "big".to_string(),
                    Binding {
                        address: 0x300,
                        ty: "utinyint".into(),
                    },
                ),
                (
                    "w".to_string(),
                    Binding {
                        address: 0x30,
                        ty: "usmallint".into(),
                    },
                ),
                (
                    "s".to_string(),
                    Binding {
                        address: 0x40,
                        ty: "utinyint".into(),
                    },
                ),
            ]),
            locals: LocalAllocator::new(0x80, 0x90, &[]),
            params: vec![ParamBinding {
                name: "p".into(),
                ty: "utinyint".into(),
                address: 0x20,
            }],
            functions: IndexMap::new(),
            arrays: IndexMap::new(),
            multiply: None,
            return_pair: None,
            fn_name: None,
            fn_file: None,
            origin_files: IndexMap::new(),
        }
    }

    /// Runs `f` on a fresh `Lowerer` and returns its result with the program as text.
    fn run<T>(
        opts: &mut LowerOptions,
        f: impl FnOnce(&mut Lowerer<'_>) -> Result<T, String>,
    ) -> (Result<T, String>, Vec<String>) {
        let mut counters = Counters::default();
        let mut lowerer = Lowerer::new(opts, &mut counters);
        let result = f(&mut lowerer);
        (result, show(&lowerer.program))
    }

    fn show(program: &[Directive]) -> Vec<String> {
        program
            .iter()
            .map(|d| match d {
                Directive::Label { name, .. } => format!("{name}:"),
                Directive::Instruction {
                    mnemonic,
                    mode,
                    operand,
                    ..
                } => match operand {
                    None => format!("{mnemonic} {}", mode.as_str()),
                    Some(Operand::Value { value }) => {
                        format!("{mnemonic} {} {value}", mode.as_str())
                    }
                    Some(Operand::Label { name, .. }) => {
                        format!("{mnemonic} {} {name}", mode.as_str())
                    }
                },
                other => format!("{other:?}"),
            })
            .collect()
    }

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(ToString::to_string).collect()
    }

    fn u8ref(name: &str) -> Expr {
        reference(name, "utinyint")
    }

    fn brk() -> Stmt {
        Stmt::Break(Break {
            start: 0,
            length: 0,
        })
    }

    fn write_const(address: i64, value: i64) -> Stmt {
        Stmt::MemoryWrite(MemoryWrite {
            address: konst(address),
            value: konst(value),
            start: 1,
            length: 2,
        })
    }

    #[test]
    fn emit_operands_parks_the_left_side() {
        let mut o = options();
        let (r, p) = run(&mut o, |l| l.emit_operands(&u8ref("g"), &konst(7), "'+'"));
        assert_eq!(r, Ok(0x80));
        assert_eq!(
            p,
            lines(&["LDA zeropage 16", "STA zeropage 128", "LDA immediate 7"])
        );
    }

    #[test]
    fn binop_add_and_subtract_pick_the_cheapest_shape() {
        let mut o = options();
        let (r, p) = run(&mut o, |l| {
            l.binop(&bin("+", u8ref("g"), konst(3), "utinyint"))
        });
        assert_eq!(r, Ok(()));
        assert_eq!(
            p,
            lines(&["LDA zeropage 16", "CLC implied", "ADC immediate 3"])
        );
        // A simple left side with a pure right evaluates the right first.
        let (_, p) = run(&mut o, |l| {
            l.binop(&bin(
                "+",
                u8ref("g"),
                bin("&", u8ref("s"), u8ref("p"), "utinyint"),
                "utinyint",
            ))
        });
        assert_eq!(p[0], "LDA zeropage 64");
        assert_eq!(p[1], "AND zeropage 32");
        assert_eq!(p.last().unwrap(), "ADC zeropage 16");
        // Neither side simple: left parks in a temp, `-` swaps through a second temp.
        let both = bin(
            "-",
            bin("+", u8ref("g"), u8ref("s"), "utinyint"),
            bin("+", u8ref("p"), u8ref("s"), "utinyint"),
            "utinyint",
        );
        let (r, p) = run(&mut o, |l| l.binop(&both));
        assert_eq!(r, Ok(()));
        assert!(p.contains(&"STA zeropage 128".to_string()));
        assert!(p.ends_with(&lines(&[
            "STA zeropage 129",
            "LDA zeropage 128",
            "SEC implied",
            "SBC zeropage 129"
        ])));
        // The temporaries are released.
        assert_eq!(o.locals.mark(), 0x80);
    }

    #[test]
    fn binop_routes_the_other_operators() {
        let mut o = options();
        let (_, p) = run(&mut o, |l| {
            l.binop(&bin("&&", u8ref("g"), u8ref("s"), "bool"))
        });
        assert!(p.iter().any(|x| x.starts_with("__8bs_true_")));
        let (_, p) = run(&mut o, |l| {
            l.binop(&bin("<<", u8ref("g"), konst(2), "utinyint"))
        });
        assert_eq!(
            p,
            lines(&["LDA zeropage 16", "ASL accumulator", "ASL accumulator"])
        );
        let (_, p) = run(&mut o, |l| {
            l.binop(&bin("%", u8ref("g"), u8ref("s"), "utinyint"))
        });
        assert!(p.iter().any(|x| x.starts_with("__8bs_mod_")));
        let (_, p) = run(&mut o, |l| {
            l.binop(&bin("^", u8ref("g"), konst(1), "utinyint"))
        });
        assert_eq!(p, lines(&["LDA zeropage 16", "EOR immediate 1"]));
        let (r, _) = run(&mut o, |l| {
            l.binop(&bin("/", u8ref("g"), u8ref("s"), "utinyint"))
        });
        assert!(
            r.unwrap_err()
                .starts_with("the '/' operator isn't lowered yet")
        );
        let (r, _) = run(&mut o, |l| {
            l.binop(&bin("**", u8ref("g"), u8ref("s"), "utinyint"))
        });
        assert_eq!(
            r.unwrap_err(),
            "no instruction-selection rule yet for the '**' operator"
        );
        let (r, _) = run(&mut o, |l| {
            l.binop(&bin("*", u8ref("g"), u8ref("s"), "utinyint"))
        });
        assert!(
            r.unwrap_err()
                .starts_with("a '*' reached instruction selection")
        );
    }

    #[test]
    fn last_sets_flags_from_a_reads_the_final_directive() {
        let mut o = options();
        let (r, _) = run(&mut o, |l| l.last_sets_flags_from_a());
        assert_eq!(r, Ok(false));
        let (r, _) = run(&mut o, |l| {
            l.emit([lda_imm(1)]);
            l.last_sets_flags_from_a()
        });
        assert_eq!(r, Ok(true));
        let (r, _) = run(&mut o, |l| {
            l.emit([instr("LSR", AddressingMode::Accumulator, None, None)]);
            l.last_sets_flags_from_a()
        });
        assert_eq!(r, Ok(true));
        let (r, _) = run(&mut o, |l| {
            l.emit([sta_zp(1)]);
            l.last_sets_flags_from_a()
        });
        assert_eq!(r, Ok(false));
        let (r, _) = run(&mut o, |l| {
            l.emit([lda_imm(1), label("x")]);
            l.last_sets_flags_from_a()
        });
        assert_eq!(r, Ok(false));
    }

    #[test]
    fn simple_operand_takes_constants_and_bindings() {
        let mut o = options();
        let (r, _) = run(&mut o, |l| l.simple_operand(&konst(0x1ff)));
        assert_eq!(r, Ok(Some((AddressingMode::Immediate, 0xff))));
        let (r, _) = run(&mut o, |l| l.simple_operand(&u8ref("g")));
        assert_eq!(r, Ok(Some((AddressingMode::Zeropage, 0x10))));
        let (r, _) = run(&mut o, |l| l.simple_operand(&u8ref("big")));
        assert_eq!(r, Ok(Some((AddressingMode::Absolute, 0x300))));
        let (r, _) = run(&mut o, |l| {
            l.simple_operand(&bin("+", u8ref("g"), konst(1), "utinyint"))
        });
        assert_eq!(r, Ok(None));
        let (r, _) = run(&mut o, |l| l.simple_operand(&u8ref("nope")));
        assert!(r.unwrap_err().contains("resolves to nothing"));
    }

    #[test]
    fn require_multiply_and_multiply_into() {
        let mut o = options();
        let (r, _) = run(&mut o, |l| l.require_multiply());
        assert!(
            r.unwrap_err()
                .starts_with("a '*' reached instruction selection")
        );
        o.multiply = Some(MultiplyCells {
            a: 0x50,
            b: 0x52,
            result: 0x54,
        });
        let (r, _) = run(&mut o, |l| l.require_multiply());
        assert_eq!(r.unwrap().result, 0x54);
        // The operand widening is the wide unit's: its error comes through.
        let (r, _) = run(&mut o, |l| {
            l.multiply_into(&bin("*", u8ref("g"), u8ref("s"), "utinyint"))
        });
        assert_eq!(r, Ok(()));
        let (r, _) = run(&mut o, |l| l.multiply_into(&u8ref("g")));
        assert!(r.unwrap_err().starts_with("multiplyInto"));
    }

    #[test]
    fn modulo8_subtracts_in_a_loop() {
        let mut o = options();
        let (r, p) = run(&mut o, |l| {
            l.modulo8(&bin("%", u8ref("g"), u8ref("s"), "utinyint"))
        });
        assert_eq!(r, Ok(()));
        assert_eq!(
            p,
            lines(&[
                "LDA zeropage 16",
                "STA zeropage 128",
                "LDA zeropage 64",
                "STA zeropage 129",
                "LDA zeropage 128",
                "__8bs_mod_1:",
                "CMP zeropage 129",
                "BCC relative __8bs_mod_done_2",
                "SBC zeropage 129",
                "JMP absolute __8bs_mod_1",
                "__8bs_mod_done_2:",
            ])
        );
        assert_eq!(o.locals.mark(), 0x80);
    }

    #[test]
    fn bitwise8_uses_immediates_and_temps() {
        let mut o = options();
        let (_, p) = run(&mut o, |l| {
            l.bitwise8(&bin("|", u8ref("g"), u8ref("s"), "utinyint"))
        });
        assert_eq!(p, lines(&["LDA zeropage 16", "ORA zeropage 64"]));
        let (_, p) = run(&mut o, |l| {
            l.bitwise8(&bin("&", konst(15), u8ref("s"), "utinyint"))
        });
        assert_eq!(p, lines(&["LDA immediate 15", "AND zeropage 64"]));
        let both = bin(
            "^",
            bin("+", u8ref("g"), u8ref("s"), "utinyint"),
            bin("+", u8ref("p"), u8ref("s"), "utinyint"),
            "utinyint",
        );
        let (_, p) = run(&mut o, |l| l.bitwise8(&both));
        assert_eq!(p.last().unwrap(), "EOR zeropage 128");
        assert_eq!(o.locals.mark(), 0x80);
    }

    #[test]
    fn shift8_unrolls_and_refuses_runtime_amounts() {
        let mut o = options();
        let (_, p) = run(&mut o, |l| {
            l.shift8(&bin(">>", u8ref("g"), konst(2), "utinyint"))
        });
        assert_eq!(
            p,
            lines(&["LDA zeropage 16", "LSR accumulator", "LSR accumulator"])
        );
        let (_, p) = run(&mut o, |l| {
            l.shift8(&bin("<<", u8ref("g"), konst(8), "utinyint"))
        });
        assert_eq!(p, lines(&["LDA zeropage 16", "LDA immediate 0"]));
        let (r, _) = run(&mut o, |l| {
            l.shift8(&bin(">>", u8ref("g"), u8ref("s"), "utinyint"))
        });
        assert!(
            r.unwrap_err()
                .starts_with("the '>>' operator needs a compile-time shift amount")
        );
    }

    #[test]
    fn unop_covers_each_operator() {
        let mut o = options();
        let un = |op: &str| {
            Expr::Unop(Unop {
                operator: op.into(),
                argument: Box::new(u8ref("g")),
                ty: Some("utinyint".into()),
            })
        };
        let (_, p) = run(&mut o, |l| l.unop(&un("~")));
        assert_eq!(p, lines(&["LDA zeropage 16", "EOR immediate 255"]));
        let (_, p) = run(&mut o, |l| l.unop(&un("-")));
        assert_eq!(
            p,
            lines(&[
                "LDA zeropage 16",
                "EOR immediate 255",
                "CLC implied",
                "ADC immediate 1"
            ])
        );
        let (_, p) = run(&mut o, |l| l.unop(&un("+")));
        assert_eq!(p, lines(&["LDA zeropage 16"]));
        let (r, _) = run(&mut o, |l| l.unop(&un("?")));
        assert_eq!(
            r.unwrap_err(),
            "no instruction-selection rule yet for the unary '?' operator"
        );
        let (_, p) = run(&mut o, |l| l.unop(&not(u8ref("g"))));
        assert!(p.iter().any(|x| x.starts_with("__8bs_true_")));
    }

    #[test]
    fn materialize_bool_builds_zero_or_one() {
        let mut o = options();
        let (r, p) = run(&mut o, |l| l.materialize_bool(&u8ref("g")));
        assert_eq!(r, Ok(()));
        assert_eq!(
            p,
            lines(&[
                "LDA zeropage 16",
                "BNE relative __8bs_true_1",
                "LDA immediate 0",
                "JMP absolute __8bs_end_2",
                "__8bs_true_1:",
                "LDA immediate 1",
                "__8bs_end_2:",
            ])
        );
    }

    #[test]
    fn branch_if_true_and_false_pick_the_branch() {
        let mut o = options();
        let (_, p) = run(&mut o, |l| l.branch_if_true(&u8ref("g"), "T"));
        assert_eq!(p, lines(&["LDA zeropage 16", "BNE relative T"]));
        let (_, p) = run(&mut o, |l| l.branch_if_false(&u8ref("g"), "T"));
        assert_eq!(p, lines(&["LDA zeropage 16", "BEQ relative T"]));
    }

    #[test]
    fn condition_handles_constants_and_logic() {
        let mut o = options();
        let (_, p) = run(&mut o, |l| l.condition(&typed(1, "bool"), "T", true));
        assert_eq!(p, lines(&["JMP absolute T"]));
        let (_, p) = run(&mut o, |l| l.condition(&typed(0x100, "bool"), "T", true));
        assert!(p.is_empty());
        let (_, p) = run(&mut o, |l| l.condition(&konst(0), "T", false));
        assert_eq!(p, lines(&["JMP absolute T"]));
        let (_, p) = run(&mut o, |l| l.condition(&not(u8ref("g")), "T", true));
        assert_eq!(p, lines(&["LDA zeropage 16", "BEQ relative T"]));
        let and = bin("&&", u8ref("g"), u8ref("s"), "bool");
        let (_, p) = run(&mut o, |l| l.condition(&and, "T", true));
        assert_eq!(
            p,
            lines(&[
                "LDA zeropage 16",
                "BEQ relative __8bs_and_skip_1",
                "LDA zeropage 64",
                "BNE relative T",
                "__8bs_and_skip_1:",
            ])
        );
        let (_, p) = run(&mut o, |l| l.condition(&and, "T", false));
        assert_eq!(
            p,
            lines(&[
                "LDA zeropage 16",
                "BEQ relative T",
                "LDA zeropage 64",
                "BEQ relative T"
            ])
        );
        let or = bin("||", u8ref("g"), u8ref("s"), "bool");
        let (_, p) = run(&mut o, |l| l.condition(&or, "T", true));
        assert_eq!(
            p,
            lines(&[
                "LDA zeropage 16",
                "BNE relative T",
                "LDA zeropage 64",
                "BNE relative T"
            ])
        );
        let (_, p) = run(&mut o, |l| l.condition(&or, "T", false));
        assert_eq!(
            p,
            lines(&[
                "LDA zeropage 16",
                "BNE relative __8bs_or_skip_1",
                "LDA zeropage 64",
                "BEQ relative T",
                "__8bs_or_skip_1:",
            ])
        );
        // A wide-typed node is refused before anything else.
        let (r, _) = run(&mut o, |l| {
            l.condition(&reference("w", "usmallint"), "T", true)
        });
        assert!(r.unwrap_err().starts_with("'ref' is 'usmallint' (2 bytes)"));
    }

    #[test]
    fn comparison_branch_eight_bit_plans() {
        let mut o = options();
        let cmp = |op: &str| bin(op, u8ref("g"), u8ref("s"), "bool");
        let (_, p) = run(&mut o, |l| l.comparison_branch(&cmp("=="), "T", true));
        assert_eq!(
            p,
            lines(&["LDA zeropage 16", "CMP zeropage 64", "BEQ relative T"])
        );
        let (_, p) = run(&mut o, |l| l.comparison_branch(&cmp("=="), "T", false));
        assert_eq!(p.last().unwrap(), "BNE relative T");
        // `<` with a simple right: mirrored table, AND-shaped.
        let (_, p) = run(&mut o, |l| l.comparison_branch(&cmp("<"), "T", true));
        assert_eq!(
            p,
            lines(&["LDA zeropage 16", "CMP zeropage 64", "BCC relative T"])
        );
        let (_, p) = run(&mut o, |l| l.comparison_branch(&cmp(">="), "T", true));
        assert_eq!(p[2], "BCS relative T");
        // x == 0 right after a load: no CMP at all.
        let zero = bin("==", u8ref("g"), konst(0), "bool");
        let (_, p) = run(&mut o, |l| l.comparison_branch(&zero, "T", true));
        assert_eq!(p, lines(&["LDA zeropage 16", "BEQ relative T"]));
        let (_, p) = run(&mut o, |l| l.comparison_branch(&zero, "T", false));
        assert_eq!(p, lines(&["LDA zeropage 16", "BNE relative T"]));
        // Simple left const: the right goes into A, the table is read unmirrored.
        let left_const = bin("<", konst(5), u8ref("g"), "bool");
        let (_, p) = run(&mut o, |l| l.comparison_branch(&left_const, "T", true));
        assert_eq!(p[..2], lines(&["LDA immediate 5", "CMP zeropage 16"])[..]);
        let zero_left = bin("!=", konst(0), u8ref("g"), "bool");
        let (_, p) = run(&mut o, |l| l.comparison_branch(&zero_left, "T", true));
        assert_eq!(
            p,
            lines(&["LDA immediate 0", "CMP zeropage 16", "BNE relative T"])
        );
        // Neither side simple: a temp and CMP.
        let both = bin(
            "!=",
            bin("+", u8ref("g"), u8ref("s"), "utinyint"),
            bin("+", u8ref("p"), u8ref("s"), "utinyint"),
            "bool",
        );
        let (_, p) = run(&mut o, |l| l.comparison_branch(&both, "T", true));
        assert_eq!(
            p[p.len() - 2..],
            lines(&["CMP zeropage 128", "BNE relative T"])[..]
        );
        assert_eq!(o.locals.mark(), 0x80);
    }

    #[test]
    fn comparison_branch_refusals_and_wide_paths() {
        let mut o = options();
        let signed = bin(
            "<",
            reference("g", "tinyint"),
            reference("s", "utinyint"),
            "bool",
        );
        let (r, _) = run(&mut o, |l| l.comparison_branch(&signed, "T", true));
        assert!(
            r.unwrap_err()
                .starts_with("the '<' comparison on a signed type")
        );
        // Equality on a signed type is fine.
        let eq = bin(
            "==",
            reference("g", "tinyint"),
            reference("s", "tinyint"),
            "bool",
        );
        let (r, _) = run(&mut o, |l| l.comparison_branch(&eq, "T", true));
        assert_eq!(r, Ok(()));
        // Three bytes wide.
        let wide = bin(
            "==",
            reference("g", "utriple"),
            reference("s", "utriple"),
            "bool",
        );
        let (r, _) = run(&mut o, |l| l.comparison_branch(&wide, "T", true));
        assert!(r.is_err());
        // 16-bit goes through the wide unit's operand widening.
        let two = bin(
            "<",
            reference("w", "usmallint"),
            reference("w", "usmallint"),
            "bool",
        );
        let (r, _) = run(&mut o, |l| l.comparison_branch(&two, "T", true));
        assert_eq!(r, Ok(()));
    }

    #[test]
    fn alloc_and_alloc16_bump_the_allocator() {
        let mut o = options();
        let (r, _) = run(&mut o, |l| Ok((l.alloc("a")?, l.alloc16("b")?)));
        assert_eq!(r, Ok((0x80, 0x81)));
        o.locals = LocalAllocator::new(0x80, 0x81, &[]);
        let (r, _) = run(&mut o, |l| l.alloc16("b"));
        assert!(r.is_err());
    }

    #[test]
    fn block_tracks_ranges_spans_and_scope() {
        let mut o = options();
        o.fn_name = Some("f".into());
        o.fn_file = Some("main.8bs".into());
        let local = Stmt::Local(Local {
            name: "x".into(),
            ty: "utinyint".into(),
            init: konst(4),
            inlined: None,
            start: Some(10),
            length: Some(3),
        });
        let body = vec![
            local,
            Stmt::Block(Block {
                body: vec![write_const(0x400, 1)],
                origin: Some("callee".into()),
                start: None,
                length: None,
            }),
            write_const(0x401, 2),
        ];
        let mut counters = Counters::default();
        let mut l = Lowerer::new(&mut o, &mut counters);
        let ranges = l.block(&body).unwrap();
        assert_eq!(ranges.len(), 3);
        assert_eq!(ranges[0].origin, None);
        assert_eq!(ranges[1].origin.as_deref(), Some("callee"));
        assert_eq!((ranges[0].start, ranges[0].end), (0, 2));
        assert_eq!((ranges[1].start, ranges[1].end), (2, 4));
        assert_eq!((ranges[2].start, ranges[2].end), (4, 6));
        // The span: first statement's own; the span is restored afterwards.
        let span = |i: usize| match &l.program[i] {
            Directive::Instruction { prov, .. } => prov.as_ref().unwrap().source.clone().unwrap(),
            _ => unreachable!(),
        };
        assert_eq!(span(0).start, 10);
        assert_eq!(span(0).file, "main.8bs");
        assert_eq!(span(4).start, 1);
        assert!(l.current_span.is_none());
        // The local went out of scope with the block.
        assert!(!l.symbols.contains_key("x"));
        assert!(!l.frame.contains_key("x"));
        assert_eq!(l.locals.mark(), 0x80);
    }

    #[test]
    fn unscope_restores_shadowed_names() {
        let mut o = options();
        let (_, _) = run(&mut o, |l| {
            let shadowed = l.symbols.get("g").cloned();
            l.symbols.insert(
                "g".into(),
                Binding {
                    address: 0x99,
                    ty: "utinyint".into(),
                },
            );
            l.frame.insert("g".into(), 2);
            l.symbols.insert(
                "fresh".into(),
                Binding {
                    address: 0x98,
                    ty: "utinyint".into(),
                },
            );
            l.frame.insert("fresh".into(), 1);
            l.unscope(&[
                Declared {
                    name: "g".into(),
                    shadowed,
                },
                Declared {
                    name: "fresh".into(),
                    shadowed: None,
                },
            ])?;
            assert_eq!(l.symbols["g"].address, 0x10);
            assert_eq!(l.frame["g"], 1);
            assert!(!l.symbols.contains_key("fresh"));
            assert!(!l.frame.contains_key("fresh"));
            Ok(())
        });
    }

    #[test]
    fn statement_local_break_return_wait() {
        let mut o = options();
        let local = Stmt::Local(Local {
            name: "x".into(),
            ty: "utinyint".into(),
            init: u8ref("g"),
            inlined: None,
            start: None,
            length: None,
        });
        let (r, p) = run(&mut o, |l| l.statement(&local));
        let declared = r.unwrap().unwrap();
        assert_eq!(declared.name, "x");
        assert_eq!(declared.shadowed, None);
        assert_eq!(p, lines(&["LDA zeropage 16", "STA zeropage 128"]));
        // A shadowing local reports what it shadowed.
        let shadow = Stmt::Local(Local {
            name: "g".into(),
            ty: "utinyint".into(),
            init: konst(1),
            inlined: None,
            start: None,
            length: None,
        });
        let (r, _) = run(&mut o, |l| l.statement(&shadow));
        assert_eq!(r.unwrap().unwrap().shadowed.unwrap().address, 0x10);
        // A wide local needs the wide unit.
        let wide = Stmt::Local(Local {
            name: "x".into(),
            ty: "usmallint".into(),
            init: typed(1, "usmallint"),
            inlined: None,
            start: None,
            length: None,
        });
        let (r, _) = run(&mut o, |l| l.statement(&wide));
        assert!(r.is_ok());
        let (r, _) = run(&mut o, |l| l.statement(&brk()));
        assert!(r.unwrap_err().starts_with("break outside any loop"));
        let cont = Stmt::Continue(Continue {
            start: 0,
            length: 0,
        });
        let (r, _) = run(&mut o, |l| l.statement(&cont));
        assert!(r.unwrap_err().starts_with("continue outside any loop"));
        let (_, p) = run(&mut o, |l| {
            l.loops.push(LoopLabels {
                continue_label: "C".into(),
                break_label: "B".into(),
            });
            l.statement(&brk())?;
            l.statement(&cont)
        });
        assert_eq!(p, lines(&["JMP absolute B", "JMP absolute C"]));
        let ret = Stmt::Return(Return {
            value: Some(u8ref("g")),
            start: 0,
            length: 0,
        });
        let (_, p) = run(&mut o, |l| l.statement(&ret));
        assert_eq!(p, lines(&["LDA zeropage 16", "JMP absolute __8bs_exit_0"]));
        let bare = Stmt::Return(Return {
            value: None,
            start: 0,
            length: 0,
        });
        let (_, p) = run(&mut o, |l| l.statement(&bare));
        assert_eq!(p, lines(&["JMP absolute __8bs_exit_0"]));
        let wait = Stmt::WaitFrame(WaitFrame {
            start: 0,
            length: 0,
        });
        let (_, p) = run(&mut o, |l| l.statement(&wait));
        assert_eq!(p, lines(&["JSR absolute __8bs_wait_frame"]));
        let (_, p) = run(&mut o, |l| {
            l.statement(&Stmt::MemoryRead(MemoryRead {
                address: Box::new(konst(0x2002)),
                ty: "utinyint".into(),
                start: 0,
                length: 0,
            }))
        });
        assert_eq!(p, lines(&["LDA absolute 8194"]));
        let port = Stmt::PortWrite(mos_ir::PortWrite {
            port: konst(1),
            value: konst(1),
            start: 0,
            length: 0,
        });
        let (r, _) = run(&mut o, |l| l.statement(&port));
        assert!(r.unwrap_err().starts_with("port.write is Z80"));
        let ns = Stmt::NamespaceCall(mos_ir::NamespaceCall {
            namespace: "n".into(),
            member: "m".into(),
            args: vec![],
            ty: Nullable::Absent,
            start: 0,
            length: 0,
        });
        let (r, _) = run(&mut o, |l| l.statement(&ns));
        assert!(
            r.unwrap_err()
                .starts_with("no instruction-selection rule yet for the 'namespaceCall' statement")
        );
        // A discarded port.read has no rule; the backend names the statement kind.
        let read = mos_ir::PortRead {
            port: Box::new(konst(1)),
            ty: "utinyint".into(),
            start: 0,
            length: 0,
        };
        let (r, _) = run(&mut o, |l| l.statement(&Stmt::PortRead(read)));
        assert_eq!(
            r.unwrap_err(),
            "no instruction-selection rule yet for the 'portRead' statement — it lands in a later milestone"
        );
        // A port.write in value position has no rule either.
        let write = Expr::PortWrite(Box::new(mos_ir::PortWrite {
            port: konst(1),
            value: konst(2),
            start: 0,
            length: 0,
        }));
        let (r, _) = run(&mut o, |l| l.expr(&write));
        assert_eq!(
            r.unwrap_err(),
            "no instruction-selection rule yet for the 'portWrite' expression — it lands in a later milestone"
        );
    }

    #[test]
    fn statement_assign_and_asm() {
        let mut o = options();
        // Assignment checks the target, then hands a byte to the increment fast path.
        let assign = Stmt::Assign(Assign {
            target: "nope".into(),
            value: konst(1),
            start: None,
            length: None,
        });
        let (r, _) = run(&mut o, |l| l.statement(&assign));
        assert!(r.unwrap_err().contains("resolves to nothing"));
        let assign = Stmt::Assign(Assign {
            target: "g".into(),
            value: konst(1),
            start: None,
            length: None,
        });
        let (r, _) = run(&mut o, |l| l.statement(&assign));
        assert_eq!(r, Ok(None));
        let assign = Stmt::Assign(Assign {
            target: "w".into(),
            value: typed(1, "usmallint"),
            start: None,
            length: None,
        });
        let (r, _) = run(&mut o, |l| l.statement(&assign));
        assert!(r.is_ok());
        // An asm6502 block: a frame name becomes its zero-page address.
        let asm = Stmt::Asm(mos_ir::Asm {
            text: "lda p\nsta $d020".into(),
            start: 0,
            length: 0,
        });
        let (r, p) = run(&mut o, |l| l.statement(&asm));
        assert_eq!(r, Ok(None));
        assert_eq!(p[0], "LDA zeropage 32");
        assert!(p[1].starts_with("STA absolute"));
        let bad = Stmt::Asm(mos_ir::Asm {
            text: "bogus".into(),
            start: 0,
            length: 0,
        });
        let (r, _) = run(&mut o, |l| l.statement(&bad));
        assert!(r.is_err());
    }

    fn operand_of(d: &Directive) -> Option<Operand> {
        match d {
            Directive::Instruction { operand, .. } => operand.clone(),
            _ => None,
        }
    }

    fn mode_of(d: &Directive) -> AddressingMode {
        match d {
            Directive::Instruction { mode, .. } => *mode,
            _ => unreachable!(),
        }
    }

    fn named(
        mnemonic: &str,
        mode: AddressingMode,
        name: &str,
        half: Option<Half>,
        offset: Option<i64>,
    ) -> Directive {
        Directive::Instruction {
            mnemonic: mnemonic.into(),
            mode,
            operand: Some(Operand::Label {
                name: name.into(),
                byte: half,
                offset,
            }),
            prov: None,
        }
    }

    #[test]
    fn frame_operand_rewrites_frame_names_only() {
        let mut o = options();
        let (r, _) = run(&mut o, |l| {
            // Not an instruction, no operand, or not a frame name: untouched.
            let lab = label("x");
            assert_eq!(l.frame_operand(&lab)?, lab);
            let plain = instr("RTS", AddressingMode::Implied, None, None);
            assert_eq!(l.frame_operand(&plain)?, plain);
            let other = named("LDA", AddressingMode::Absolute, "elsewhere", None, None);
            assert_eq!(l.frame_operand(&other)?, other);
            // `g` is a global, not part of the frame.
            let global = named("LDA", AddressingMode::Absolute, "g", None, None);
            assert_eq!(l.frame_operand(&global)?, global);
            // A parameter narrows absolute to zero page, with an offset.
            let d = l.frame_operand(&named("LDA", AddressingMode::Absolute, "p", None, Some(1)))?;
            assert_eq!(operand_of(&d), Some(Operand::Value { value: 0x21 }));
            assert_eq!(mode_of(&d), AddressingMode::Zeropage);
            // `lda p,y` has no zero-page,y form: it keeps absolute,y.
            let d = l.frame_operand(&named("LDA", AddressingMode::AbsoluteY, "p", None, None))?;
            assert_eq!(mode_of(&d), AddressingMode::AbsoluteY);
            assert_eq!(operand_of(&d), Some(Operand::Value { value: 0x20 }));
            let d = l.frame_operand(&named("LDX", AddressingMode::AbsoluteY, "p", None, None))?;
            assert_eq!(mode_of(&d), AddressingMode::ZeropageY);
            let d = l.frame_operand(&named("LDA", AddressingMode::AbsoluteX, "p", None, None))?;
            assert_eq!(mode_of(&d), AddressingMode::ZeropageX);
            // `#<name` and `#>name` are bytes of the address.
            let d = l.frame_operand(&named(
                "LDA",
                AddressingMode::Immediate,
                "p",
                Some(Half::Lo),
                None,
            ))?;
            assert_eq!(operand_of(&d), Some(Operand::Value { value: 0x20 }));
            let d = l.frame_operand(&named(
                "LDA",
                AddressingMode::Immediate,
                "p",
                Some(Half::Hi),
                None,
            ))?;
            assert_eq!(operand_of(&d), Some(Operand::Value { value: 0 }));
            Ok(())
        });
        assert_eq!(r, Ok(()));
    }

    #[test]
    fn frame_operand_refuses_misuse() {
        let mut o = options();
        let (r, _) = run(&mut o, |l| {
            let err = |l: &mut Lowerer<'_>, d: Directive| l.frame_operand(&d).unwrap_err();
            let e = err(l, named("LDA", AddressingMode::Immediate, "p", None, None));
            assert_eq!(
                e,
                "asm6502 names 'p', a parameter or local of this function, as an immediate: write 'p' for its value or '#<p' / '#>p' for a byte of its address"
            );
            let e = err(l, named("JSR", AddressingMode::Absolute, "p", None, None));
            assert!(
                e.ends_with("where JSR needs an address to run: a frame slot is data, not code")
            );
            let e = err(l, named("JMP", AddressingMode::Indirect, "p", None, None));
            assert!(e.contains("where JMP needs"));
            let e = err(l, named("BNE", AddressingMode::Relative, "p", None, None));
            assert!(e.contains("where BNE needs"));
            let e = err(
                l,
                named("LDA", AddressingMode::Absolute, "p", None, Some(0x1000)),
            );
            assert!(e.ends_with("at $1020 — past the zero page a frame slot is always placed in"));
            Ok(())
        });
        assert_eq!(r, Ok(()));
    }

    #[test]
    fn string_copy_needs_both_pointers() {
        let mut o = options();
        let copy = Stmt::StringCopy(StringCopy {
            target: u8ref("g"),
            source: u8ref("s"),
            capacity: 4,
            start: 0,
            length: 0,
        });
        // The pointers come from the wide unit.
        let (r, p) = run(&mut o, |l| l.string_copy(&copy));
        assert!(r.unwrap_err().starts_with("'ref' is 'utinyint'"));
        assert!(p.is_empty());
        let (r, _) = run(&mut o, |l| l.string_copy(&brk()));
        assert_eq!(
            r,
            Err("stringCopy: needs both a source and a target".to_string())
        );
    }

    fn read_of(address: Expr) -> Expr {
        Expr::MemoryRead(MemoryRead {
            address: Box::new(address),
            ty: "utinyint".into(),
            start: 0,
            length: 0,
        })
    }

    #[test]
    fn memory_read_const_and_computed() {
        let mut o = options();
        let (_, p) = run(&mut o, |l| l.memory_read(&read_of(konst(0x20))));
        assert_eq!(p, lines(&["LDA zeropage 32"]));
        let (_, p) = run(&mut o, |l| l.memory_read(&read_of(konst(0x2002))));
        assert_eq!(p, lines(&["LDA absolute 8194"]));
        let (r, _) = run(&mut o, |l| l.memory_read(&read_of(u8ref("g"))));
        assert!(
            r.unwrap_err()
                .starts_with("memoryRead: a computed address is 'utinyint'")
        );
        let (r, _) = run(&mut o, |l| {
            l.memory_read(&read_of(reference("w", "usmallint")))
        });
        assert_eq!(r, Ok(()));
        let (r, _) = run(&mut o, |l| l.memory_read(&konst(1)));
        assert_eq!(r, Err("memoryRead: no address to read from".to_string()));
    }

    #[test]
    fn memory_write_const_and_computed() {
        let mut o = options();
        let (_, p) = run(&mut o, |l| l.memory_write(&write_const(0x20, 5)));
        assert_eq!(p, lines(&["LDA immediate 5", "STA zeropage 32"]));
        let (_, p) = run(&mut o, |l| l.memory_write(&write_const(0xd020, 5)));
        assert_eq!(p, lines(&["LDA immediate 5", "STA absolute 53280"]));
        let computed = Stmt::MemoryWrite(MemoryWrite {
            address: u8ref("g"),
            value: konst(1),
            start: 0,
            length: 0,
        });
        let (r, _) = run(&mut o, |l| l.memory_write(&computed));
        assert!(
            r.unwrap_err()
                .starts_with("memoryWrite: a computed address is 'utinyint'")
        );
        let computed = Stmt::MemoryWrite(MemoryWrite {
            address: reference("w", "usmallint"),
            value: konst(1),
            start: 0,
            length: 0,
        });
        let (r, _) = run(&mut o, |l| l.memory_write(&computed));
        assert_eq!(r, Ok(()));
        let (r, _) = run(&mut o, |l| l.memory_write(&brk()));
        assert_eq!(r, Err("memoryWrite: no address to write to".to_string()));
    }

    fn if_of(then: Vec<Stmt>, otherwise: Option<Vec<Stmt>>) -> Stmt {
        Stmt::If(If {
            test: u8ref("g"),
            then,
            r#else: otherwise,
            start: 0,
            length: 0,
        })
    }

    #[test]
    fn if_statement_with_and_without_else() {
        let mut o = options();
        let (_, p) = run(&mut o, |l| {
            l.if_statement(&if_of(vec![write_const(0x20, 1)], None))
        });
        assert_eq!(
            p,
            lines(&[
                "LDA zeropage 16",
                "BEQ relative __8bs_endif_1",
                "LDA immediate 1",
                "STA zeropage 32",
                "__8bs_endif_1:",
            ])
        );
        // An empty `else {}` is the same as none.
        let (_, q) = run(&mut o, |l| {
            l.if_statement(&if_of(vec![write_const(0x20, 1)], Some(vec![])))
        });
        assert_eq!(p, q);
        let (_, p) = run(&mut o, |l| {
            l.if_statement(&if_of(
                vec![write_const(0x20, 1)],
                Some(vec![write_const(0x20, 2)]),
            ))
        });
        assert_eq!(
            p,
            lines(&[
                "LDA zeropage 16",
                "BEQ relative __8bs_else_1",
                "LDA immediate 1",
                "STA zeropage 32",
                "JMP absolute __8bs_endif_2",
                "__8bs_else_1:",
                "LDA immediate 2",
                "STA zeropage 32",
                "__8bs_endif_2:",
            ])
        );
        let (r, _) = run(&mut o, |l| l.if_statement(&brk()));
        assert!(r.is_err());
    }

    #[test]
    fn while_statement_pushes_loop_labels() {
        let mut o = options();
        let stmt = Stmt::While(While {
            test: u8ref("g"),
            body: vec![brk()],
            start: 0,
            length: 0,
        });
        let (r, p) = run(&mut o, |l| {
            l.while_statement(&stmt)?;
            assert!(l.loops.is_empty());
            Ok(())
        });
        assert_eq!(r, Ok(()));
        assert_eq!(
            p,
            lines(&[
                "__8bs_while_1:",
                "LDA zeropage 16",
                "BEQ relative __8bs_endwhile_2",
                "JMP absolute __8bs_endwhile_2",
                "JMP absolute __8bs_while_1",
                "__8bs_endwhile_2:",
            ])
        );
        let (r, _) = run(&mut o, |l| l.while_statement(&brk()));
        assert!(r.is_err());
    }

    fn counted_for(body: Vec<Stmt>) -> Stmt {
        Stmt::For(For {
            init: Nullable::Value(Box::new(Stmt::Local(Local {
                name: "i".into(),
                ty: "utinyint".into(),
                init: konst(0),
                inlined: None,
                start: None,
                length: None,
            }))),
            test: Nullable::Value(bin("<", u8ref("i"), u8ref("g"), "bool")),
            update: Nullable::Value(Box::new(Stmt::Assign(Assign {
                target: "i".into(),
                value: bin("+", u8ref("i"), konst(1), "utinyint"),
                start: None,
                length: None,
            }))),
            body,
            unroll: None,
            start: None,
            length: None,
        })
    }

    #[test]
    fn for_statement_scopes_its_counter() {
        let mut o = options();
        // The update is an assignment: it reaches the wide unit's increment path.
        let (r, p) = run(&mut o, |l| l.for_statement(&counted_for(vec![brk()])));
        assert_eq!(r, Ok(()));
        assert_eq!(p[0], "LDA immediate 0");
        assert_eq!(
            p[..6],
            lines(&[
                "LDA immediate 0",
                "STA zeropage 128",
                "__8bs_for_1:",
                "LDA zeropage 128",
                "CMP zeropage 16",
                "BCS relative __8bs_endfor_3",
            ])[..]
        );
        o.locals = LocalAllocator::new(0x80, 0x90, &[]);
        // A loop with no init, test or update.
        let bare = Stmt::For(For {
            init: Nullable::Absent,
            test: Nullable::Absent,
            update: Nullable::Absent,
            body: vec![brk()],
            unroll: None,
            start: None,
            length: None,
        });
        let (r, p) = run(&mut o, |l| {
            l.for_statement(&bare)?;
            assert!(l.loops.is_empty());
            Ok(())
        });
        assert_eq!(r, Ok(()));
        assert_eq!(
            p,
            lines(&[
                "__8bs_for_1:",
                "JMP absolute __8bs_endfor_3",
                "__8bs_forcont_2:",
                "JMP absolute __8bs_for_1",
                "__8bs_endfor_3:",
            ])
        );
        assert_eq!(o.locals.mark(), 0x80);
        let (r, _) = run(&mut o, |l| l.for_statement(&brk()));
        assert!(r.is_err());
    }

    fn fill(count: i64, value: i64, base: i64) -> Stmt {
        let lt = |n: i64| bin("<", reference("i", "utinyint"), konst(n), "bool");
        Stmt::For(For {
            init: Nullable::Value(Box::new(Stmt::Local(Local {
                name: "i".into(),
                ty: "utinyint".into(),
                init: konst(0),
                inlined: None,
                start: None,
                length: None,
            }))),
            test: Nullable::Value(lt(count)),
            update: Nullable::Value(Box::new(Stmt::Assign(Assign {
                target: "i".into(),
                value: bin("+", reference("i", "utinyint"), konst(1), "utinyint"),
                start: None,
                length: None,
            }))),
            body: vec![Stmt::MemoryWrite(MemoryWrite {
                address: bin("+", konst(base), reference("i", "utinyint"), "usmallint"),
                value: konst(value),
                start: 0,
                length: 0,
            })],
            unroll: None,
            start: None,
            length: None,
        })
    }

    #[test]
    fn emit_const_fill_pages_and_remainder() {
        let mut o = options();
        let (r, p) = run(&mut o, |l| l.emit_const_fill(&brk()));
        assert_eq!(r, Ok(false));
        assert!(p.is_empty());
        let (r, p) = run(&mut o, |l| l.emit_const_fill(&fill(1000, 32, 0x400)));
        assert_eq!(r, Ok(true));
        assert_eq!(p.len(), 19);
        assert_eq!(p[0], "LDA immediate 32");
        assert_eq!(p[1], "LDX immediate 0");
        assert_eq!(p[2], "__8bs_fill_1:");
        assert_eq!(p[3], "STA absolute,x 1024");
        assert_eq!(p[7], "STA absolute,x 1280");
        assert!(p[14].starts_with("__8bs_fillrem_"));
        assert_eq!(p[15], "STA absolute,x 1792");
        assert_eq!(p[17], "CPX immediate 232");
        // Whole pages only, in zero page.
        let (_, p) = run(&mut o, |l| l.emit_const_fill(&fill(256, 0, 0)));
        assert_eq!(p.len(), 6);
        assert_eq!(p[3], "STA zeropage,x 0");
        // Under a page: remainder only.
        let (_, p) = run(&mut o, |l| l.emit_const_fill(&fill(5, 0, 0x2000)));
        assert!(p[2].starts_with("__8bs_fillrem_"));
        assert_eq!(p[5], "CPX immediate 5");
    }

    #[test]
    fn for_statement_takes_the_fill_fast_path() {
        let mut o = options();
        let (r, p) = run(&mut o, |l| l.for_statement(&fill(8, 1, 0x400)));
        assert_eq!(r, Ok(()));
        assert_eq!(p[0], "LDA immediate 1");
        assert!(p.iter().all(|x| !x.starts_with("__8bs_for_")));
    }

    #[test]
    fn statement_kinds_and_spans_cover_every_variant() {
        assert_eq!(statement_kind(&brk()), "break");
        assert_eq!(statement_span(&brk()), Some((0, 0)));
        let local = Stmt::Local(Local {
            name: "x".into(),
            ty: "utinyint".into(),
            init: konst(1),
            inlined: None,
            start: None,
            length: None,
        });
        assert_eq!(statement_span(&local), None);
        assert_eq!(statement_kind(&local), "local");
        assert_eq!(low_byte(-1), 255);
    }
}
