# @8bitscript/cli

## 0.6.0

### Minor Changes

- fc0af15: The C128 builds and runs, and the editor offers every machine that does.
  
  The C128 is the C64 again in almost every respect that matters here, which is why it went quickly: the same VIC-II registers and the same frame as an exact fraction of the same crystal (`FRAME_SYNC` already recorded the two entries identically), a screen at `$0400` written through a computed address, and a character ROM whose mixed-case set holds lower case at 1-26 and upper case at 65-90 — measured against `chargen-390059-01.bin`, where code 8 is `h` and code 72 is `H`, with only 105 and 122 differing across the block-graphics range, exactly as on every other Commodore here.
  
  Three things are its own. Its `.prg` loads at `$1C01` and its RAM ends at `$C000` — 41983 bytes, which is what `packages/c128/AGENTS.md` has always recorded, and the catalog's new build symbols reproduce that number exactly. Its zero page starts at `$0A`: `$00`/`$01` are the 8502's port and `$02`-`$09` are the KERNAL's JMPFAR/JSRFAR parameters, so those nine bytes stay the machine's — which is not a new decision, but the one this project's own pre-0.2.0 C128 link map already made. And its text package now selects the mixed-case set, which on this machine means agreeing with the ROM rather than overriding it: the C128 boots that way.
  
  Measured under x128: hello-world is **225 bytes** and returns to a working `ready.` prompt; 2048 is **3583 bytes** and draws its board.
  
  `@8bitscript/c128/text` also gets the fix its siblings got: it mapped only 64-95 and left lower case at 97-122, which in the upper-case set are graphics symbols.
  
  The VS Code extension offers `pet`, `c64`, `vic20`, `c128` and `web` — its task-definition enum, its system setting, and the launcher's own list. What each machine *offers* was never listed there and still is not: every option, value and preset comes from `8bs targets --json`, so the C64's REU sizes and the VIC-20's RAM expansions arrived on their own the moment those machines were on the list.
- c7fea69: The C64 and the VIC-20 build and run. 2048 plays on both.
  
  `RELEASE_MACHINES` is `pet, c64, vic20, web`. What it took, beyond the groundwork in the changes before this one:
  
  **`waitFrame()` on a raster.** The PET has a retrace flag and no documented crystal, so it measures its own frame at start-up. Every other Commodore here has the opposite pair of facts: no flag, but a raster counter readable as a plain byte and a frame that is an exact fraction of a known crystal. So the accumulator, its denominator and the whole compare/subtract body are shared, and only two things differ per machine — how a hardware frame is waited for (the raster leaving the top half of the frame and coming back to it, never a narrow at-line-0 window, for the reason `FRAME_SYNC` records at length) and how the per-frame credit is arrived at. PAL or NTSC cannot be a build flag, since one `.prg` runs on both, so it is probed once at start-up by watching for a line only one region ever reaches.
  
  **`string<N>` buffers.** A buffer's name is its address, the way a literal's is — it lives in the data section, not zero page — so it can be passed to `text.print` and assigned into. `stringCopy` is the assignment: the length byte and then that many characters, through two pointers.
  
  **Narrowing assignment.** `let offset: utinyint = (cellWidth - width) >> 1` is ordinary code — the subtraction is 16-bit because one side is, and the answer is kept in a byte. Narrowing takes the low byte, which is what it has always meant, instead of the statement being refused for a width the program never asked anything unusual of.
  
  **A 16-bit array index goes through a pointer.** Y is eight bits, so `screenRam[cell]` with a cell past 255 cannot be indexed with it. Truncating collapsed 1000 cells into the first 256 — on a 40-column screen, the whole display crammed into its top six rows, which is exactly what a C64 2048 drew before this. The address is computed instead, as a computed `memory.write` address already was.
  
  Measured under x64sc and xvic, through the real CLI:
  
  | | hello-world | 2048 |
  |---|---|---|
  | C64 | 424 bytes | 3747 bytes |
  | VIC-20 | 232 bytes | 3116 bytes, inside an unexpanded 3583 |
  
  The PET is unchanged at 108/108/127 bytes, and its 2048 got *smaller* — 2440 to 2413 — from the index-offset fold.
- 188cd63: Controller profiles reach the emulator: one adapter per emulator, and an honest account of what each will take.
  
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
- 188cd63: `8bs controller` maps a game controller from the terminal, in a real browser.
  
  The Gamepad API belongs to a browsing context, so nothing in Node can see a pad and the editor's Controller Setup panel polls for one inside its webview. That is the right place only if the editor grants it: Chromium gates `navigator.getGamepads()` behind the `gamepad` permission policy, whose default allowlist is `self`, and a webview is a cross-origin iframe whose `allow` attribute belongs to the *editor* — Cursor's bundled workbench lists cross-origin-isolated, autoplay and the two clipboard features in it, and not `gamepad`. A panel that can never see a controller looks exactly like a controller that is not plugged in.
  
  A browser has no such question. `8bs controller` serves the mapping page on loopback, opens it in the browser the person already has, and takes the profile back over the socket: assign pads to players, bind the eighteen logical controls (by hand, from the standard layout, or through the guided walkthrough), and `8bitscript.controllers.json` is written beside `8bitscript.config.ts` as each binding is made — the same file `8bs run` already reads to aim each emulator's joystick ports, in the same shape the editor's panel writes. `--no-open` prints the URL and waits, the way `8bs run web --no-open` does; `--list` prints the controllers a project has on record and `--print` dumps the file, both without a browser; `--dir` names the project.
  
  The page is the editor's page, not a second one: `media/controller.js`, its stylesheet, the silhouette, and `controllerProfile.cjs` — which is what a binding *means*, down to the deadzone that turns a shoved stick into a direction — are mirrored into `src/controller-page/` and served from there, because an installed `@8bitscript/cli` cannot reach `editors/vscode` (it is private and outside `packages/`). The mirror is byte-for-byte and a test says so, printing the `cp` that fixes it: two mapping UIs that had each drifted to their own idea of a deadzone would be two different profiles.
  
  `bin/8bs.mjs` also stopped losing output. `process.exit()` abandons a pending write and a pipe holds 64KB, so `8bs targets --json | ...` had begun handing its readers — the editor among them — JSON that ended mid-string at byte 65536, with an exit code of 0 to say all was well. Every command now drains stdout before it exits.
