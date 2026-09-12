---
"@8bitscript/cli": minor
---

Controller profiles reach the emulator: one adapter per emulator, and an honest account of what each will take.

`8bs run` and `8bs boot` now read `8bitscript.controllers.json` — the file the editor's Controller Setup panel writes — and hand it to whichever emulator the target uses, in whatever shape that emulator will accept. The two ends share one grammar on purpose: `packages/cli/src/controllers.mjs`'s `parseBinding` is the inverse of `editors/vscode/src/controllerProfile.cjs`'s, because two spellings of one mapping is how a binding comes to mean different things at each end.

```json
{
  "version": 1,
  "controllers": {
    "devices": [
      { "id": "…", "name": "8BitDo SN30 Pro", "player": 1, "mode": "standard",
        "mapping": { "up": "button:12", "a": "button:0", "left": "axis:0-" } }
    ]
  }
}
```

The eighteen control names are `docs/project/input.md`'s. A device with `player: 0` is one the panel has seen and nobody has assigned, and drives nothing — "plugged in" and "playing" are different facts. **The host joystick number is the player number minus one**: nothing in the file carries one, because a device is identified by its Gamepad API id string, which has no relationship to the index SDL hands the emulator, and matching them by name would be a guess that fails silently. Which emulated port a player takes comes from the machine, not the file — player 1 is port **2** on a C64, C128 and MEGA65, because port 1 shares its lines with the keyboard matrix and a stick left there types.

`8bs targets --json` now publishes `primaryPort` per machine so the editor can stop keeping its own copy of that table.

`controllers.mjs` is all pure functions — profile in, arguments and file *contents* out — which is what lets the tests assert on argument vectors rather than opening a window. That matters here more than anywhere: `8bs run <target>` without `--screenshot` waits for a human, and a test that launches one does not fail, it hangs.

What each emulator actually does, measured against the binaries rather than remembered:

- **VICE** (`xvic`/`x64sc`/`x128`) gets the most. `-joydev<port>` picks which host device drives a port, and a full per-button map goes through a generated `.vjm` joystick file whose format is documented inside VICE's own binary. `JoyMapFile` has no command-line form, so the map is reached through a generated `vicerc` — which works only under the emulator's own section header (`[C64SC]`, `[VIC20]`, `[C128]`), and only when `-config` is the **first** argument on the line. Both were measured with bounded `-limitcycles` runs; with the flag buried mid-argv VICE silently falls back to its default map, which is exactly the quiet nothing this work exists to prevent. The user's own `vicerc` is copied rather than replaced, since `-config` replaces it.
- **atari800** takes a keyboard stick — `-kbdjoy0`/`-kbdjoy1` plus `SDL2_JOY_<n>_*` keycodes — in the same single `-config` file the CRT knobs already used. A real pad's buttons are not settable at all: `SDL2_JOY_<n>_BUTTON_KEYS` maps buttons to emulated *keys*, not to stick directions. An Atari stick has one trigger, so everything past `a` is named rather than mapped.
- **fceux** takes `--input1`/`--input2` and nothing else. Its bindings live in `~/.fceux/fceux.cfg` and named profiles under `~/.fceux/input/`, both set from the Qt GUI, and there is no `-config <file>` to point elsewhere. Said by name at launch rather than quietly dropped.
- **x16emu** takes `-joy1`..`-joy4` — "enable binding a gamepad to SNES controller port N" — and no mapping; its `-keymap` is a Commodore keyboard layout, not a controller map. **xmega65** takes `-joyport 1|2` and `-curskeyjoy`, one port at a time.
- **The PET is refused by name.** It has no control ports: VICE offers `xpet` only the userport joystick adapter, and the catalog agrees (`input.joysticks: 0`). If one is ever fitted it belongs in `packages/pet`'s catalog as an option.
- **web** is accepted and says it has nowhere to land yet — the browser runtime reads six fixed edge bits.

Nothing here emits a `-controlport<n>device` flag: which device is *in* a port is the machine catalog's sentence, and the adapters' flags go after it. A port fitted with nothing (a stock C64's port 1, where player 2 lands) is refused with the `--hardware port1=joystick` that fixes it, rather than pointing `-joydev1` at an empty port and looking broken.

A hand-written `key:<KeyboardEvent.code>` binding is read — it is the only shape atari800 takes a mapping in at all — but the panel's own `parseBinding` does not accept it yet, and `normalizeProfile` rewrites the file on save. A launch that finds one says so by name, because otherwise it works until somebody opens the panel and presses a button, and then it is gone with nothing said. Two characters of the panel's regex close it.

A project with no `8bitscript.controllers.json` launches byte-identically to before.
