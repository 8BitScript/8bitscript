# @8bitscript/examples

The example programs that ship with the toolchain. `@8bitscript/cli`
depends on this package, so installing the CLI installs the examples, and
the VS Code extension lists them in its launcher beside your own projects
and beside Studio. Each example is an ordinary project: a directory with an
`8bs.config.ts` and a `src/main.8bs`, run with `8bs run <target>` from
inside it.

The manifest is the `"8bitscript".examples` field of `package.json`: one
entry per example, with a title, a directory, and a sentence about it.
The launcher reads that field and nothing else, so adding an example is a
directory and an entry.

| Example | What it is | Targets |
| ------- | ---------- | ------- |
| `hello-raw` | Eleven `memory.write` calls into the PET's screen RAM at `$8000`. The first program the native 6502 backend builds, and its acceptance test: the build must be exactly the seventy bytes listed in the "Hello, PET" roadmap. | pet |
| `hello` | `text.print(0, "HELLO WORLD")` through the portable text package. The 0.2.0 goal program. | pet, web |

**Nothing builds yet.** 0.2.0 is the release in which 8BitScript grows its
own backends, and these two programs are the milestones the PET backend is
built against. Until then `8bs build` in either directory stops with a clear
message. The tests in `test/` check that both programs link clean for each
of their targets, which is what the front end can promise today.