- 57ccce1: The Commander X16 builds and runs. The MEGA65 builds.
  
  Four things the backend gained, all of them machine-independent and all of them wanted by these two rather than invented for them:
  
  - **`x / 2^k` is a shift and `x % 2^k` is a mask.** The 6502 has no divide, so `/` was refused by name — but a power-of-two divisor is not really a divide. The X16 package is written in those terms throughout (`memory.read(0x9F35) / 128`, `low / 256`, `attr / 16`, `cell % 256`), which is how a program reads best. Unsigned only: `>>` floors where `/` truncates, so the two disagree on negatives.
  - **16-bit `&`, `|` and `^`.** A byte at a time, which is all a bitwise operation ever is — no carry between the halves.
  - **Narrowing at every 8-bit boundary**, not just at a local or an assignment: a `memory.write` value, an 8-bit call argument and an array element all take the low byte of a wider expression now, which is what narrowing has always meant.
  - **`waitFrame()` for both.** The MEGA65's VIC-IV answers `$D011`/`$D012` like the C64's VIC-II, so it is the same raster poll. The X16 is a third shape: VERA raises a VSYNC bit in its ISR and acknowledging it is writing it back — an edge like the PET's, but needing no calibration, because the X16's frame is exactly 1/60s everywhere. At the default frame rate one VSYNC is exactly one logical frame and the accumulator never carries.
  
  The X16 also needed a start-up its package had documented and the native backend had never emitted: `CHR$(15)` through CHROUT, which switches the screen editor into ISO mode. `@8bitscript/cx16/text` writes ASCII straight to VERA — the tile index *is* the character code there — and without the switch the machine is in PETSCII and every letter draws as a graphic. Two instructions, on the one machine that needs them.
  
  **Measured under x16emu: hello-world is 1370 bytes and prints `Hello World!` over a working `READY.`**
  
  The MEGA65 is **not** un-parked. Its hello-world (251 bytes) and 2048 (3615 bytes) both build, but Xemu shows a one-time onboarding screen that waits for a keypress before it will run anything, so nothing has been seen on screen yet — and un-parking is what switches a machine's emulator tests on. It joins the list when a screenshot can prove it.
  
  2048 does not fit the X16 yet: its deepest call chain wants more zero page than the 94 bytes `$22`-`$7F` the X16 documents as the user's, and taking any of the KERNAL's `$80`+ would need research this workspace does not have.
- 57ccce1: Every machine the toolchain knows now builds and runs. `RELEASE_MACHINES` is the whole list.
  
  The NES and the Atari 8-bit join, each brought up against its own emulator — `Hello World!` and 2048 seen on screen under `fceux` and `atari800`. Neither fits the shape every machine before them shared (a `.prg` with a BASIC stub that `SYS`es in and `RTS`es back), which is what `mos/image.ts` exists for: a NES program is a ROM started by a reset vector, an Atari program is a segmented `.xex` the DOS loader jumps through.
  
  **The X16's zero page widens from 94 bytes to 181**, and 2048 fits it. The evidence is the ROM's own ld65 configuration rather than the docs' summary table: `cfg/x16.cfginc` declares ZPKERNAL at `$80`, ZPDOS at `$91`, ZPAUDIO at `$A7`, ZPMATH at `$A9` and ZPBASIC at `$D4`, and `cfg/kernal-x16.cfgtpl` loads every one of the KERNAL bank's four zero-page segments into ZPKERNAL while no other bank declares zero page at all — so no KERNAL routine can reach `$A9`-`$FF`, whatever it is asked to do. That range is the Math library's and BASIC's, and the reference manual releases both to machine code outright. A program that never hands BASIC back takes it; one that does keeps the polite `$22`-`$7F`.
  
  `$02`-`$21` stays out under both, though 2048 would fit inside the old ceiling if it were taken: those are `r0`-`r15`, the KERNAL API's caller-supplied 16-bit argument registers, demonstrably written through `extapi`, and "does this program call such a routine" is not a fact readable off the finished instruction stream the way `usesWaitFrame` is — the calls sit inside opaque `asm6502` blocks.
  
  A zero-page budget may now carry holes of its own, and they survive into every program. The PET's CHRGET hole is the other kind — it exists only because a returning program leaves BASIC's interpreter running — and still drops for a program that never returns.
  
  The VS Code extension offers all nine targets. What each machine *offers* is still never listed there: every option, value and preset comes from `8bs targets --json`.
