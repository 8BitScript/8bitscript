---
"@8bitscript/raster": patch
---

Fix `@8bitscript/raster`'s published dependencies: `0.10.0` shipped with
its `dependencies` still reading the literal `workspace:*` protocol
string instead of a resolved version, because its first-ever publish
went through the manual bootstrap in `.github/AGENTS.md` ("A brand-new
package's first publish") using plain `npm publish` — which doesn't
understand pnpm's workspace protocol and doesn't rewrite it. Any
consumer outside this workspace hard-failed resolving
`@8bitscript/atari8@workspace:*` and the rest.

`0.10.1` republishes with real versions. `release.mjs` now refuses to
publish any package whose dependencies still carry a `workspace:`
specifier, and the AGENTS.md recovery doc now says `pnpm publish`, not
`npm publish`, for exactly this reason.
