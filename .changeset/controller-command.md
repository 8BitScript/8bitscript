---
"@8bitscript/cli": minor
---

`8bs controller` maps a game controller from the terminal, in a real browser.

The Gamepad API belongs to a browsing context, so nothing in Node can see a pad and the editor's Controller Setup panel polls for one inside its webview. That is the right place only if the editor grants it: Chromium gates `navigator.getGamepads()` behind the `gamepad` permission policy, whose default allowlist is `self`, and a webview is a cross-origin iframe whose `allow` attribute belongs to the *editor* — Cursor's bundled workbench lists cross-origin-isolated, autoplay and the two clipboard features in it, and not `gamepad`. A panel that can never see a controller looks exactly like a controller that is not plugged in.

A browser has no such question. `8bs controller` serves the mapping page on loopback, opens it in the browser the person already has, and takes the profile back over the socket: assign pads to players, bind the eighteen logical controls (by hand, from the standard layout, or through the guided walkthrough), and `8bitscript.controllers.json` is written beside `8bitscript.config.ts` as each binding is made — the same file `8bs run` already reads to aim each emulator's joystick ports, in the same shape the editor's panel writes. `--no-open` prints the URL and waits, the way `8bs run web --no-open` does; `--list` prints the controllers a project has on record and `--print` dumps the file, both without a browser; `--dir` names the project.

The page is the editor's page, not a second one: `media/controller.js`, its stylesheet, the silhouette, and `controllerProfile.cjs` — which is what a binding *means*, down to the deadzone that turns a shoved stick into a direction — are mirrored into `src/controller-page/` and served from there, because an installed `@8bitscript/cli` cannot reach `editors/vscode` (it is private and outside `packages/`). The mirror is byte-for-byte and a test says so, printing the `cp` that fixes it: two mapping UIs that had each drifted to their own idea of a deadzone would be two different profiles.

`bin/8bs.mjs` also stopped losing output. `process.exit()` abandons a pending write and a pipe holds 64KB, so `8bs targets --json | ...` had begun handing its readers — the editor among them — JSON that ended mid-string at byte 65536, with an exit code of 0 to say all was well. Every command now drains stdout before it exits.
