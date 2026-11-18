//! Port of mos/lower/index.ts `:1337-2180`: stubs until this unit is ported (R5.7).

use mos_ir::{Expr, Stmt};

use super::{BlockRange, Declared, Lowerer};
use crate::asm::assemble::Directive;
use crate::asm::encode::AddressingMode;
use crate::startup::multiply::MultiplyCells;
use crate::unported;

impl Lowerer<'_> {
    /// # Errors
    /// `unported:` until this method is ported.
    pub fn emit_operands(
        &mut self,
        _left: &Expr,
        _right: &Expr,
        _what: &str,
    ) -> Result<i64, String> {
        Err(unported("emitOperands"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn binop(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("binop"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn last_sets_flags_from_a(&mut self) -> Result<bool, String> {
        Err(unported("lastSetsFlagsFromA"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn simple_operand(
        &mut self,
        _node: &Expr,
    ) -> Result<Option<(AddressingMode, i64)>, String> {
        Err(unported("simpleOperand"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn require_multiply(&mut self) -> Result<MultiplyCells, String> {
        Err(unported("requireMultiply"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn multiply_into(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("multiplyInto"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn modulo8(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("modulo8"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn bitwise8(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("bitwise8"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn shift8(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("shift8"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn unop(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("unop"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn materialize_bool(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("materializeBool"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn branch_if_true(&mut self, _node: &Expr, _target: &str) -> Result<(), String> {
        Err(unported("branchIfTrue"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn branch_if_false(&mut self, _node: &Expr, _target: &str) -> Result<(), String> {
        Err(unported("branchIfFalse"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn condition(
        &mut self,
        _node: &Expr,
        _target: &str,
        _want_true: bool,
    ) -> Result<(), String> {
        Err(unported("condition"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn comparison_branch(
        &mut self,
        _node: &Expr,
        _target: &str,
        _want_true: bool,
    ) -> Result<(), String> {
        Err(unported("comparisonBranch"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn alloc(&mut self, _what: &str) -> Result<i64, String> {
        Err(unported("alloc"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn alloc16(&mut self, _what: &str) -> Result<i64, String> {
        Err(unported("alloc16"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn block(&mut self, _body: &[Stmt]) -> Result<Vec<BlockRange>, String> {
        Err(unported("block"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn unscope(&mut self, _declared: &[Declared]) -> Result<(), String> {
        Err(unported("unscope"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn statement(&mut self, _node: &Stmt) -> Result<Option<Declared>, String> {
        Err(unported("statement"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn frame_operand(&mut self, _directive: &Directive) -> Result<Directive, String> {
        Err(unported("frameOperand"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn string_copy(&mut self, _node: &Stmt) -> Result<(), String> {
        Err(unported("stringCopy"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn memory_read(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("memoryRead"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn memory_write(&mut self, _statement: &Stmt) -> Result<(), String> {
        Err(unported("memoryWrite"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn if_statement(&mut self, _node: &Stmt) -> Result<(), String> {
        Err(unported("ifStatement"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn while_statement(&mut self, _node: &Stmt) -> Result<(), String> {
        Err(unported("whileStatement"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn for_statement(&mut self, _node: &Stmt) -> Result<(), String> {
        Err(unported("forStatement"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn emit_const_fill(&mut self, _node: &Stmt) -> Result<bool, String> {
        Err(unported("emitConstFill"))
    }
}
