---
'@8bitscript/compiler': patch
---

`assert!`, `assert_eq!`, `assert_ne!` and `panic!` parse as statements inside test functions, `#[cfg(test)]` modules and `*.test.8bs` files; outside them they are still reported as before
