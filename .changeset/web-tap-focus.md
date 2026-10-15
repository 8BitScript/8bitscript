---
"@8bitscript/cli": patch
---

**A click on a framed full-page screen gives it the keyboard.** The page a wasm build runs in cancels a pointer press (so a swipe doesn't scroll or select), and when that page is itself framed cross-origin — the editor's Preview tab frames it — cancelling the press also cancelled the browser moving keyboard focus into the frame. A click on the screen left the arrows with the page around it, so a PET or C64 program in the Preview tab never saw a key. A tap now asks for focus itself: the page's window when the screen fills it, the screen's own element when it is embedded, as it already did. Reproduced and verified in headless Chromium against 2048's PET build: framed, a click and LEFT changed no pixels before and moved the board after.