- 57ccce1: The MEGA65 builds, runs and is no longer parked — and two bugs in its package are fixed.
  
  Getting it on screen at all took cracking Xemu's onboarding screen, which waits for a keypress and so hung every headless run. The cause is upstream: Hyppo reads its config sector from absolute LBA 1 of the SD image, while Xemu only ever writes one at syspart+1, so the onboarding-complete byte was never set. Writing a valid config sector at LBA 1 of `mega65.img` — `$0E = $80` being the byte that matters — makes `xmega65 -headless -besure -prgmode 65 -prg … -screenshot …` work. That is emulator state, not repo state, and it is recorded here because the next person will hit it too.
  
  What that revealed, neither of which any build could have shown:
  
  - **Lower case drew as graphics.** `text.8bs` mapped only 64-95 and pinned `$D018` to the upper-case set, so lower-case ASCII passed straight through into the graphics range: hello-world drew `H`, four blobs, ` W`, four more blobs, `!`. It now selects the mixed-case set (`$26`, measured: screen codes `08 05 0C 0C 0F` render as `hello`, `48 45 4C 4C 4F` as `HELLO`) and maps `97`-`122` down by 96, which is what every other Commodore in this workspace does and what `packages/pet/src/text.8bs` argues at length. This reverses a deliberate choice recorded in that file — that `TICK` should read as `TICK` the way it does on the NES and the X16 — because a text package that silently changes the text is answering a different question than the one it was asked.
  - **Colour RAM was left mapped over the CIAs.** `prepare()` set CRAM2K (`$D030` bit 0) so the 80-column screen's cells 1024-1999 could be coloured, and never cleared it — leaving colour RAM in front of `$DC00`-`$DFFF`, where the CIAs are. `@8bitscript/mega65/input`'s `poll()` then scanned the keyboard matrix through colour cells and invented key presses out of whatever the screen held: in 2048 a phantom LEFT slid the board and spawned a third tile before the player touched anything. Its writes went astray too, landing in colour cells 1024-1027. Every text entry point now hands the CIAs back. The file's own note — "the frame runtime polls `$D012`, not a CIA, so nothing here misses them" — had overlooked `poll()` in the same package.
  
  Measured under xmega65: hello-world **256 bytes**, printing `Hello World!`; 2048 **3645 bytes**, drawing its board with exactly the two starting tiles its own generator predicts, at the indices the C64 build puts them.
- 08fa8b5: A web build is now something you can put in someone else's page, and it stops spending a fifth of a phone's screen on a border.
  
  `8bs build --target web` writes `8bitscript.js` — a loader with `mount()` and an `<eightbit-screen>` custom element — next to `program.wasm`, so embedding a program is two lines:
  
  ```html
  <script src="8bitscript.js"></script>
  <eightbit-screen src="program.wasm"></eightbit-screen>
  ```
  
  `index.html` is now a forty-line shell that calls that same loader, so the page we ship takes the path an embedder takes and cannot quietly drift away from it. The bundle also gains `embed.html` (the worked example of a screen inside an article), `worker.js` as a real file for pages whose CSP forbids `blob:` workers, and `coi.js`.
  
  **The border is measured, not assumed.** It was 24 px on every side always — 48 of every 368 horizontal pixels and a fifth of the height, which is a fine frame on a desktop and plainly wrong on a phone, where the picture renders at barely 1–2×. `borderFor()` now reads the box the picture is going into and returns 24 px at 3× and up with a mouse, an 8 px hairline between 2× and 3× or on any touch screen, and nothing at all below 2×. Measured in Chromium: a 1920×1080 desktop keeps its 24; an iPhone gets 0 in **both** orientations (portrait 393×852 and landscape 852×393); a 42rem article column gets the hairline. It reads the *container*, so a narrow column is treated like the small screen it is. `border="24"` pins it, and the headless `--screenshot` still always renders 24 — there is no viewport there to measure.
  
  **Cross-origin isolation is now explained rather than assumed.** The gate turns out to be on *sharing* memory, not on having it: without COOP/COEP, `new WebAssembly.Memory({shared: true})` succeeds and a shared-memory module instantiates fine, but `postMessage` of the buffer throws `DataCloneError: SharedArrayBuffer transfer requires self.crossOriginIsolated`. So the loader detects it and says which two headers are missing instead of failing blankly, `docs/web-embedding.md` gives the Cloudflare/Netlify/nginx/Apache/Vercel/Express forms, and `coi.js` installs a service worker that supplies them on a host that cannot — verified end to end against a static server sending none. It is opt-in, because `require-corp` then applies to the embedder's whole page.
  
  Embedded, a screen stays a guest: it sizes from a `ResizeObserver` on its container rather than the viewport, takes the arrow keys only while focused so the page still scrolls, goes fullscreen into its own element, and never posts to `/status`. The loader carries the worker inside itself and starts it from a `blob:` URL, so serving `8bitscript.js` from a different origin than the page works.

### Patch Changes

