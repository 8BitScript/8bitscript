---
"8bitscript-lang": patch
---

A **Controller Setup** panel in the editor: find the pads plugged into this machine, say what their buttons are called in 8BitScript's terms, and write that down in the project.

`8BitScript: Controller Setup` opens a webview panel — an editor tab rather than a side bar view, because a gamepad silhouette does not fit in 300px and a page polling an animation frame has no business staying resident behind a tree. Detection is in the page, on `navigator.getGamepads()`, because the extension host is Node and has no HID; everything done with those frames is in two modules that never import `vscode` (`src/controllerProfile.cjs`, `src/controllerStore.cjs`) and are tested with plain `node --test`. The page is handed the *same* profile module behind a three-line CommonJS shim rather than a second copy of it: the deadzone that turns a shoved stick into a direction is part of what a profile means, and two copies of that number would be two profiles.

Each controller assigns to Unassigned or Player 1-4. A live view lights every raw button and draws every axis, so "is the device talking" can be answered before "is my mapping right". The mapper is an inline-SVG pad — inline because the webview's CSP names no image source at all — that can be clicked control-first, or walked through control by control; each step waits for the pad to go quiet before it listens, because the previous step's button is usually still held.

**The stored profile is in 8BitScript's own names**, never a machine's and never a driver's:

    up down left right  a b x y  l r  start select
    leftStickX leftStickY rightStickX rightStickY  lt rt

A profile phrased in X-input's terms would be a statement about the driver somebody happened to boot with; one phrased in the NES pad's terms could not be projected onto a VIC-20. The reference device — an 8BitDo SN30 Pro in X-input mode — is the test pad and the picture, not the model. Its two stick clicks are deliberately unnamed: no machine in the catalog has anywhere to put them, and an `l3` in every stored profile would be a control nothing downstream could read.

It is stored as `8bitscript.controllers.json` beside `8bitscript.config.ts`, not as a block inside it. The config is source: `saveSystem` writes into it through a `WorkspaceEdit` so the write lands in the undo stack, and refuses a shape it cannot safely edit. That care is right for a line a person reads and wrong for eighteen machine-generated bindings per device rewritten on every button press. It is also not knowledge the compiler needs — which pad is Player 1 changes what an emulator is launched with, not what is built — and JSON is `JSON.parse` for anything that is not this editor, where the config is TypeScript that has to be evaluated.

A **target preview** projects the mapping onto every machine. The port counts are the toolchain's answer, not a table here: `input.joysticks` and `input.pads` out of `8bs targets --json`, resolved through `effectiveFacts` with the hardware each machine is actually fitted with — the Atari's multiplexer really does raise `input.joysticks` to 4, and a preview computed from stock facts would disagree with the machine a Run starts.

## How it reaches `8bs run`

`packages/cli/src/controllers.mjs` — landing alongside this — is the other end: it turns a profile into whatever each emulator takes at launch. It reads a `controllers.players` block out of `8bitscript.config.ts`, and it spells a binding with the host pad's index in it (`pad0.button3`, `pad0.axis1-`). The two stores answer different questions and both are kept:

- The CLI's block is **per player** — which emulated port, driven by which host input. That is what a launch needs.
- This panel's file is **per device** — which physical pad, keyed by the one string about it that survives being unplugged, and what its own buttons are called. That is what a mapper needs: a pad's index is the slot the browser gave it this session, and a mapping keyed on it is wrong the next time somebody plugs the mouse in first.

So the panel emits the CLI's block from its own file, resolving the pad index when it is asked for, and offers it under **What the toolchain reads** with a Copy button. Offered to paste, not written in — the same line `saveSystem` already draws for a config it cannot safely rewrite. `port` is left out of every entry, because `defaultPort` in the CLI already knows a C64 reads player one from port 2 and a block written for a C64 must still be right on an NES. The four directions go through the left-stick fallback on the way out, so a stick-only profile emits four real direction bindings instead of an empty map.

The eighteen control names are identical at both ends, in the same order. What is not yet shared is the grammar (`button:3` here against `pad0.button3` there) and the home (a sidecar against the config), and that is worth one decision by a human rather than two agents each assuming.

## What this still needs from the CLI

One thing the editor has to know and the toolchain does not say, in one named place — `DEVICE_CONTROLS` and `PAD_KINDS` at the bottom of `editors/vscode/src/controllerProfile.cjs` — so closing it deletes code rather than finding it.

**What a port's device carries.** The catalog says how many ports and, for the Commodores, what can go in one (`port1: none | joystick | paddles | mouse1351`). It never says that an Atari-standard joystick is four switches and one button, that an NES pad is eight bits, or that the X16 takes a twelve-button SNES pad — so `input.pads: 2` cannot be projected without knowing *which* pad. A `controls` array on each port option value, plus a machine-level one for pad ports (which have no option behind them), would remove both tables. Today the editor knows two machines' pads and says so for a third rather than guessing.

Two earlier asks are already answered by `controllers.mjs` and are recorded here only so the trail is complete: which port the first player drives (`defaultPort` — the editor keeps `PRIMARY_PORT` for the preview's own labels and emits no port at all), and how a profile reaches a launch.

## Known limitation, unverified against a live window

Chromium gates `navigator.getGamepads()` behind the `gamepad` permissions policy, whose default allowlist is `self`. A VS Code webview is a cross-origin `vscode-webview://` iframe, and an extension cannot set the `allow` attribute on the iframe the editor creates. In Cursor's bundled workbench that attribute is `["cross-origin-isolated", "autoplay"]` plus the two clipboard features, and the string `gamepad` appears nowhere in the bundle — so a cross-origin child should not be granted it. That is static evidence, not a measurement: whether the call throws, returns nothing, or works anyway in this host is the first thing to check with a pad in hand.

The panel is built so either outcome is honest. A refused call — an absent API, or a `SecurityError` from the policy — is reported as *"this window is not handing the panel gamepad access"*, never as an empty device list. A policy that answers silently instead of refusing is caught by the one contradiction it leaves: a `gamepadconnected` event from a window that then lists no controllers.
