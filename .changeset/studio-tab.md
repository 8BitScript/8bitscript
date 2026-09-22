---
"8bitscript-lang": minor
---

Studio in an editor tab. The Open Studio button's menu gains **In an editor tab** (and the palette **8BitScript: Open Studio in a Tab**): `8bs run cx16 --web` builds Studio and serves the CLI's WebAssembly x16emu on loopback, and a **Studio** tab frames it with Reset, Rebuild, Stop and Open in browser above the screen. Closing the tab ends the run. The tab's mouse line says whether Studio has the mouse (a click on the screen gives it, Esc takes it back) and, should the editor not let a framed page capture it, points at Open in browser. Needs a CLI with `8bs run cx16 --web`.
