---
"8bitscript-lang": minor
---

The side bar's "..." menu has **Enable Local Development Extension** / **Use Official Extension**, below Controller Setup — the UI half of what `pnpm --filter 8bitscript-lang run link-local` already did from a terminal. Enabling points the editor's extensions folder at an open workspace checkout, the editor's own managed clone, `8bitscript.checkout`, or a folder you pick, whichever resolves first — same order `--checkout` already uses. Disabling removes that link and asks the editor's own install command for the Marketplace/Open VSX build back, rather than fetching or extracting anything itself.
