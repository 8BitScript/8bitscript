//! Port of mos/lower/index.ts `:668-1336`: stubs until this unit is ported (R5.7).

use mos_ir::{Call, Expr, Stmt};

use super::{Binding, Lowerer};
use crate::unported;

impl Lowerer<'_> {
    /// # Errors
    /// `unported:` until this method is ported.
    pub fn expr16(&mut self, _node: &Expr) -> Result<i64, String> {
        Err(unported("expr16"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn expr_to16(&mut self, _node: &Expr) -> Result<i64, String> {
        Err(unported("exprTo16"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn store16_into(&mut self, _node: &Expr, _address: i64) -> Result<(), String> {
        Err(unported("store16Into"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn emit_inc_dec(
        &mut self,
        _target: &str,
        _binding: &Binding,
        _value: &Expr,
    ) -> Result<bool, String> {
        Err(unported("emitIncDec"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn binop16(&mut self, _node: &Expr) -> Result<i64, String> {
        Err(unported("binop16"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn bitwise16(&mut self, _node: &Expr) -> Result<i64, String> {
        Err(unported("bitwise16"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn add_sub16_into(&mut self, _node: &Expr, _target: i64) -> Result<(), String> {
        Err(unported("addSub16Into"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn shift16(&mut self, _node: &Expr) -> Result<i64, String> {
        Err(unported("shift16"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn string_length(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("stringLength"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn string_byte(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("stringByte"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn array_target(&mut self, _node: &Expr) -> Result<String, String> {
        Err(unported("arrayTarget"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn array_pointer(
        &mut self,
        _label: &str,
        _index: &Expr,
        _offset: i64,
    ) -> Result<i64, String> {
        Err(unported("arrayPointer"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn store_index(&mut self, _node: &Stmt) -> Result<(), String> {
        Err(unported("storeIndex"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn store_index16(&mut self, _node: &Stmt, _name: &str) -> Result<(), String> {
        Err(unported("storeIndex16"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn wide_elements(&mut self, _name: &str) -> Result<bool, String> {
        Err(unported("wideElements"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn array_pointer16(&mut self, _label: &str, _index: &Expr) -> Result<i64, String> {
        Err(unported("arrayPointer16"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn index_into_y(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("indexIntoY"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn index_value(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("indexValue"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn index_read(&mut self, _node: &Expr) -> Result<(), String> {
        Err(unported("indexRead"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn index_read16(&mut self, _node: &Expr) -> Result<i64, String> {
        Err(unported("indexRead16"))
    }

    /// # Errors
    /// `unported:` until this method is ported.
    pub fn call_site(&mut self, _node: &Call) -> Result<(), String> {
        Err(unported("callSite"))
    }
}