- cc04ede: Hello World runs on the C64 and the VIC-20, and reads as `Hello World` on both.
  
  **A constant added to an index folds into the address.** `screenRam[i + 250] = 32` — the second quarter of the C64 and VIC-20 screen-clearing loops — was computing `i + 250` in an 8-bit register and indexing with the result. The sum wraps at 255, so from `i = 6` on every iteration wrote back over the first quarter and the rest of the screen was never cleared: a real miscompile, visible as a screen full of uncleared garbage. The 6502's answer is the other association, `STA base+250,Y`, which is exact for every index Y can hold and is what those loops were written in terms of all along ("four constant offsets off one 8-bit index is the shape a 6502 wants"). It is also smaller and faster: C64 hello-world went from 481 bytes to 424.
  
  **The C64 and VIC-20 text packages draw in the mixed-case character set.** They selected the upper-case/graphics set and mapped only 64-95, leaving lower case at 97-122 — which in that set are graphics symbols, so `"Hello World"` drew as `H`, a graphic, three graphics, a space, `W`… Both ROMs were measured directly (`chargen-901225-01.bin`, `chargen-901460-03.bin`): the mixed-case set holds lower case at 1-26 and upper case at its own 65-90, exactly as the PET's does, and in the 96-127 block the two sets differ only at 105 and 122, which no block-graphics code uses. This is the same decision `@8bitscript/pet` took, for the same reason: it is the only set holding both cases, so it is the only one that can draw a string as it was written.
  
  **The VIC-20's hardware sheet carries its load address and RAM ceiling**, because a RAM expansion moves both: `$1001` unexpanded, `$0401` with the 3K (which fills `$0400-$0FFF`), `$1201` with 8K and up (the screen drops to `$1000`). Each is checked against the catalog's own `memory.ram` fact. `__ram_ceiling` joins `__ram_size` as a spelling of the linker's ceiling, for machines whose usable RAM does not end on a whole number of KiB — unexpanded, the VIC-20's ends at `$1E00`, which is 7.5.
  
  **Zero-page budgets for both.** The VIC-20 keeps a real polite shape and uses it: hello-world is 232 bytes and 4 zero-page bytes, and returns to a working BASIC. The C64 has no polite shape to keep — `setupVideo()` banks the KERNAL out and keeps it out, because the screen it sets up lives at `$E000` under the KERNAL ROM, so a C64 program that draws has already taken the machine — and takes the whole page.
  
  Measured under x64sc and xvic: both show `Hello World!`. The PET is unchanged at 108/108/127 bytes.
- c85fa23: Controller profiles live in `~/.config/8bitscript/`, not the project. An 8BitDo at one desk is not a `systems` block.
  
  Gamepad API button numbers are not written into VICE `.vjm` files — they are the browser's indices, not SDL's, and `!CLEAR` plus those numbers is how a working pad went dead the moment a profile appeared. FCEUX `--input1 gamepad` (the help text) is not what UpdateInput() matches — that is `GamePad.0`; lowercase `gamepad` is SI_NONE, an empty NES port, and it persists into `~/.fceux/fceux.cfg`.
- 6e1056b: Groundwork for the second 6502 machine: the backend stops assuming it is building for the PET.
  
  Three things that were the PET's are now the hardware sheet's or the machine's:
  
  - **The load address comes off the sheet.** It was a per-machine table in `mos/index.ts`, which the VIC-20 disproves — a RAM expansion moves BASIC's program area from `$1001` to `$1201`, so one machine has two. It is `build.defsym.__load_address` now, alongside `__ram_size`, and a catalog can carry machine-level build symbols (`"8bitscript".hardware.build`) rather than only per-option ones. A machine whose sheet lacks one is refused by name.
  - **Zero-page budgets are per machine.** `ZP_BUDGETS` pairs the polite budget (a program that returns to BASIC) with the owned one (a program that never does). The C64's polite range is nothing like the PET's: BASIC owns `$02-$8F` and the KERNAL `$90-$FF`, leaving `$FB-$FE` — four bytes, enough to print and return and nothing like enough for real state, which is the same trade the PET's own two budgets make.
  - **`@address` arrays lower.** They were refused by name; they now bind their label to the pinned address through a new `equate` directive in the assembler, so an `@address` array reaches hardware by exactly the path a data-section array reaches the program image by, and emits no bytes. This is what the C64 and VIC-20 packages are written against — `screenRam[cell] = 32` over the VIC's screen — 65 uses across the two.
  
  The PET is byte-for-byte unchanged by all of it (hello-world 108/108/127 across the 2001, 3032 and 8032; 2048 2440 bytes on a stock 4K 2001).
  
  The C64 is deliberately **not** added to `RELEASE_MACHINES` yet: a package's own emulator tests switch on from that list, so listing a machine before it can build a program runs them against one that cannot boot what they load. It joins when it builds. The next blocker is `asm6502` blocks, which reach the backend as raw text and need a 6502 assembly parser; `setupVideo()` in `@8bitscript/c64` uses them to bank the KERNAL out.
- b390ef3: PET text is now drawn in the machine's text character set, so a string reaches the screen as it was written — and nothing puts the old set back on the way out.
  
  `"Hello World"` is `Hello World`, not `HELLO WORLD`. The PET's graphics set holds exactly one case of the alphabet, so a text package that encodes for it silently flattens mixed-case text to capitals — answering a different question than the one the caller asked. The text set holds both cases, so `@8bitscript/pet/text` draws in that one and selects it first on the models that boot elsewhere. The 8032's editor ROM already boots into it, so `#fact(video.bootsInTextMode)` folds the write away there and no `$E84C` store reaches the binary at all.
  
  `video.characterSetSwapped` matters again as a result: the original 2001's 901447-08 ROM arranges the text set's two cases the other way round from every later model's (upper case stays at 1-26, lower case moves to 65-90 — verified glyph by glyph against the ROM, where code 8 is `H` and not `h`). A build for the 2001 gets that mapping; a build for anything else gets the other.
  
  **`restoreOnExit` is removed**, along with the `usesCharacterSet` scan and the `LDA $E84C`/`PHA` … `PLA`/`STA $E84C` pair it drove. Restoring the character set could never work: the bit is retroactive — it selects the ROM the video hardware reads for every cell already on screen — so writing the old value back re-rendered the text the program had just drawn, through the very set it switched away from in order to draw it. Measured on a 3032, `Hello World!` came back as `|ELLO OORLD!` above a correct prompt. A program now exits in the set it selected, which is the only state where what it drew still reads as what it wrote. A project that still sets `restoreOnExit` is told the option is retired rather than having it quietly ignored.
  
  Measured under xpet on all three models: the 8032 shows `Hello World!` over its own `ready.` and spends nothing; the 2001 shows `Hello World!` over an upper-case `READY.`, because its ROM's two sets agree on codes 1-26 where BASIC's prompt is drawn; a 3032 shows `Hello World!` over a lower-case `ready.`, which is the whole of what this costs. hello-world is 108 bytes on a 3032, against 116 when the restore was still being paid for.
