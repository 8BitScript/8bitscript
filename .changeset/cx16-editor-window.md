---
"8bitscript-lang": patch
"@8bitscript/cli": patch
---

The VS Code launcher passes `--capture-mouse` and `--fullscreen` on native Commander X16 runs and boots by default (`8bitscript.cx16.captureMouse` and `8bitscript.cx16.fullscreen` in Settings). Studio in a tab is unchanged. The CLI accepts the same flags for `8bs run cx16` and `8bs boot cx16`; a terminal launch without them still starts with a free mouse and a window.
