# @8bitscript/examples

The example programs that ship with the toolchain. `@8bitscript/cli`
depends on this package, so installing the CLI installs the examples, and
the VS Code extension lists them in its launcher beside your own projects
and beside Studio. Each example is an ordinary project: a directory with an
`8bitscript.config.ts` and a `src/main.8bs`, run with `8bs run <target>` from
inside it.

The manifest is the `"8bitscript".examples` field of `package.json`: one
entry per example, with a title, a directory, and a sentence about it.
The launcher reads that field and nothing else, so adding an example is a
directory and an entry.

| Example | What it is | Targets |
| ------- | ---------- | ------- |
| `hello-world` | `screen.blank()` then `text.print(0, "Hello World!")` through the portable screen and text packages — the same few lines build for the PET and the web. | pet, web |

Both targets build and run. From inside `hello-world/`:

```
8bs run pet              # the default 2001, in VICE
8bs run pet --profile 8032   # 80 columns, mixed case
8bs run web              # the browser
```

The program prints and returns, landing back at the BASIC `READY.` prompt
the way any program that falls off its own end does. On a PET that boots
into the upper-case/graphics character set — every model but the 8032 —
the greeting draws in capitals, because that set holds one case of the
alphabet; the 8032 shows real mixed case. See `@8bitscript/pet`'s own
notes for why nothing switches between them.

The test in `test/` checks that the manifest names a real project and that
the program links clean for each of its targets.