- Updated dependencies [05764ff]
- Updated dependencies [57ccce1]
- Updated dependencies [fc0af15]
- Updated dependencies [cc04ede]
- Updated dependencies [c7fea69]
- Updated dependencies [188cd63]
- Updated dependencies [57ccce1]
- Updated dependencies [57ccce1]
- Updated dependencies [188cd63]
- Updated dependencies [188cd63]
- Updated dependencies [6e1056b]
- Updated dependencies [57ccce1]
- Updated dependencies [57ccce1]
- Updated dependencies [b390ef3]
  - @8bitscript/compiler@0.6.0
  - @8bitscript/atari8@0.6.0
  - @8bitscript/c128@0.6.0
  - @8bitscript/c64@0.6.0
  - @8bitscript/vic20@0.6.0
  - @8bitscript/pet@0.6.0
  - @8bitscript/mega65@0.6.0
  - @8bitscript/nes@0.6.0
  - @8bitscript/cx16@0.6.0
  - @8bitscript/web@0.6.0
  - @8bitscript/examples@0.6.0
  - @8bitscript/language-server@0.6.0
  - @8bitscript/studio@0.6.0

## 0.5.0

### Minor Changes

- 5666fe1: A program that changes the machine's character set now hands it back the way it found it. `8bitscript.config.ts` gains `restoreOnExit`, on by default: the prologue copies the PET's VIA PCR to the CPU stack and the epilogue writes it back, so a machine is returned in whichever mode it was launched in rather than a fixed one. It costs eight bytes and no RAM, and only a program whose finished code actually stores to `$E84C` pays them — which, since `@8bitscript/pet/text` no longer selects a character set at all (see that package's own note), means most programs pay nothing. `restoreOnExit: false` turns it off.
  
  One thing it deliberately does not try to do: un-draw. The PET's character-set bit is a single switch for the whole screen and it is retroactive, so a program that means to both return the machine and leave a readable screen has to blank the screen before it returns.
  
  The `hello-world` example no longer ends in a `while (true) waitFrame()` holding loop — it prints and returns, landing back in the BASIC `SYS` that started it. Its project file is also now named `8bitscript.config.ts`, the name the toolchain has preferred since 0.4.0.

### Patch Changes

- c8bd6c0: A release's assets are now one file per thing you can actually run. The attach step uploaded `dist/**/*` flattened, which scattered the web bundle's own internals across the release listing: `index.html`, `worker.js`, a Cloudflare `_headers` file, and a `program.wasm` that was a byte-for-byte copy of the `main.wasm` listed above it. The machine artifacts now upload as themselves and the web bundle uploads as a single `web-bundle.zip`, which is the only form it works in — its four files are one deployable unit, useless apart. The loose `.wasm` is left out for the same reason: it is already in the bundle, and alone it has no runtime to load it.
  
  `8bs build` also now says when an artifact's name is longer than the medium it is meant for can hold. CBM DOS gives a directory entry exactly sixteen characters for a filename and truncates anything longer with no error at all (measured with `c1541` on a real D64: a twenty-character name came back sixteen), so two builds whose names differ only past the sixteenth character are one file once they reach a floppy. It is a note rather than a refusal — every part of a generated name is there because it can change the bytes, so the build is valid, just awkward to carry to a disk.
- Updated dependencies [5754df7]
  - @8bitscript/pet@0.5.0
  - @8bitscript/examples@0.5.0
  - @8bitscript/studio@0.5.0
  - @8bitscript/compiler@0.5.0
  - @8bitscript/atari8@0.5.0
  - @8bitscript/c128@0.5.0
  - @8bitscript/c64@0.5.0
  - @8bitscript/cx16@0.5.0
  - @8bitscript/language-server@0.5.0
  - @8bitscript/mega65@0.5.0
  - @8bitscript/nes@0.5.0
  - @8bitscript/vic20@0.5.0
  - @8bitscript/web@0.5.0

## 0.4.1

### Patch Changes

- efabcfd: The web target's generated page now declares `viewport-fit=cover` and safe-area padding (no more drawing under a notch or the home-indicator strip), the `apple-mobile-web-app-capable` meta trio so Add to Home Screen launches full-screen with no browser chrome, and `resize()` now prefers `visualViewport` over `window.innerWidth`/`innerHeight` for the area actually visible. A best-effort, harmless-when-it-does-nothing nudge (`nudgeChromeCollapsed`) also tries to collapse a mobile browser's own toolbar on load and on rotation — there is no API that can guarantee this in an ordinary browser tab, only Add to Home Screen can.
- @8bitscript/atari8@0.4.1
  - @8bitscript/c128@0.4.1
  - @8bitscript/c64@0.4.1
  - @8bitscript/compiler@0.4.1
  - @8bitscript/cx16@0.4.1
  - @8bitscript/examples@0.4.1
  - @8bitscript/language-server@0.4.1
  - @8bitscript/mega65@0.4.1
  - @8bitscript/nes@0.4.1
  - @8bitscript/pet@0.4.1
  - @8bitscript/studio@0.4.1
  - @8bitscript/vic20@0.4.1
  - @8bitscript/web@0.4.1

## 0.4.0

### Minor Changes

- 1ab782e: `8bs build --release` builds every artifact a project's config declares for a release in one command: each release-ready target it lists, once per name in that target's own `release` array (a catalog preset, a project profile, or `{}` for the target's own default hardware), or once with its defaults when it lists none. The reusable `compile.yml` workflow calls it automatically when its `targets` input is left empty, so a project's release matrix — how many PET RAM/model variants, say — lives in one place, versioned with the project, instead of duplicated into CI. `compile.yml`'s `targets` also now accepts `target@profile:hardware=opts` entries for projects that would rather keep the matrix in CI.
  
  The project config file is now `8bitscript.config.ts`; the old `8bs.config.ts` name still loads, so no existing project needs to rename anything to pick up this release.

### Patch Changes

- @8bitscript/atari8@0.4.0
  - @8bitscript/c128@0.4.0
  - @8bitscript/c64@0.4.0
  - @8bitscript/compiler@0.4.0
  - @8bitscript/cx16@0.4.0
  - @8bitscript/examples@0.4.0
  - @8bitscript/language-server@0.4.0
  - @8bitscript/mega65@0.4.0
  - @8bitscript/nes@0.4.0
  - @8bitscript/pet@0.4.0
  - @8bitscript/studio@0.4.0
  - @8bitscript/vic20@0.4.0
  - @8bitscript/web@0.4.0

## 0.3.0

### Minor Changes

- 001c7e7: The web host draws the character grid from the same 8×8 bitmap font the screenshot path uses, and adds 2×2 block glyphs at codes 128–143 so a program can stamp PET-style digits.

### Patch Changes

- Updated dependencies [001c7e7]
  - @8bitscript/web@0.3.0
  - @8bitscript/examples@0.3.0
  - @8bitscript/studio@0.3.0
  - @8bitscript/compiler@0.3.0
  - @8bitscript/atari8@0.3.0
  - @8bitscript/c128@0.3.0
  - @8bitscript/c64@0.3.0
  - @8bitscript/cx16@0.3.0
  - @8bitscript/language-server@0.3.0
  - @8bitscript/mega65@0.3.0
  - @8bitscript/nes@0.3.0
  - @8bitscript/pet@0.3.0
  - @8bitscript/vic20@0.3.0

## 0.2.6

### Patch Changes

- 75cb131: `8bs run` keeps a muted VICE sound device open when the catalog said
  `+sound` (no speaker). GTK3 with no audio clock paces from vsync alone
  and stutters on Linux/Wayland; Pulse as a silent host clock does not.
  Screenshots still pass `+sound -warp`.
- @8bitscript/atari8@0.2.6
  - @8bitscript/c128@0.2.6
  - @8bitscript/c64@0.2.6
  - @8bitscript/compiler@0.2.6
  - @8bitscript/cx16@0.2.6
  - @8bitscript/examples@0.2.6
  - @8bitscript/language-server@0.2.6
  - @8bitscript/mega65@0.2.6
  - @8bitscript/nes@0.2.6
  - @8bitscript/pet@0.2.6
  - @8bitscript/studio@0.2.6
  - @8bitscript/vic20@0.2.6
  - @8bitscript/web@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies [0be3354]
  - @8bitscript/compiler@0.2.5
  - @8bitscript/language-server@0.2.5
  - @8bitscript/atari8@0.2.5
  - @8bitscript/c128@0.2.5
  - @8bitscript/c64@0.2.5
  - @8bitscript/cx16@0.2.5
  - @8bitscript/examples@0.2.5
  - @8bitscript/mega65@0.2.5
  - @8bitscript/nes@0.2.5
  - @8bitscript/pet@0.2.5
  - @8bitscript/studio@0.2.5
  - @8bitscript/vic20@0.2.5
  - @8bitscript/web@0.2.5

## 0.2.4

### Patch Changes

- Updated dependencies [c143dbe]
- Updated dependencies [7e28950]
  - @8bitscript/compiler@0.2.4
  - @8bitscript/pet@0.2.4
  - @8bitscript/language-server@0.2.4
  - @8bitscript/examples@0.2.4
  - @8bitscript/studio@0.2.4
  - @8bitscript/atari8@0.2.4
  - @8bitscript/c128@0.2.4
  - @8bitscript/c64@0.2.4
  - @8bitscript/cx16@0.2.4
  - @8bitscript/mega65@0.2.4
  - @8bitscript/nes@0.2.4
  - @8bitscript/vic20@0.2.4
  - @8bitscript/web@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [d58bf12]
  - @8bitscript/compiler@0.2.3
  - @8bitscript/pet@0.2.3
  - @8bitscript/atari8@0.2.3
  - @8bitscript/nes@0.2.3
  - @8bitscript/language-server@0.2.3
  - @8bitscript/examples@0.2.3
  - @8bitscript/studio@0.2.3
  - @8bitscript/c128@0.2.3
  - @8bitscript/c64@0.2.3
  - @8bitscript/cx16@0.2.3
  - @8bitscript/mega65@0.2.3
  - @8bitscript/vic20@0.2.3
  - @8bitscript/web@0.2.3

## 0.2.2

### Patch Changes

- ee330ca: The launcher's Running section is now a Running machines tree. Run and
  build pass `--size`, so the per-function breakdown prints in the terminal
  before the emulator starts, and the same numbers — plus live FPS on the
  web — show in an expandable tree next to Stop. VICE has no live CPU
  readout: its monitor pauses the machine on any command.
- Updated dependencies [ee330ca]
  - @8bitscript/compiler@0.2.2
  - @8bitscript/language-server@0.2.2
  - @8bitscript/atari8@0.2.2
  - @8bitscript/c128@0.2.2
  - @8bitscript/c64@0.2.2
  - @8bitscript/cx16@0.2.2
  - @8bitscript/examples@0.2.2
  - @8bitscript/mega65@0.2.2
  - @8bitscript/nes@0.2.2
  - @8bitscript/pet@0.2.2
  - @8bitscript/studio@0.2.2
  - @8bitscript/vic20@0.2.2
  - @8bitscript/web@0.2.2

## 0.2.1

### Patch Changes

- b48b19b: Hello-world on the PET was 835 bytes of program and 49 of zero page because
  the compiler still emitted both `#fact` branches of asciiToScreenCode, a
  runtime ASCII conversion and string loop for `text.print(0, "Hello World!")`,
  JSRs into PET `blank`'s empty color stubs, a 16-bit STA (zp),Y screen fill,
  a 12-byte waitFrame scratch window, an unrolled 32-bit frameRate multiply
  (211 bytes of setup), and zp for helpers the program never reaches. Fold
  constant `if`s and never-assigned globals after pruning dead writers, turn a
  literal print into stores of already-converted screen codes, skip the string
  table entry those stores no longer need, inline a single-site void call
  whose parameters are unused, lower a constant fill loop to STA abs,X, and
  multiply waitFrame's measured elapsed with a Russian-peasant loop that
  reuses the accumulator — measured on the same example: 331 program bytes /
  8 zp. The per-frame waitFrame routine is unchanged; the print and fill are
  fewer cycles as well as fewer bytes. `--size` still names the inlined
  `text_print` / `screen_blank` bodies and splits wait-frame setup from the
  per-frame routine, so the report does not collapse into one `main` bucket.
- Updated dependencies [b48b19b]
- Updated dependencies [09ae45f]
- Updated dependencies [152a9f2]
  - @8bitscript/compiler@0.2.1
  - @8bitscript/pet@0.2.1
  - @8bitscript/language-server@0.2.1
  - @8bitscript/examples@0.2.1
  - @8bitscript/studio@0.2.1
  - @8bitscript/atari8@0.2.1
  - @8bitscript/c128@0.2.1
  - @8bitscript/c64@0.2.1
  - @8bitscript/cx16@0.2.1
  - @8bitscript/mega65@0.2.1
  - @8bitscript/nes@0.2.1
  - @8bitscript/vic20@0.2.1
  - @8bitscript/web@0.2.1

## 0.2.0

### Minor Changes

- 7e4c24e: Bare Metal: external code-generation toolchains are removed. 8BitScript now carries its own 6502 and WebAssembly backends in `@8bitscript/compiler` (`mos` and `wasm`), which do not yet build any target. The catalog key `build.driver` is renamed `build.startup`. `examples/` is removed.
- 75d5f27: `8bs build --target <t> --size` prints a per-function breakdown of the
  built program under the existing memory line — every function that
  survived reachability pruning, plus each backend's own fixed-cost
  buckets (the wait-frame runtime, the BASIC stub, a wasm module's own
  section framing), largest first, each with its own share of the total.
  Opt-in: without the flag, `8bs build` prints exactly what it always
  has.
- d7c558f: 0.2.0 is scoped to the Commodore PET and the web. `8bs build` and `8bs
  run` now refuse the other seven machines (vic20, c64, c128, atari8,
  nes, cx16, mega65) by name; their packages are unchanged and stay in
  the workspace, parked until their native backends land after 0.2.0.
  
  `@8bitscript/examples` is new: `hello-world`, the program both
  backends are built against, shipped with the CLI the way Studio is.
  The VS Code extension lists it by default and reads it from the
  package's own manifest rather than a fixed directory; it also now
  recognizes bun's lockfile alongside pnpm, npm, and yarn.
- 16e92f4: The `mos` and `wasm` backends in `@8bitscript/compiler` now emit for
  real. `8bs build` and `8bs run` work end to end for both 0.2.0 targets:
  `packages/examples/hello-world`, unmodified, builds, runs, and renders
  its own mixed-case "Hello World!" correctly on a real Commodore PET
  (checked against the `xpet` emulator) and in a real browser (checked
  against a real `--screenshot` run and the browser runtime's own
  generated page script). The `wasm` backend gained `&`, `|`, `^`, `<<`,
  and unsigned `>>` as real lowered operators (wasm's native
  `i32.and`/`i32.or`/`i32.xor`/`i32.shl`/`i32.shr_u`), needed once
  `@8bitscript/web/screen`'s own color masking (`value & 15`) became the
  first real caller. The web target's own text rendering (both the real
  browser canvas and the `--screenshot` bitmap font) now covers lower
  case too, matching what the checker's portable character set and the
  PET's own `asciiToScreenCode` have allowed all along — it previously
  covered upper case only, silently drawing every lower-case letter as a
  blank cell.
- a4aa759: Both native backends (`mos` and `wasm`) now compile only what a
  program's entry can actually reach, instead of every function and
  global an import brings along whether it's called or not. Measured on
  the real, unmodified `hello-world` example: the PET build shrank from
  1132 to 835 bytes of program (26% smaller, plus 101 to 49 bytes of
  RAM), and the web build's `.wasm` shrank from 614 to 408 bytes (34%
  smaller) — one `@8bitscript/text` import used to pull in `putChar`,
  `putColor`, `setColor`, `setReverse`, and `printNumber`'s whole
  decimal-digit loop alongside the `print()` a program actually calls.
  No language, API, or output behavior changed — only what nothing ever
  uses is gone.

