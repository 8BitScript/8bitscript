---
"@8bitscript/studio": minor
"@8bitscript/web": minor
"@8bitscript/cli": minor
---

Studio opens into the DAW module: a solid menu bar and status bar on every release target, built on a shell that later modules plug into.

**The browser gets a high-resolution mode, `machine=hifi-hires`.** The Modern host at native text size: a font pixel is a whole number of device pixels (about 16 CSS pixels of text on any display) and the window decides how many cells fit, up to 160x100, instead of scaling a fixed ~48x27 grid to the window. Raster entries gain a tenth line bit to reach it. `hifi` is unchanged apart from now being drawn at whole device pixels.

**Open Studio runs it** (`8bs run web`, with the high-resolution machine set in Studio's config) in the editor tab. **Open Studio on the X16 (WebAssembly)** is the new command for our Commander X16 model in the tab; the native emulator and x16emu commands are unchanged. The bars are sample text only: nothing opens or plays yet.
