# 8BitScript launcher — redesign prototypes

Two design directions for the side-bar launcher, drawn as static HTML on VS Code's own
colour variables and rendered to PNG in **Dark Modern** and **Light Modern**. Nothing here
changes the extension: this is the thing to look at and choose from **before** anything is
built. The wiring forks implement the contract in [§5](#5-what-each-control-does-the-contract).

Look first, read second:

| Direction | What it is | Screenshots |
| --- | --- | --- |
| **A — launch card** | One card per run, read top to bottom as a sentence: *program → system → inputs → where to run*. Three labelled run buttons at the foot. | [`shots/dark/a/`](shots/dark/a) · [`shots/light/a/`](shots/light/a) |
| **B — program list** | Programs are rows, like tests in a test explorer. Every row has its own three run buttons; the system is chosen once above the list. A drawer under the selected row holds the rarely-touched things. | [`shots/dark/b/`](shots/dark/b) · [`shots/light/b/`](shots/light/b) |

Every state is drawn in both directions (`shots/<theme>/<a|b>/<state>-<width>.png`):

| State | File | What it shows |
| --- | --- | --- |
| 01 | `01-program-3x3-{260,300,420}` | Vegas Nights, **3×3 Slot** on C64, three run buttons, Native last used |
| 02 | `02-program-5x5-inputs-{300,420}` | **5×5 Ways Slot** with the Inputs form filled (SEED, FORCE_BONUS, START_CREDITS, THEME) and the exact command shown |
| 03 | `03-runtime-disabled-300` | A runtime unavailable, with the reason (Tile Test on the VIC-20 has no WASM runtimes) |
| 03b | `03b-runtime-disabled-web-300` | The Web system: Native is unavailable because there is no native emulator |
| 04 | `04-running-{260,300}` | Two live runs of one program (WASM in the editor *and* native), Stop and Command on each, Recent history with a failed build |
| 05 | `05-single-program-300` | A one-program project: no program picker, fewer rows |
| 06 | `06-empty-300` | No project: one clear first action |
| 07 | `07-notice-missing-emulator-300` | A fixable problem (emulator not installed, packages missing) with one-click fixes; the default runtime moves off Native |
| 08 | `08-system-options-300` | System options open (A: inline panel; B: the system menu) |
| 10 | `a/10-program-picker-300` | A's program picker, grouped, filterable, with a long name truncated |
| 11 | `11-components-300` | Every control in default / hover / focus / disabled / selected |

The same pages are in [`html/`](html). Open one in any browser: `html/a-01-program-3x3-300.html`
(add `?theme=light` for Light Modern). They are interactive enough to judge feel: disclosures
open, chips select, and the hint under the run buttons follows hover and focus.

**Regenerate** (needs Node, a Chromium-family browser and the editor's `codicon.ttf`):

```bash
node build.mjs                 # themes, pages, screenshots
node build.mjs --no-shots      # pages only
node build.mjs --only=a/02 --theme=dark
```

The browser defaults to Brave (`DESIGN_BROWSER` overrides it). It runs headless on a throw-away
profile and never touches a running session. `sharp`, if you point `DESIGN_SHARP` at it, shrinks
the PNGs about 3×. The codicon font is copied once from the editor install (`DESIGN_CODICON`) into
`.cache/` and is not committed. Theme colours are read from the editor's `dark_modern.json` and
`light_modern.json` (`DESIGN_THEME_DIR`), then committed as `themes/*.css`.

## 1. What is wrong today (from the audit)

- **Run means three different things and does not say which.** Plain Run silently opens the
  in-editor WASM tab for PET, VIC-20 and X16 and the native emulator for C64
  (`WEB_PREVIEW_READY` + the `preferWebPreview` setting). The only hint is a tiny "· wasm".
- **Native is buried.** It is an item in a chevron sliver next to Run, and the same sliver is the
  only place the system is chosen — picking one there launches nothing. That is why native seems
  to need the WASM run first. It does not; it is just hidden.
- **There is no "open the WASM build in my browser" command** (only a button inside the Preview tab).
- **Mystery file icons.** Two identical "page" glyphs: one beside the Program dropdown opens the
  *project details* tab; one at the end of the Build row opens the entry file — of the *main*
  program, ignoring the program you picked (`openEntry`, `runner.cjs`).
- **Names collide.** The "Program" dropdown picks a *project*; "Entry" picks a *program*.
- **Build and Boot are unexplained.** Build writes `dist/*.prg` and says nothing; Boot opens a bare
  emulator and is jargon.
- **No way to run one thing with its variables.** There is no `--define`, no config `env`. Vegas
  Nights works around it with a separate entry file per variant (`slot3x3-lose`, `-lines`, …).

## 2. The model

```
Project            a folder with an 8bitscript.config.8bs
 └─ Program        a work unit (config `programs`): its own entry, targets, optional title,
     │             description, group and inputs
     ├─ System     machine + hardware + region + language — limited to the program's targets
     ├─ Inputs     values for the program's `define`s, each with a default
     └─ Runtime    where it runs:  Editor tab (WASM)  ·  Browser (WASM)  ·  Native (emulator)
```

One click on one of the three runtime buttons launches. The last runtime used for a program is
remembered and drawn as the filled (primary) button, so the primary action is always "do what I did
last time" and never a guess.

### Vocabulary

| Old | New | Why |
| --- | --- | --- |
| "Program" dropdown (selects a project) | **Project** | the folder |
| "Entry" dropdown (selects a program) | **Program** | matches config `programs` |
| "System" (hidden in the Run sliver) | **System**, always visible | machine + hardware + region + language |
| Run (split button, hidden rule) | **Editor · Browser · Native** | three buttons, each says where |
| "Run in emulator" (menu item) | **Native** | one word |
| Preview tab / "Open in browser" / "Open in emulator" | **Editor** / **Browser** / **Native** | the same three words everywhere |
| Build | **Build** (tooltip: "Compile … to dist/<program>.prg and show the size report. Nothing runs.") | says what it produces |
| Boot (no program loaded) | **Open bare emulator** (in the ⋯ menu) | plain words; rarely needed |
| "Show project details" file glyph | **Project details** (ⓘ in the header, and in Tools) | an info affordance, not a file |
| "Open entry file" file glyph | the **source path** is itself the link | it names the file it opens |
| "fitted as …" link | **System** summary + **Options** | labelled, with a gear |
| Running machines | **Running** | |
| (none) | **Inputs** | new |

## 3. Direction A — launch card

Read top to bottom: the program (title, description, source file), the system (chips + summary +
Options), Inputs (collapsed, with a count and "N changed"), then **Run in** with the three buttons,
a one-line hint of exactly what the primary does, and a quiet row for Build, Command and ⋯.

- **Wins:** the clearest "what am I about to run" of the two: everything about one run is in one
  place, in order. Labelled buttons never need a tooltip. The inputs form has room.
- **Costs:** program switching is a dropdown (one extra click, and a long list needs the filter in
  state 10). Only one program is visible at a time; you cannot see what is running per program.
- **Best for:** projects with a few programs, newcomers, and anyone who sets inputs.

## 4. Direction B — program list

Two selectors on top (Project, System), a filter, a legend of the three runtimes, then programs
grouped (Slots / Labs / Test rigs, collapsible). Each row carries three icon buttons, always
visible, the same icons as the legend. A green dot and green icons mark what is running. Selecting
a row opens a drawer (description, source, Inputs, Build, Command).

- **Wins:** scales to the twenty programs Vegas Nights has today; any program is **one click** from
  any runtime without opening anything; live status is visible in the list.
- **Costs:** the buttons are icon-only (tooltips, an always-visible legend and aria-labels carry
  the words), so it relies on the legend being read once; the system applies to every row, so
  comparing the same program on two machines means changing the selector.
- **Best for:** projects with many programs, repeated test-and-tweak work.

**Recommendation:** B, with A's drawer as its detail view (the labelled three-button row appears in
B's drawer in the single-program state, 05). It matches the stated goal — launch the 3×3 slot and the
5×5 slot independently, in any runtime, without setting up a card first — and the legend plus
tooltips cost one reading. If the owner prefers explicit words on every button, A is the safer pick.

## 5. What each control does (the contract)

`runtime` is `editor | browser | native`. `inputs` is `{ NAME: value }` for changed inputs only.
"New" means the extension has no such command or message today.

| Control | Triggers | Extension command | CLI |
| --- | --- | --- | --- |
| **Editor** button | `{type:'run', runtime:'editor', program, system, inputs}` | `8bitscript.run` with `runtime` (replaces the `web` boolean; `web:true` ≡ `editor`) → `runInPreviewTab` | `8bs run <t> --program <p> --web --no-open --port 0 [--define N=v]` |
| **Browser** button | `{type:'run', runtime:'browser', …}` — **new** | `8bitscript.run` with `runtime:'browser'`; tracked as a run like any other | `8bs run <t> --program <p> --web [--define N=v]` (opens the system browser) |
| **Native** button | `{type:'run', runtime:'native', …}` | `8bitscript.run` with `runtime:'native'` (today `web:false`) | `8bs run <t> --program <p> [--define N=v]` |
| **Build** | `{type:'build', program, system}` | `8bitscript.build` | `8bs build --target <t> --program <p>` |
| **Command** (toggle) | none — shows/hides the panel | — | the exact line above for the primary runtime |
| copy (⧉) | `{type:'copy', text}` | `vscode.env.clipboard` | — |
| **⋯ → Open bare emulator** | `{type:'boot', system}` | `8bitscript.boot` | `8bs boot <t>` |
| **⋯ → Copy command / Reveal in Explorer** | `{type:'copy'}` or `{type:'reveal'}` | clipboard / `revealInExplorer` | — |
| **Source path** | `{type:'openSource', program}` | `8bitscript.openEntry` **with `program`** (fixes: it ignores the selection today) | — |
| **Program** picker | `{type:'select', program}` | state only (`8bitscript.program` setting, per project) | — |
| **System** chips / menu | `{type:'select', system}` | state only (`8bitscript.system` / `namedSystem`) | — |
| **Options** (gear) | none — toggles the inline panel (A) / opens the menu (B) | — | `--hardware`, `--pal`, `--locale` |
| **Save as a named system…** | `{type:'saveSystem'}` | `8bitscript.saveSystem` | — |
| **Hardware, region & language…** (B) | `{type:'configureSystem'}` | `8bitscript.configureSystem` | — |
| **Inputs** fields | `{type:'input', program, name, value}` | state only (`workspaceState`, per program) | `--define NAME=value` (see §9) |
| **Reset to defaults** | `{type:'inputsReset', program}` | state only | — |
| **Stop** (a run) | `{type:'stop', runId}` | `8bitscript.stop` with `runId` | — |
| **Show tab** (Editor run) | `{type:'focus', runId}` | `8bitscript.previewTab.show` | — |
| **Open in browser** (Editor run) | `{type:'openInBrowser', runId}` | the Preview tab's existing "Open in browser" | the run's local URL |
| **Run again** (Recent) | `{type:'rerun', historyId}` | `8bitscript.run` with the stored arguments | the stored command |
| **Install x64sc / Install packages** | `{type:'fix', kind}` where kind is `emulator` or `packages` | `8bitscript.doctorSetup` / `8bitscript.install` | — |
| **Run Doctor** | `{type:'doctor'}` | `8bitscript.doctor` | `8bs doctor` |
| **Use Native instead** (reason box) | `{type:'select-runtime', runtime}` | state only (changes the remembered primary) | — |
| **Studio / Doctor / Project details** (Tools) | `openStudio` / `doctor` / `showProject` | existing commands, unchanged | — |
| **ⓘ** (project header) | `{type:'details'}` | `8bitscript.showProject` | — |
| **Open Folder… / Try an example… / What is 8BitScript?** | — | `vscode.openFolder` / `8bitscript.launchExample` / opens the docs | — |

Runs are independent: starting Editor does not stop Native, and a second Editor run of the same
program replaces only the previous Editor run of that program. Each run has a `runId`; Running shows
all of them. A click never launches anything but the button it is on.

## 6. Which runtimes are available

Availability is computed per *(program, system)* and drawn, never silently applied.

| Case | Editor | Browser | Native | Shown as |
| --- | --- | --- | --- | --- |
| Normal | ✓ | ✓ | ✓ | three live buttons |
| System has no emulator (Web) | ✓ | ✓ | ✗ | Native disabled; neutral note: "The Web system runs in a browser, so it has no native emulator." |
| Program/system has no WASM port (uses `asm6502` or a package the WASM build lacks) | ✗ | ✗ | ✓ | Editor and Browser disabled; neutral note naming the reason (state 03) |
| Emulator not installed | ✓ | ✓ | ✗ | Native disabled; **amber** note with **Install x64sc** and **Run Doctor** (state 07); default moves to Editor |
| Program does not target the system | — | — | — | the system chip is disabled and struck through; in B the program row is dimmed with every button disabled |

How a disabled button behaves (all of it must hold, not just the look):

- It stays **focusable** and uses `aria-disabled="true"`, not the `disabled` attribute, so a keyboard or
  screen-reader user can reach it and hear *why*. Its `aria-describedby` points at the reason note.
- Clicking or pressing Enter on it does nothing except move focus to the reason.
- Its tooltip is the reason, not "disabled".
- The primary never lands on a disabled button. If the remembered runtime becomes unavailable the
  primary moves to the next available one and the note says so. With no memory for a program the
  default is Editor when `preferWebPreview` is on (it is by default) and Native otherwise; Browser is never the default.
- Neutral (grey) notes mean "this combination cannot work"; amber notes mean "you can fix this".

## 7. State and persistence

| What | Where | Key |
| --- | --- | --- |
| Selected project / program / system | settings (existing) | `8bitscript.project`, `program`, `system`, `namedSystem` |
| Last runtime per program | `workspaceState` | `launcher.runtime[<project>][<program>]` — **new** |
| Input values per program | `workspaceState` | `launcher.inputs[<project>][<program>]` — **new**; not in `settings.json` (they are run scratch, not preferences) |
| Open disclosures (Inputs, Command, group collapse) | `workspaceState` | `launcher.ui` — **new** |
| `8bitscript.preferWebPreview` | kept; now only the *default* runtime before anything is remembered | |

## 8. Accessibility

- Landmarks: the launcher is `<main>`; each card/section has a heading or `aria-label` ("3×3 Slot launcher", "Programs", "Running").
- **Runtime buttons** are a `role="group"` named "Run in" holding three buttons. Each has a complete
  `aria-label`: "Run 3×3 Slot on Commodore 64 in native emulator (default)". Icons are `aria-hidden`.
- **Chips** are a `role="radiogroup"` named "System" with roving `tabindex` (arrow keys move, Space/Enter selects).
- **Program list (B)** is `role="list"`; groups are `role="group"` with a disclosure button each
  (`aria-expanded`); the selected row has `aria-current="true"`. The inline run buttons are a named group
  ("Run 3×3 Slot in") of three buttons, each fully labelled, so the icon-only look is not icon-only to a screen reader.
- Disclosures are real buttons with `aria-expanded` and `aria-controls`; the hint under the run buttons is
  `aria-live="polite"` and changes with focus as well as hover.
- **Tab order (A):** project ⓘ → program picker → source link → system chips (one stop) → Options →
  Inputs → Editor → Browser → Native → Build → Command → ⋯ → running rows (Show tab, Open in browser,
  Stop, Command) → Recent (Run again) → Tools.
  **(B):** Project → System → filter → program groups (arrow keys within the list) → row run buttons → drawer
  → running rows → Tools.
- Focus is the editor's `focusBorder`, 1px, offset 2px, on every control (state 11 shows it).
- Colour is never the only signal: running has a dot **and** a "Running" title and elapsed time; failure has a red dot **and** the words "Build failed".
- Contrast comes from the theme's own variables; both Dark Modern and Light Modern are drawn.
- Narrow (≤ 256px container width) switches the run buttons to icon-over-label and drops the project subtitle; nothing else changes.

## 9. What this needs from the toolchain (not part of this PR)

The launcher UI can be built today as drawn **except** for these, each a small change elsewhere:

1. **Program metadata** in the config schema: `programs.<name>.{title, description, group, define}`. The schema
   forbids unknown keys today (`additionalProperties: false`), so this is a schema + CLI change.
2. **`define`**: the compiler has no run-time or build-time input. Proposed: a config `define: { SEED: { type:'number', default: 7 } }`
   per program, a `--define NAME=value` flag on `run`/`build`, and an `import { SEED } from "#define"` intrinsic folded at compile
   time (the repo rule: knowable at compile time ⇒ compile time). Until it exists, the Inputs section stays hidden.
3. **A capability report**: `8bs targets --json` (or a new `8bs capabilities --json`) answering, per *(program, machine)*:
   `{ editor: {ok, reason}, browser: {ok, reason}, native: {ok, reason, emulator, installed} }`. Today the extension keeps
   `WEB_PREVIEW_READY`, `NO_BARE_EMULATOR` and `MACHINE_TARGETS` as hard-coded sets; the redesign replaces them.
4. **Config parsing**: the extension reads `programs` with a regex over the config source (`projects.cjs`). It breaks on spreads,
   computed keys and constants. The CLI should print the resolved programs as JSON and the extension should read that.
5. **`8bs run <t> --web` without `--no-open`** is the existing Browser runtime; document it in the CLI usage text (it is missing there).

## 10. View title and the rest of the extension

| Today | After |
| --- | --- |
| `$(book)` toggle examples | removed from the title; Examples become a group in the Project picker |
| `$(rocket)` Launch Studio | moved into **Tools → Studio** |
| `$(pulse)` Doctor, `$(refresh)` Refresh | kept in the title bar |
| `…` overflow: Launch App/Example, Configure System, Show Project, Save as System, Choose Emulators, Controller Setup, dev-extension toggles | kept; Launch App/Example merge into the Project picker; Show Project is also **Tools → Project details** |
| `Build`, `Boot`, two page glyphs, "fitted as", Studio split, Quick Launch heading | gone (see §2) |
| Configure System / Project / Doctor / Controller tabs | unchanged here; they are a separate pass |

Command ids stay (`8bitscript.run`, `build`, `boot`, `stop`, `openEntry`, `showProject`, …) so keybindings,
`tasks.json` and the Preview tab keep working. The two additive changes are the `runtime` argument on
`8bitscript.run` (the `web` boolean stays as an alias) and `program` on `8bitscript.openEntry`.
`8bitscript.system`'s description still points at a System dropdown that no longer exists, and the README
draws the removed dropdown; both are stale today and the wiring pass should fix them.

## 11. Decisions for the owner

1. **A or B** (or B with A's drawer)? The screenshots are the evidence.
2. **Default runtime** for a program with no history: Editor (WASM) or Native?
3. **Should Browser exist as its own button**, or is it enough as "Open in browser" on a running Editor run? (Drawn as its own button, because you asked for it.)
4. **Where do inputs live**: per program in the config (`define`), set in the launcher, remembered per workspace. Is that the right split, or should some be checked in?
5. **Icons:** Editor is the "open preview" glyph, Browser the globe, Native the desktop. Say if Editor should be a different glyph.
6. **Test rigs** (the four `slot3x3-*` helpers) collapsed by default, or hidden unless a setting turns them on?

## Design system notes

4px grid; 28px controls (24px small); 6px card radius, 4px control radius; 13px body text, 11px
uppercase section labels at 0.06em; one icon family (codicons, as in native views); colours only from
`--vscode-*` variables, so any theme works. Primary = `button.background`; secondary =
`button.secondaryBackground`; selection = `list.activeSelectionBackground`; running = `testing.iconPassed`;
errors = `errorForeground`. The side-bar title row and its icons are native chrome, drawn only for context.