### Patch Changes

- 57c262f: Normalized spelling in comments, docs, and user-facing strings
  (package descriptions, editor hover/grammar text, diagnostic prose) to
  match the spelling the code's own identifiers already use — `color`
  not `colour`, `behavior` not `behaviour`, `initialize`/`optimize`/
  `recognize` rather than `-ise`, and a handful of one-off words. No
  behavior, API, or identifier changed; this is text only. The `GREY`
  constant (`BorderColor.GREY`, `BackgroundColor.GREY`) and its prose
  mentions are left alone — that one's a real public API surface, a
  separate decision from a text-only pass like this.
- Updated dependencies [7e4c24e]
- Updated dependencies [75d5f27]
- Updated dependencies [d7c558f]
- Updated dependencies [16e92f4]
- Updated dependencies [3827a1c]
- Updated dependencies [a4aa759]
- Updated dependencies [57c262f]
  - @8bitscript/atari8@0.2.0
  - @8bitscript/c64@0.2.0
  - @8bitscript/c128@0.2.0
  - @8bitscript/compiler@0.2.0
  - @8bitscript/cx16@0.2.0
  - @8bitscript/language-server@0.2.0
  - @8bitscript/mega65@0.2.0
  - @8bitscript/nes@0.2.0
  - @8bitscript/pet@0.2.0
  - @8bitscript/studio@0.2.0
  - @8bitscript/vic20@0.2.0
  - @8bitscript/web@0.2.0
  - @8bitscript/examples@0.2.0

