---
"@8bitscript/cli": patch
---

The web target's generated page now declares `viewport-fit=cover` and safe-area padding (no more drawing under a notch or the home-indicator strip), the `apple-mobile-web-app-capable` meta trio so Add to Home Screen launches full-screen with no browser chrome, and `resize()` now prefers `visualViewport` over `window.innerWidth`/`innerHeight` for the area actually visible. A best-effort, harmless-when-it-does-nothing nudge (`nudgeChromeCollapsed`) also tries to collapse a mobile browser's own toolbar on load and on rotation — there is no API that can guarantee this in an ordinary browser tab, only Add to Home Screen can.
