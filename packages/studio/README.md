# @8bitscript/studio

8BitScript Studio: the asset editor that ships with the toolchain and runs
on the machines themselves — characters, sprites, and music, with the full
editor on the Commander X16 and a smaller one down to the PET, and a viewer
on the NES. It is an ordinary 8BitScript program: `8bs run <target>` here
starts it, and the VS Code extension's **Launch Studio** does the same from
the editor.

Today it is a front door and nothing behind it: the screen shows the tier
this machine gets, which editors that tier will open, and what is driving
it. The menu bar moves — `@8bitscript/input` reads whatever the machine has
— but there is still no sound, sprite or storage capability to build an
editor on; [`AGENTS.md`](AGENTS.md) has the tiers, the design, and what each
editor is waiting for.

```bash
pnpm start                 # the Commander X16
pnpm run start:pet         # the PET, at the basic tier
pnpm run start:nes         # the NES, as a viewer
8bs run c64 --screenshot studio.png
```

Studio's version is the toolchain's version; `test/studio.test.mjs` holds
it to that, and links it clean for every target.
