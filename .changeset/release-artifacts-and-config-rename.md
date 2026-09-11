---
"@8bitscript/cli": minor
---

`8bs build --release` builds every artifact a project's config declares for a release in one command: each release-ready target it lists, once per name in that target's own `release` array (a catalog preset, a project profile, or `{}` for the target's own default hardware), or once with its defaults when it lists none. The reusable `compile.yml` workflow calls it automatically when its `targets` input is left empty, so a project's release matrix — how many PET RAM/model variants, say — lives in one place, versioned with the project, instead of duplicated into CI. `compile.yml`'s `targets` also now accepts `target@profile:hardware=opts` entries for projects that would rather keep the matrix in CI.

The project config file is now `8bitscript.config.ts`; the old `8bs.config.ts` name still loads, so no existing project needs to rename anything to pick up this release.
