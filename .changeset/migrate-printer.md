---
"@8bitscript/cli": patch
---

Add the printer for the old-syntax converter: it turns an old-syntax program into new-syntax source, keeping comments, marking only reassigned bindings `mut`, and reporting constructs it cannot convert.
