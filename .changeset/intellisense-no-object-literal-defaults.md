---
"@8bitscript/compiler": patch
"@8bitscript/cli": patch
---

Cleared every open SonarCloud finding that was failing trunk's quality gate after 0.14.x:

- Two MINOR code smells (`javascript:S7737`, object-literal default parameters) in the IntelliSense module's `hoverAt()`/`completionsAt()` — both now default to one shared, frozen `NO_MACHINE` constant instead of a fresh literal.
- Three CRITICAL reliability bugs (`javascript:S2871`, sorting strings with no explicit compare function) in `discoverCatalogLocales()` (cli and compiler) and the i18n module's dead `schemaKeys()` helper. The two `discoverCatalogLocales()` sorts now use the same explicit ordinal comparator `packages/compiler/src/mos/debug.ts` already established for this exact reason — this order feeds build output and must not depend on the host's locale, so `localeCompare` (Sonar's own default suggestion) would have been the wrong fix. `schemaKeys()` was unused since the PR that added it and is deleted rather than patched.

Also fixes a real bug found while resolving the object-literal defaults above: hover and completion for an imported namespace's member (`screen.blank`) inside a template string's `${...}` field (`` `Score: ${screen.blank()}` ``) silently answered nothing. The recursive re-lex that handles a template field's own contents was passing its small, freshly re-lexed token slice to the import-resolution lookup too, which needs the *whole* file's tokens to find the original `import` statement — a handful of tokens with no `import` in them can never resolve one. Both `hoverAt()` and `completionsAt()` now carry the outer file's token stream through the recursion (`outerTokens`) separately from the token slice used to find the cursor's own position, and use whichever one each job actually needs.