## 0.1.3

### Patch Changes

- 7547105: The VS Code extension now ships a Marketplace icon (the pixel-8 mark from
  the favicon, on the same purple/cream palette) instead of using the
  Marketplace's generic default.
- 47eaff5: Pin the workspace's `packageManager` to pnpm 12.3.4 (up from 12.1.0) and
  recommend the `8bitscript.8bitscript-lang` VS Code extension in this
  repo's `.vscode/extensions.json`. The VS Code extension also gains a
  Marketplace icon (the pixel-8 mark, on the same purple/cream palette as
  `docs/assets/favicon.svg`) instead of falling back to the generic default.
- Updated dependencies [7547105]
- Updated dependencies [47eaff5]
  - @8bitscript/atari8@0.1.3
  - @8bitscript/backend-6502@0.1.3
  - @8bitscript/backend-web@0.1.3
  - @8bitscript/c64@0.1.3
  - @8bitscript/c128@0.1.3
  - @8bitscript/compiler@0.1.3
  - @8bitscript/cx16@0.1.3
  - @8bitscript/language-server@0.1.3
  - @8bitscript/mega65@0.1.3
  - @8bitscript/nes@0.1.3
  - @8bitscript/pet@0.1.3
  - @8bitscript/studio@0.1.3
  - @8bitscript/vic20@0.1.3
  - @8bitscript/web@0.1.3

