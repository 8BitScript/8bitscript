---
"@8bitscript/cli": minor
"@8bitscript/compiler": patch
---

Add `8bs migrate`: converts old-syntax `.8bs` and `.8bx` files to the new syntax in place, proving each result against the new front end first. `--check` reports without writing, and `--embedded` and `--fences` also convert programs inside JavaScript test files and Markdown fences. The compiler package now exports its front end as `@8bitscript/compiler/front`.
