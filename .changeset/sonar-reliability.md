---
"@8bitscript/cli": patch
"@8bitscript/compiler": patch
"8bitscript-lang": patch
---

SonarCloud's quality gate on trunk was failing on Reliability of New Code
(C, needs A): super-linear regexes, a thenable-looking IR `then` field,
always-false `===` checks, a loop that could only run once, and a handful
of related smells. The regexes are now ordinary scans, the IR field is
named where it stands with the same NOSONAR the rest of the compiler
already uses, and the rest of the findings are the same behaviour without
the pattern the gate was scoring.
