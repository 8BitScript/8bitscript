---
"@8bitscript/atari8": patch
"@8bitscript/c64": patch
"@8bitscript/c128": patch
"@8bitscript/cli": patch
"@8bitscript/compiler": patch
"@8bitscript/cx16": patch
"@8bitscript/examples": patch
"@8bitscript/input": patch
"@8bitscript/language-server": patch
"@8bitscript/mega65": patch
"@8bitscript/nes": patch
"@8bitscript/pet": patch
"@8bitscript/pointer": patch
"@8bitscript/random": patch
"@8bitscript/screen": patch
"@8bitscript/studio": patch
"@8bitscript/system": patch
"@8bitscript/text": patch
"@8bitscript/ui": patch
"@8bitscript/vic20": patch
"@8bitscript/web": patch
"8bitscript-lang": patch
---

Normalized spelling in comments, docs, and user-facing strings
(package descriptions, editor hover/grammar text, diagnostic prose) to
match the spelling the code's own identifiers already use — `color`
not `colour`, `behavior` not `behaviour`, `initialize`/`optimize`/
`recognize` rather than `-ise`, and a handful of one-off words. No
behavior, API, or identifier changed; this is text only. The `GREY`
constant (`BorderColor.GREY`, `BackgroundColor.GREY`) and its prose
mentions are left alone — that one's a real public API surface, a
separate decision from a text-only pass like this.
