---
"8bitscript-lang": patch
---

An `.8bx` file opened in VS Code now reaches the language server: the
client only accepted the `8bitscript` language id, so a file registered
as `8bitextensible` got highlighting and nothing else — no diagnostics,
hover or completion. Both ids go to the one server, which tells the two
source kinds apart by extension.