## 0.1.2

### Patch Changes

- b9aea09: The editor talks to `8bs lsp` with a thin stdio client instead of
  `vscode-languageclient`, so the VSIX is tens of kilobytes. Marketplace
  publish no longer uses vsce's 180-second gallery timeout.
- Updated dependencies [b9aea09]
  - @8bitscript/atari8@0.1.2
  - @8bitscript/backend-6502@0.1.2
  - @8bitscript/backend-web@0.1.2
  - @8bitscript/c64@0.1.2
  - @8bitscript/c128@0.1.2
  - @8bitscript/compiler@0.1.2
  - @8bitscript/cx16@0.1.2
  - @8bitscript/language-server@0.1.2
  - @8bitscript/mega65@0.1.2
  - @8bitscript/nes@0.1.2
  - @8bitscript/pet@0.1.2
  - @8bitscript/studio@0.1.2
  - @8bitscript/vic20@0.1.2
  - @8bitscript/web@0.1.2

## 0.1.1

### Patch Changes

- d56d494: Added a "How it compares" section to the root README, docs/about, and
  the VS Code extension's README, positioning 8BitScript against BASIC,
  hand-written assembly, and C with measured compiled-size numbers.
- Updated dependencies [d56d494]
  - @8bitscript/atari8@0.1.1
  - @8bitscript/backend-6502@0.1.1
  - @8bitscript/backend-web@0.1.1
  - @8bitscript/c64@0.1.1
  - @8bitscript/c128@0.1.1
  - @8bitscript/compiler@0.1.1
  - @8bitscript/cx16@0.1.1
  - @8bitscript/language-server@0.1.1
  - @8bitscript/mega65@0.1.1
  - @8bitscript/nes@0.1.1
  - @8bitscript/pet@0.1.1
  - @8bitscript/studio@0.1.1
  - @8bitscript/vic20@0.1.1
  - @8bitscript/web@0.1.1
