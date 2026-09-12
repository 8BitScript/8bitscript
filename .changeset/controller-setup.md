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

`packages/cli/src/controllers.mjs` reads `8bitscript.controllers.json` itself — `controllerPlayers()` takes the very object `controllerStore.cjs` writes, keeps the same eighteen control names, and parses the same four binding shapes (its parser rejects `button:3-` as a typo for the same reason this one does). From there it is that file's business to turn a player into `-joydev`, a generated `.vjm`, an `SDL2_JOY_<n>_UP` or a named refusal. The host joystick number is the player number minus one, which is why the pads want plugging in in player order.

**A keyboard key is a binding, not a special case.** `key:<KeyboardEvent.code>` is the fourth shape, and on the Atari it is the only one: atari800 has no per-button controller mapping at all. This end used to reject it, which would have been a documented gap except that `normalizeProfile` rewrites the file on every save and drops what it cannot read — so a hand-written Atari keyboard stick worked until somebody opened the panel and pressed one button, and then it was gone with nothing said.

It is in `parseBinding` rather than beside it because three of that function's callers are not asking "what is the pad doing": `answered` (has this control an answer at all — the per-machine preview), `resolveDirection` (is this direction bound, or does it fall back to the stick), and the page's binding table (does this row say a name or say *not bound*). Held at arm's length, a fully bound Atari keyboard stick showed all four directions and its fire button as **missing** on the one machine it was written for. The rest of the callers read live state and have an answer too: a webview has `keydown` and `keyup`, so a held key lights the silhouette, fills a meter and can be captured — which is what makes an Atari stick reachable from the walkthrough instead of only by hand. Escape is never captured (it is what cancels a step) but round-trips if written by hand, and held keys are dropped on blur so a key held while the window loses focus cannot bind itself to whatever is asked for next.

An earlier version of this panel emitted a `controllers.players` block for `8bitscript.config.ts`, because that is where the CLI first read a profile from. That is gone with the reader: offering somebody a snippet to paste into a config nothing consults would be exactly the kind of quiet trap this branch has spent its time closing.

## What this needed from the CLI

Everything this panel asked of the toolchain has since been answered, and the asks are recorded only so the trail is complete.

**What a port's device carries**, which was the last of them. The catalog said how many ports and, for the Commodores, what could go in one (`port1: none | joystick | paddles | mouse1351`), and never that an Atari-standard joystick is four switches and one button, that an NES pad is eight bits, or that the X16 takes a twelve-button SNES pad — so `input.pads: 2` could not be projected without knowing *which* pad, and `DEVICE_CONTROLS` and `PAD_KINDS` at the bottom of `editors/vscode/src/controllerProfile.cjs` were where the editor kept the answer for two machines and a documented gap for a third. Every machine package now declares `input.controls` and `8bs targets --json` publishes it, along with the shapes that have a name; both tables are deleted. See `.changeset/controller-catalog.md`. **Which port the first player drives**: `8bs targets --json` now publishes `primaryPort` per machine and the preview takes it; `PRIMARY_PORT` here is down to the two machines `packages/c64/src/joystick.8bs` documents and answers only for a toolchain too old to say. **How a profile reaches a launch**: the CLI reads this file directly.

## Known limitation, unverified against a live window

Chromium gates `navigator.getGamepads()` behind the `gamepad` permissions policy, whose default allowlist is `self`. A VS Code webview is a cross-origin `vscode-webview://` iframe, and an extension cannot set the `allow` attribute on the iframe the editor creates. In Cursor's bundled workbench that attribute is `["cross-origin-isolated", "autoplay"]` plus the two clipboard features, and the string `gamepad` appears nowhere in the bundle — so a cross-origin child should not be granted it. That is static evidence, not a measurement: whether the call throws, returns nothing, or works anyway in this host is the first thing to check with a pad in hand.

The panel is built so either outcome is honest. A refused call — an absent API, or a `SecurityError` from the policy — is reported as *"this window is not handing the panel gamepad access"*, never as an empty device list. A policy that answers silently instead of refusing is caught by the one contradiction it leaves: a `gamepadconnected` event from a window that has never once been able to list a pad. If the policy suppresses the *events* as well as the readings, that second mechanism is inert and the panel falls back to "no controller seen yet" — the safe direction, but not a complete detection.

Two more things a person with a pad should know:

- **Two identical controllers are told apart by connection order.** Two 8BitDo SN30 Pros report byte-identical `Gamepad.id` strings, which is the ordinary Player 1 + Player 2 setup, so the second and later get `#2`, `#3` by their position in the browser's list. The Gamepad API exposes no serial number and `Gamepad.index` is the same plug-ordered number wearing a different hat, so swapping the cables swaps the two profiles — fixable by changing one `player` in the file, and better than mapping only one of the two.
- **A pad that rests an axis away from centre never goes quiet**, so a walkthrough step waiting for you to let go of everything would sit there. The prompt names what it is still reading (`Still reading: axis 2`) rather than hanging silently, the live view shows the same thing unmapped, and Esc leaves; each control can still be bound on its own from the table.
