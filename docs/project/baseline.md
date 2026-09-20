---
title: The baseline, and what a build does without
nav_order: 86
---

# The baseline, and what a build does without

*Design note, 2026-09-19. What `baseline` in `8bitscript.config.ts`
means, what the toolchain does with it, and — the part that took longer
than the code — what to call the builds that are not it.*

## The question

An 8BitScript program builds for nine machines from one source. The
machines are not alike, and the language's answer to that is the fact:
`#fact(video.raster)` is true on the C64 and false on the PET, the
branch on it folds, and the PET build carries no raster code. That
works, and it leaves a question the source cannot answer on its own:
**which machine is the program *for*?**

Every real program has one. It is the machine the developer writes
against, tries a feature on first, takes the README's screenshot from,
and has in mind when they say "the game". On that machine every fact the
program tests answers yes. On the others some answer no, and the
program is the same source with those branches gone. 2048 is written
against the C64 — colour tiles, a raster wobble behind the title, a
hardware entropy source, an animated slide — and runs on the 4K PET
2001 with none of those, in 2876 bytes. Both are the program. One is
the one it was designed on.

Until now that fact lived in a README sentence. It is a fact about the
project, so it belongs in the project's config, where the toolchain can
read it.

## The word

`baseline`. The build every fact the program tests is true on; the
system the program is designed on. Named the way a system is named,
because it is one:

```ts
baseline: 'c64'                                 // a machine, under the project's own hardware for it
baseline: 'PET 2001 (4K)'                        // a name from `systems`
baseline: { target: 'pet', profile: '8032' }     // a system's shape
```

`requires` (docs/config.md) was already the *floor*: the least of each
fact a build must have, or it is refused. The baseline is the *ceiling*
one build reaches. A project has a floor, a baseline, and every build
between them. The three are all it needs.

## What the other builds are called

Nothing special — **builds**. The PET build. The VIC-20 build. The web
build.

The obvious words were considered and turned down, each for a reason
this project already holds:

- **Port.** A port is a second source that follows a first. 8BitScript's
  whole proposition is that there is no second source — `docs/index.md`
  opens on it, and 2048's README measures it in bytes: the elements are
  the same functions at the same sizes on every target. Calling the PET
  build a port would say the opposite of what the compiler does. The
  toolchain never uses the word.
- **Tier.** A tier is a bucket: full / reduced / minimal, or 1 / 2 / 3.
  Buckets hide facts. The C128 build is short of the baseline by one
  fact (no raster list yet), the PET by four, the NES by a different
  four — and the same bucket would hold builds that do without
  different things. The facts are already the tiers, one per fact, and
  they are finer and truer than any label. The report below prints them.
- **Edition, lite, economy, reduced, degraded, fallback, second-class.**
  Each says the build is *less*. It is not less; it is the same program
  on a machine that has less, and the difference is the machine's, said
  in the program's terms. A PET has two colours. A 2048 on a PET that
  did *not* fold the colour table away would be the worse build.

So the vocabulary is three words: **floor** (`requires`), **baseline**
(`baseline`), and **build** (all of them, the baseline included). What
separates one build from the baseline is not a name but a list, and it
is **short of** the baseline by exactly those facts — the same word
`8bs targets` already uses for a system short of the floor.

## What the toolchain does with it

- **`8bs build` / `8bs run` with no target build the baseline.** `pnpm
  start` in a project is the program on the machine it is for.
  `--profile` and `--hardware` sit on top, as on a `--system`.
- **`8bs targets` names it** — "This program is designed on: c64" and the
  command that makes it — and `--json` carries it with its resolved
  sheet, for an editor that wants to put it first.
- **`8bs build --release` measures every build against it.** After each
  artifact:

  ```
  built dist/2048-pet.prg
  memory: 65 bytes of RAM for variables, 2876 bytes of program (code and data)
  short of the baseline (c64): video.palette 2 of 16, video.raster, input.joysticks 0 of 2, memory.ram 3071 of 51199
  ```

  A flag reads as its name — a build short of `video.raster` has none; a
  count as *have* of *baseline*. The baseline build prints `the
  baseline`; a build with nothing to list prints `level with the
  baseline (c64)`.

- **Only the facts the program tests are counted.** The linker records
  every `#fact(key)` a project file spells and every `Video.COLUMNS`,
  `Memory.RAM`, `Input.JOYSTICKS`, … it reads from `@8bitscript/system`
  (`factsTested` on `link()`'s result), and the report is filtered to
  those. The C64 has a SID and the PET has not, but a program that
  never asks `Audio.VOICES` does nothing without on the PET for it, and
  listing it would be the noise the report exists to replace. A fact a
  package folds on — `text.COLUMNS` on `video.columns` — is the
  package's business: the program that prints through it never asked,
  and the library did the lifting. That is the line 2048's README draws
  between an element that tests a fact and a `lib/` twin the build
  picks, now drawn by the compiler.

- **A baseline below the floor is refused.** `baseline: { target:
  'pet', profile: '2001' }` under `requires: { 'memory.ram': 8192 }` is
  a config mistake and says so: the baseline clears the floor first.

## What it is not

Not a grade, and not a switch. The baseline changes no build's bytes:
2048's fifteen artifacts are byte-identical with and without the key.
It does not gate a feature — a program that wants a feature only on
the baseline still writes the fact it depends on, and a machine that
happens to share the fact gets the feature too, which is the point.
And it does not make a build with fewer facts a worse build to ship: a
release attaches all of them, and the report is there so the release
notes can say what each does without, in the program's own words,
without anyone working it out by hand.

## How a README should say it

One sentence, then the list the toolchain printed:

> 2048 is designed on the C64. It builds for eight other machines from
> the same source; `8bs build --release` says what each is short of.

Then the report, verbatim. A reader with a PET learns in one line that
the PET build has two colours and no raster effect, that it is the same
program, and that nothing else is missing — which is more than "port"
ever told anyone.

## Later

- **The editor's side bar** could show the baseline first and mark the
  facts each other system is short of, from the same JSON.
- **Release notes.** The report is stdout today; a `--release --json`
  carrying `{ artifact, facts, shortOf }` per build would let a release
  workflow write the table into the GitHub Release body.
- **A fact a package tests on the program's behalf.** `screen.RESIZABLE`
  is a package const that is true only on the web's fluid host and that
  2048 branches on by name. It is not a system fact and so not on the
  report; whether a package should be able to declare "this const is a
  fact of the build" is an open question, and the answer is not to put
  `video.resizable` on the sheet by reflex.
