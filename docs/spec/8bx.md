---
title: "8BX specification"
nav_order: 1
---

# 8BX specification

The design record for `.8bx`, 8BitScript's declarative composition language
— 27 parts, 142 sections, kept as the spec was written and amended. It is a
plan and a set of rules, not a description of what the compiler does today:
for that, read [the manual](../language/index.md), and for which of these
sections the compiler has landed and which are still ahead, [8BX: composition
for 8BitScript](../project/8bx.md).

**Status:** proposed; §2.6, §4.3, §4.5–§4.8 and §74 decided 2026-09-16.
Written against trunk at compiler 0.10.x; the PR sequence in §135 has landed
through PR 15 as of 0.11.0. Sections are numbered so other documents can
cite them as `§N`.

> **8BX describes composition and relationships, not pixels, rectangles,
> widgets, or a DOM.** An 8BX component may produce visible graphics,
> machine code, data tables, audio behavior, interrupt handlers, state,
> resources, child components — or nothing visible at all (§137).

## Part 1 — Goal & Design Rules

### 1. Goal

8BX should become to 8BitScript roughly what TSX is to TypeScript:

- `.8bs` is normal 8BitScript.
- `.8bx` is normal 8BitScript **plus declarative element/component expressions**.
- Every normal 8BitScript construct that is legal in `.8bs` should also be legal in `.8bx`.
- 8BX must not be tied to websites, DOM concepts, character grids, retained-mode UI, or any particular rendering technology.
- 8BX components must be capable of describing:
- normal application UI
- games
- scenes
- sprites
- tilemaps
- bitmap graphics
- software renderers
- line/vector graphics
- raycasters and 3D engines
- raster kernels
- demoscene effects
- interrupt schedules
- audio systems
- chiptune trackers
- waveform editors
- graphics editors
- operating-system desktops
- file managers
- GEOS-like applications
- 8BitScript Studio itself
- nonvisual services
- storage systems
- input systems
- memory/banking systems
- arbitrary programmer-defined abstractions

The central rule should be:

> **8BX describes composition and relationships, not pixels, rectangles, widgets, or a DOM.**

An 8BX component may produce visible graphics, machine code, data tables, audio behavior, interrupt handlers, state, resources, child components, or nothing visible at all.

### 2. Non-negotiable design rules

These should be written into the language specification before implementation begins.

#### 2.1 `.8bx` is a language mode, not a template preprocessor

Do not implement:

```text
8BX template
    ↓
generated .8bs text
    ↓
8BitScript compiler
```

Implement:

```text
.8bs ─────┐
          ├── lexer → parser → AST → semantic pipeline → IR → backend
.8bx ─────┘
   +
element/component grammar
```

8BX belongs inside the compiler.

The compiler must understand the source locations, types, components, props, state, children, and relationships directly.

#### 2.2 8BX must preserve the existing 8BitScript philosophy

No feature should silently introduce:

- garbage collection
- boxing
- heap allocation
- a JavaScript runtime
- a virtual DOM
- a retained component tree
- runtime reflection
- runtime type metadata
- implicit dynamic memory
- hidden event dispatch machinery
- mandatory frame redraws

The composition tree should usually disappear during compilation.

If the compiler knows something at compile time, it should resolve it at compile time.

#### 2.3 8BX must never assume a framebuffer

These are all valid potential components:

```8bx
<CharacterScreen />
<TileMap />
<SpriteLayer />
<Bitmap />
<VectorRenderer />
<Raycaster />
<RasterKernel />
<AudioMixer />
<Tracker />
<FileSystem />
```

None should be considered more fundamental than another.

#### 2.4 8BX must never assume that a component is visual

This must be completely legitimate:

```8bx
<Game>
    <InputSystem />
    <SaveSystem />
    <Physics />
    <Audio />
    <World />
</Game>
```

So must this:

```8bx
<RasterKernel>
    <RasterIRQ />
    <SpriteMultiplexer />
    <CopperBars />
</RasterKernel>
```

And this:

```8bx
<OperatingSystem>
    <FileSystem />
    <Scheduler />
    <WindowManager />
    <Applications />
</OperatingSystem>
```

#### 2.5 Native access remains first-class inside 8BX

Ordinary hardware calls remain possible inside an `.8bx` component — they are ordinary 8BitScript expressions:

```8bs
memory.write(...);
```

Machine code does not live in `.8bx`. A component reaches it by importing the `.8bs` function that holds it (2.6):

```8bs
// raster.8bs
export function irq(): void {
    asm6502 {
        lda #$06
        sta $d020
    }
}
```

```8bx
// RasterThing.8bx
import { irq } from "./raster.8bs";

export component RasterThing() {
    return <RasterIRQ line={72} handler={irq} />;
}
```

A programmer must never hit a point where the solution is:

> "8BX won't let me get close enough to the hardware."

— and the answer is always the same one sentence away: *put it in an `.8bs` file and import it.*

#### 2.6 File roles: `.8bs` is code, `.8bx` is composition

An `.8bx` file is a grammar-level superset of `.8bs` (§1, §3) — one lexer, one parser, one flag. Cleanliness is enforced by *diagnostics*, not by a second grammar. Two tiers, decided 2026-09-16:

##### A — hard rules

- `asm6502` blocks are refused in `.8bx` (`8BS12xx`). Machine code lives in `.8bs` and is imported.
- An `.8bx` file cannot be a program entry (4.3).

##### B — lint, on by default

- A top-level `function` in `.8bx` whose body contains no element expression, or a top-level `let`, is a warning: *"this is ordinary 8BitScript; move it to an `.8bs` module and import it."*
- Component methods (§39) and component `state` (§36) are exempt — they are what `.8bx` is for.
- Expressions inside `{}` are never linted: they are ordinary 8BitScript by design (§20, §21).
- A project may switch the lint off (`bx: { strict: false }` in `8bitscript.config.ts`); it cannot switch the hard rules off.

Rejected: a restricted `.8bx` grammar (imports, components, consts and types only). It would get cleanliness for free and pay for it with a second parser table — the forked compiler §138 forbids.

## Part 2 — Files, Imports & Source Kinds

### 3. Language relationship

The relationship should formally be:

| File | Grammar |
| --- | --- |
| `.8bs` | Core 8BitScript |
| `.8bx` | Core 8BitScript + 8BX element/component expressions |

Conceptually:

```text
8BS grammar
   │
   ├────────────── .8bs
   │
   └── + BX grammar ── .8bx
```

This is the same broad relationship as:

```text
TypeScript → .ts
TypeScript + JSX → .tsx
```

but the runtime semantics are entirely ours.

### 4. Source files

#### 4.1 First-class `.8bx`

These should all be valid:

```text
src/main.8bs
src/App.8bx
src/Game.8bx
src/Player.8bx
src/audio/Tracker.8bx
src/video/RasterKernel.8bx
```

#### 4.2 Cross-importing

`.8bx` must be able to import `.8bs`:

```8bs
import { physics } from "./physics.8bs";
```

`.8bs` should also be able to import ordinary exported functions, constants, types, etc. from `.8bx`.

An `.8bs` file simply cannot contain 8BX element syntax itself.

#### 4.3 The program entry is always `.8bs`

A program starts from an `.8bs` file. This is refused, with a diagnostic that names the rule:

```ts
export default {
    entry: "src/main.8bx"   // refused: a program entry is .8bs
};
```

The linker already enforces the shape of this: the entry module exports exactly one thing, a parameterless function (`checkEntryExports`). A `component` is not a function, so an `.8bx` that exports one cannot be an entry — the rule here only makes the message say so plainly rather than through the generic entry-exports diagnostic.

Why: an `.8bx` file declares composition; the `.8bs` entry is where a *program* gets its identity — its name, its targets, its requirements, and (with several programs in one project) where each one starts. Keeping that in `.8bs` keeps `.8bx` files free of it.

This is the *program* entry. A package's `"8bitscript".entry` (§7, §72) is an import target, not a program, and may be `.8bx`.

The default stays:

```text
src/main.8bs
```

#### 4.4 Target-specific 8BX variants

The existing target-file system should work identically:

```text
Title.8bx
Title.c64.8bx
Title.nes.8bx
Title.pet.8bx
Title.c64.reu512.8bx
```

This is extremely important for advanced hardware work.

A generic component might exist as:

```text
RasterTitle.8bx
```

while the C64 version:

```text
RasterTitle.c64.8bx
```

contains cycle-specific VIC-II logic.

#### 4.5 The `.8bs` → `.8bx` boundary

Since the entry is `.8bs` and `.8bs` cannot contain element syntax (4.2), a program needs a way to reach a component without writing an element. The rule:

> **A component declared `component Player(x: utinyint, y: utinyint)` is visible to an `.8bs` module as a callable with that exact positional signature. A call from `.8bs` is an element instantiation at that call site, elaborated the same way `<Player x={..} y={..} />` would be, subject to every checker rule in §31.**

```8bs
// src/main.8bs — the program; always .8bs
import { App } from "./App.8bx";
import { Player } from "./Player.8bx";

export function main(): void {
    App();            // elaborated here, exactly like <App />
    Player(20, 40);   // props are the positional parameters
}
```

What the call form does and does not carry:

- An `.8bs` caller cannot pass children. A component whose slot is required is `8BS22xx: children required` at that call; an optional slot elaborates to nothing.
- Attribute-only affordances — boolean shorthand (`visible`), string attributes (`label="FILE"`) — have no `.8bs` spelling. They are the ordinary arguments: `Player(20, 40, true)`.
- Default props (§32) apply as parameter defaults do: trailing arguments may be omitted.
- Evaluate-once (§104), specialization (§65), recursion protection (§106) and every diagnostic in §89 apply identically. There is one elaborator; the call form and the element form are two spellings of the same instantiation.

The other direction — what an `.8bx` module exports to `.8bs` — is: components (callable as above) and whatever ordinary declarations the file-role rule admits, `const`s and types at minimum. A component's `state` and methods are not reachable from `.8bs` by name; they lower to `__bx_` symbols (§102). A program that needs to reach a component's state does it through a method the component exposes, or keeps that state in `.8bs` and passes it as a prop.

This costs nothing new in the compiler: it is the function-like declaration of §23 paying for itself, and it is the reason the parameter-list form is the component syntax — only a parameter list gives `.8bs` a positional signature to call. §36's body-declared `prop` form is superseded by it.

#### 4.6 Several programs in one project

A project may build more than one program — a desktop plus the utilities beside it, the way GEOS ships a formatter and a copier as separate files on the same disk. Each program is its own link (the linker's one-entry-one-exported-function contract, per program), starting from its own `.8bs` entry (4.3).

Decided 2026-09-16 — the config shape, in `8bitscript.config.ts`:

```ts
import { defineConfig } from '@8bitscript/cli';

export default defineConfig({
  programs: {
    main:   { entry: 'src/main.8bs' },
    format: { entry: 'src/tools/format.8bs', targets: ['c64', 'c128'], requires: { 'memory.ram': 32768 } },
    copy:   { entry: 'src/tools/copy.8bs',   targets: ['c64', 'c128'] },
  },
  targets: { c64: {}, c128: {}, pet: {}, web: {} },
  // frameRate, systems, requires — unchanged
});
```

Rules:

- **Every `programs.*.entry` ends in `.8bs`.** Refused at config load with the rule named, before the linker runs.
- **The key is the output stem.** `format` builds to `dist/format-c64-ntsc.prg`, `dist/web/format/` on the web. Web keeps `dist/web/` flat while a project has one program.
- **`entry: 'src/main.8bs'` keeps working** as sugar for `programs: { main: { entry } }` — with today's filename-derived stem, so no existing `dist/` name moves. `entry` and `programs` together is a config error.
- **A program's `targets` ⊆ the project's; a program's `requires` may only raise a floor.** A drive utility only builds where there are drives; the project-level floor is the default.
- **Shared code is compiled into each program.** A package two programs use is in both binaries. A shared resident module (a kernel two programs jump into at fixed addresses) is a later, separate design and needs no config today.
- **Twin files apply per entry.** `format.c64.8bs` beside `format.8bs`, exactly as for `main`.
- **CLI:** `--program <name>` on `build`, `run`, `boot`; default is `main` or the only program. `--release` builds every program for its targets and release variants. `8bs targets --json` lists `programs` for the editor's side bar; the last-run file stays one per target and records which `program` ran, since a run on a machine is of exactly one program.

#### 4.7 Cartridges and disk images

Two different things; decided 2026-09-16 that they stay apart.

**A cartridge changes the build, so it is hardware.** The Atari catalog already models it: a `media` option (`xex` | `cart8` | `cart16`) whose values set `build.startup`, `build.output: "rom"`, link symbols, an emulator `-cart` load, and rewrite facts (`memory.ram`, `storage.save: false`). A C64 `.crt`, a VIC-20 cartridge, an NES mapper are the same shape: a `media` value on that machine's catalog, selected by `--profile`, `--hardware media=…`, or a `release` entry — `targets.c64.release: [{}, { hardware: { media: 'cart8k' } }]` ships both. A program built as a cartridge sees cartridge facts and folds on them like any other hardware. Nothing in `8bitscript.config.ts` is added for cartridges.

**A disk image is a container, built after the programs are.** A `.d64`/`.d71`/`.d81`/`.atr` holds N files — programs, data, a boot program — and changes no program's bytes. It is a post-build step over named artifacts:

```ts
images: {
  'geos-tools': {
    target: 'c64',
    format: 'd64',          // per target; from that machine's catalog, like media
    boot:   'main',         // first directory entry; what `8bs run --image geos-tools` autostarts
    files: [
      { program: 'main',   name: 'GEOS TOOLS' },   // on-disk name, ≤ 16 PETSCII chars
      { program: 'format', name: 'FORMAT' },
      { program: 'copy',   name: 'COPY' },
      { path: 'assets/font.bin', name: 'FONT', type: 'seq' },
    ],
  },
},
```

Invariants, stated now so the writer can come later:

- **Every file has an on-disk name distinct from its host filename.** `hello-world-c64-ntsc.prg` is 20 characters; CBM DOS holds 16 and truncates silently. The CLI's `artifact-name` check already measures this and knows `c1541 -write <file> <name>` takes the CBM name separately. The host filename never leaks onto the disk.
- **One program is the boot program.** `LOAD "*",8,1` loads the first directory entry, so order is meaning: `boot` is written first, and `8bs run --image` autostarts it (VICE's `-autostart` takes a d64 as readily as a prg).
- **An image's `target` must be one every listed program builds for, and its `format` one that target's catalog declares.** NES has no disk — its cartridge is the artifact. The web's equivalent is the bundle.
- **An image may include plain files.** Level data, fonts, save seeds — where `storage.save` and a future `@8bitscript/storage` meet the disk.
- **The writer is external and a `8bs doctor` concern.** `c1541` ships with VICE, which the doctor already locates.
- **Built by `--release` after its programs; never by `8bs build --target`.**

*Landed:* PR 1 (source kinds, entry rule) is [#159](https://github.com/8BitScript/8bitscript/pull/159); PR 0 (this section, 4.7, 4.8) is [#160](https://github.com/8BitScript/8bitscript/pull/160); the repo doc deferring to this spec is [#161](https://github.com/8BitScript/8bitscript/pull/161).

#### 4.8 Config evolvability

What makes 4.6 and 4.7 cheap to land — and every later key cheap — is knowing the config's shape at all. Three things, before the first BX grammar PR:

- **`defineConfig()` exported from `@8bitscript/cli`, typed.** An identity function with a `ProjectConfig` type; `export default {…}` is still accepted.
- **`packages/cli/schemas/config.json`**, beside the existing `systems.json` and `toolchain.json` schemas, so a loaded config is validated once instead of field-by-field in five files.
- **`RETIRED_OPTIONS` in `cli/src/config.mjs` is the retirement pattern.** When `entry` eventually yields to `programs`, it is named there, not silently ignored.

### 5. First repo refactor: stop hard-coding .8bs

Before adding markup syntax, centralize source-file knowledge.

Add something conceptually like:

```text
packages/compiler/src/source/index.mjs
```

with:

```js
SOURCE_EXTENSIONS = [".8bs", ".8bx"]

sourceKindOf(path)
sourceExtensionOf(path)
isSourceFile(path)
stripSourceExtension(path)
```

Every subsystem should use those functions.

#### Places that currently need conversion

At minimum:

```text
packages/compiler/src/resolver/index.mjs
packages/compiler/src/linker/index.mjs
packages/cli/src/build.mjs
packages/cli/src/check.mjs
packages/language-server/
editors/vscode/
package entry resolution
target variant resolution
tests
docs
```

Run a repository-wide audit:

```bash
git grep -n '\.8bs'
```

Every occurrence should be classified as:

1. intentionally `.8bs` spec
2. really meaning "8BitScript source"
3. documentation/example text

Do not mechanically replace all of them.

### 6. Generalize target variants

The existing resolver currently assumes:

```text
foo.8bs
foo.nes.8bs
foo.pet.8032.8bs
```

Generalize it to preserve the source extension:

```text
foo.8bs
foo.nes.8bs

foo.8bx
foo.nes.8bx
```

`variantOf()` should conceptually become:

```text
variantOf(path, machine, tag?)
```

where the function determines whether `path` ends in `.8bs` or `.8bx`.

Never convert an `.8bx` file into an `.8bs` variant.

### 7. Import resolution

#### Phase 1

Support explicit imports:

```8bs
import { Foo } from "./Foo.8bx";
import { math } from "./math.8bs";
```

Package manifests may point directly to either:

```json
{
    "8bitscript": {
        "entry": "./src/index.8bx"
    }
}
```

and exports:

```json
{
    "8bitscript": {
        "exports": {
            "./player": "./src/Player.8bx"
        }
    }
}
```

#### Phase 2

Add TypeScript-like extensionless resolution:

```8bs
import { Foo } from "./Foo";
```

Resolution order:

```text
Foo.8bs
Foo.8bx
Foo/index.8bs
Foo/index.8bx
```

If desired, diagnose a project containing both:

```text
Foo.8bs
Foo.8bx
```

when referenced without an extension.

Explicit extensions always disambiguate.

Do not mix this change into the first 8BX parser PR unless necessary. It is useful, but not required for initial 8BX.

### 8. Source-kind plumbing

Change compiler APIs from assuming one grammar to knowing the source kind.

Conceptually:

```js
tokenize(text, file, {
    sourceKind: "8bs" | "8bx"
})

parse(tokens, text, file, {
    sourceKind: "8bs" | "8bx"
})
```

`analyze()` should infer this from the filename by default.

The linker should infer it independently for every module in the graph.

This allows:

```text
main.8bx
 ├── game.8bs
 ├── HUD.8bx
 └── audio.8bs
```

with the proper grammar applied to every module.

## Part 3 — Binder & Semantic Model

### 9. The first major compiler prerequisite: a real binder

This is the most important architectural prerequisite.

The current compiler can parse and lower individual modules and the linker later resolves many imported names.

That model becomes insufficient once we write:

```8bx
import { Player } from "./Player.8bx";

<Player x={20} y={40} />
```

Before lowering the element, the compiler must know:

- what `Player` refers to
- whether it is a component
- what props it accepts
- their types
- whether children are accepted
- whether required props are missing
- whether an attribute name exists
- whether the component came from another module
- whether it is target-specific
- whether it introduces state/resources

That belongs before IR.

### 10. Add binder

Create:

```text
packages/compiler/src/binder/index.mjs
```

The binder should create symbols and scopes for:

```text
modules
imports
variables
consts
functions
namespaces
parameters
components
component props
component state
component methods
types
future structs/classes/interfaces
```

Possible symbol kinds:

```text
Variable
Constant
Function
Namespace
Parameter
Import
Component
ComponentProp
ComponentState
Type
Struct
Class
Interface
```

The binder must understand:

- module scope
- function scope
- block scope
- component scope
- imported symbols
- namespace symbols
- shadowing
- duplicate declarations
- exported declarations

### 11. Introduce a semantic program model

Do not make 8BX name resolution another special case inside the current linker.

Build a program model before IR.

Recommended pipeline:

```text
source graph
    ↓
lexer
    ↓
parser
    ↓
AST modules
    ↓
compile-time folding
    ↓
binder
    ↓
semantic/type checker
    ↓
8BX elaboration
    ↓
core program
    ↓
IR lowering
    ↓
link/layout
    ↓
optimization
    ↓
MOS / WASM backend
```

The existing public `link()` API can remain.

Internally it should gradually become the orchestrator of the semantic program rather than the place where names first acquire meaning.

### 12. Keep folding early

Things like:

```8bs
#fact(...)
#system()
#frames(...)
```

should continue folding before expensive semantic/component work whenever possible.

That gives 8BX a powerful property:

```8bx
if (Video.SPRITES > 0) {
    <SpriteLogo />
} else {
    <TextLogo />
}
```

On PET, the sprite branch should vanish.

On C64, the text fallback may vanish.

The unused component should cost zero.

## Part 4 — The 8BX Lexer

### 13. 8BX lexer support

The existing hand-written lexer should remain hand-written.

Do not bring in Babel, TypeScript, tree-sitter, or another JSX parser.

Add 8BX awareness to our scanner.

The lexer needs modes roughly equivalent to:

```text
Normal
BXTag
BXChildren
BXExpression
```

### 14. Why a lexer mode is necessary

Normal 8BitScript:

```8bs
a < b
```

must continue tokenizing `<` as an operator.

But this:

```8bx
<Player>
    Hello!
</Player>
```

contains raw child text that is not ordinary 8BitScript syntax.

The compiler must not report `!` or arbitrary text as invalid 8BS tokens.

### 15. Suggested BX token additions

Something close to:

```text
BxTagOpen
BxClosingTagOpen
BxTagEnd
BxSelfClose
BxText
BxExpressionOpen
BxExpressionClose
```

Normal identifiers/operators can still be reused inside tags where appropriate.

Do not necessarily make every piece of JSX punctuation a new token if the existing punctuation token can represent it cleanly.

The important new token is effectively:

```text
BxText
```

because raw child text has different lexical rules than 8BitScript code.

### 16. Lexer mode transitions

Example:

```8bx
<Panel title={name}>
    Hello {playerName}
    <Button />
</Panel>
```

Conceptually:

```text
Normal
  ↓ <
BXTag
  ↓ >
BXChildren
  ↓ {
Normal/BXExpression
  ↓ }
BXChildren
  ↓ <
BXTag
...
```

Braces inside an expression must nest normally:

```8bx
<Component value={array[index + fn(x)]} />
```

The lexer must not return to BX child mode on an inner `}`.

### 17. Critical lexer ambiguity tests

Before anything lowers, tests must prove these remain distinct:

```8bs
a < b
a > b
array<u8, 16>
ptr<u8>
x << 2
```

versus:

```8bx
<Foo />
<Foo></Foo>
<>
    <Foo />
</>
```

And inside BX:

```8bx
<Foo value={a < b} />
```

The `<` inside `{}` must remain comparison.

## Part 5 — AST, Fragments & Expressions

### 18. BX AST nodes

Add to `NodeType` something close to:

```text
BxElement
BxFragment
BxAttribute
BxSpreadAttribute
BxText
BxExpressionChild
```

A `BxElement` should contain:

```text
name
attributes
children
selfClosing
start
length
```

Example:

```8bx
<Player x={20} y={playerY} active />
```

AST conceptually:

```text
BxElement
  name: Player

  attributes:
    BxAttribute
      name: x
      value: IntegerLiteral(20)

    BxAttribute
      name: y
      value: Identifier(playerY)

    BxAttribute
      name: active
      value: true

  children: []
```

**String attributes are 8BitScript string literals.** `label="FILE"` is the same `StringLiteral` node `"FILE"` produces anywhere else — same escapes, same per-target encoding, no HTML entities. `label={"FILE"}` and `label="FILE"` are the same AST. A bare attribute (`active`) is `BooleanLiteral(true)`.

### 19. Fragment support

Support from the beginning:

```8bx
<>
    <Foo />
    <Bar />
</>
```

Fragments are especially valuable because composition should not require inventing meaningless wrapper components.

### 20. Expression children

Support:

```8bx
<Text>{score}</Text>
```

and:

```8bx
<Component value={expression} />
```

The expression inside braces is ordinary 8BitScript.

That is the bridge between 8BS variables and 8BX.

### 21. Variables in .8bx

Normal variables remain completely normal.

```8bx
let selected: utinyint = 0;
const MAX_ITEMS: utinyint = 8;

function draw(): void {
    let x: utinyint = 10;

    <Menu selected={selected} x={x} />
}
```

There should not be a second "template variable language."

Inside `{}` the programmer is writing ordinary 8BitScript.

The file rule (2.6) is about *declarations*, not expressions: the `draw()` above is fine because it contains an element; a top-level function that contains none is the lint's case, and a module-level `let` belongs in `.8bs` or in component `state`.

## Part 6 — State & Reactivity Philosophy

### 22. Do not build React state semantics into core 8BX

Avoid making:

```text
useState()
useEffect()
rerender()
virtual DOM
```

fundamental language behavior.

Those assumptions work poorly for:

- raster kernels
- games
- trackers
- IRQ-driven systems
- software 3D renderers
- editors
- machines with 4K RAM

Core 8BX should provide explicit persistent component state instead.

Reactive UI can later be implemented as a library/compiler optimization on top.

## Part 7 — Component Declaration & Elaboration

### 23. Component declarations

Introduce a real first-class `component` declaration.

Recommended first syntax:

```8bx
export component Player(
    x: utinyint,
    y: utinyint
) {
    return (
        <Sprite x={x} y={y} />
    );
}
```

This is deliberately function-like.

It gives us:

- typed named props
- easy parsing
- easy attribute matching
- no object/struct prerequisite
- familiar TSX feeling
- room to grow into richer component bodies

Then:

```8bx
<Player x={20} y={40} />
```

maps attributes to the component's named parameters.

### 24. Component naming

Use the familiar JSX convention:

```text
PascalCase → user/imported component
lowercase  → intrinsic/core element
```

Examples:

```8bx
<Player />
<Tracker />
<RasterKernel />
<Studio.Window />
```

Potential intrinsic elements:

```8bx
<fragment>
<slot>
```

Keep the intrinsic set **tiny**.

Do not hard-code dozens of UI tags into the compiler.

**Filenames follow the component:** `Player.8bx` exports `Player`. One caution the twin-file rule (4.4) inherits: `Title.8bx` and `title.8bs` in one directory are two files on Linux and one on a case-insensitive filesystem (macOS default, Windows). The resolver lists a directory by stem prefix (`variantsPresent`), so a project that names a component and a module the same word apart from case is diagnosed, not guessed at.

### 25. Member component names

Support:

```8bx
<Raster.IRQ />
<Audio.Channel />
<UI.Window />
<Studio.Editor />
```

This fits beautifully with existing 8BitScript namespaces and package imports.

It also avoids polluting the global module namespace with hundreds of components.

### 26. Components are not runtime objects by default

This is the core implementation strategy.

A source tree like:

```8bx
<Game>
    <Player />
    <Audio />
</Game>
```

should initially exist as a **compile-time composition graph**.

The target machine should not automatically receive:

```text
Game object
Player object
Audio object
component tree pointers
type IDs
parent pointers
child arrays
```

unless the program actually requires them.

### 27. Add a Composition IR / BX HIR

Do not immediately lower `BxElement` directly into the existing machine IR.

Add an intermediate form:

```text
packages/compiler/src/bx/
    index.mjs
    elaborate.mjs
    types.mjs
```

Conceptual node:

```text
ComponentInstance
    id
    component symbol
    source location
    props
    children
    state layout
    compile-time properties
    runtime properties
    contributions
```

This layer exists only during compilation.

### 28. Recommended pipeline after 8BX exists

```text
.8bx
 ↓
8BX AST
 ↓
binding
 ↓
type checking
 ↓
component instance graph
 ↓
component elaboration
 ↓
ordinary/core 8BitScript constructs
 ↓
existing IR
 ↓
existing linker/backend
```

This is extremely important.

For the first implementation, **MOS and WASM should not need to know what JSX is**.

8BX should disappear before normal backend lowering.

### 29. Component elaboration

Consider:

```8bx
<Button label="START" selected={option == 0} />
```

The component elaborator may turn that into ordinary operations equivalent to:

```8bs
button.draw("START", option == 0);
```

Or a more complex component may expand to:

```text
data tables
state
functions
calls
interrupt registrations
resource declarations
```

The elaborator owns that transformation.

### 30. Compile-time component expansion

A component should behave somewhat like a typed, hygienic, compiler-aware macro.

It is not a dumb textual macro.

The compiler knows:

- arguments
- types
- source spans
- bindings
- state
- children
- target facts
- generated symbols

This allows it to generate efficient ordinary IR without string generation.

## Part 8 — Props, Children & Slots

### 31. Component props

Initial props should map directly to component parameters.

```8bx
component Player(
    x: utinyint,
    y: utinyint,
    visible: bool
) {
    ...
}
```

Usage:

```8bx
<Player
    x={20}
    y={playerY}
    visible
/>
```

`visible` with no value is `visible={true}`; a prop of type `bool` is the only kind that may be written bare. From `.8bs` the same instantiation is `Player(20, playerY, true)` (4.5).

Checker responsibilities:

- unknown prop
- duplicate prop
- missing required prop
- wrong type
- invalid constant width/range
- illegal child usage
- target-specific incompatibility

### 32. Default props

Support normal parameter defaults:

```8bx
component Window(
    x: utinyint,
    y: utinyint,
    width: utinyint = 20
) {
    ...
}
```

Then:

```8bx
<Window x={0} y={0} />
```

uses 20.

If the default is compile-time known, it should not cost runtime work.

### 33. Children

Children should be a compile-time composition concept first.

Example:

```8bx
<Window>
    <Toolbar />
    <Editor />
</Window>
```

Do not immediately represent children as a runtime array.

A component should be able to specify where its children elaborate.

Conceptually:

```8bx
component Window(...) {
    beginWindow();

    <slot />;

    endWindow();
}
```

`<slot />` means:

> elaborate this instance's children here.

It does not require an allocated `children[]`.

### 34. Multiple named slots later

Eventually:

```8bx
<Window>
    <slot name="toolbar">
        <Toolbar />
    </slot>

    <slot name="content">
        <Editor />
    </slot>
</Window>
```

But do not block the first implementation on named slots.

One default child slot is enough for v1.

### 35. Raw text children

Support:

```8bx
<Text>Hello World!</Text>
```

but do not assume every component accepts raw text.

The checker should eventually know whether the component's slot accepts text.

This should fail if nonsensical:

```8bx
<RasterIRQ>
    Hello
</RasterIRQ>
```

unless that component explicitly defines a meaning for textual children.

#### Whitespace — the JSX rule (decided 2026-09-16)

Raw text is normalized before it becomes a string literal: each line is trimmed, lines that are only whitespace are dropped, and the remaining lines are joined with a single space.

```8bx
<Text>
    Hello
    World!
</Text>
```

is the literal `"Hello World!"` — twelve bytes, not the indentation. A run that must keep its layout is written as an expression child: `{"  two leading spaces"}`, or a template.

#### Comments inside children

Inside children, a comment is an empty expression child — `{/* … */}` — the same as JSX. `//` and `/* */` outside braces are text, so a URL or a path in a text child needs no escaping. Comments between statements and inside `{}` expressions are ordinary 8BitScript comments.

#### Encoding is the target's

The normalized text is a string literal and reaches the machine the way any string literal does: screen codes in whichever character set the target's text package selected (see the hello-world example's config for the mixed-case discussion). 8BX carries no encoding of its own.

## Part 9 — Component State & Behavior

### 36. Component state

After stateless components work, add persistent component state.

Recommended direction:

```8bx
component Player(x: utinyint, y: utinyint) {
    state frame: utinyint = 0;
    state health: utinyint = 100;

    ...
}
```

Props are the parameter list (§23, 4.5); `state` declarations sit in the body. An earlier draft spelled props as `prop x: utinyint;` in the body — superseded, because only a parameter list gives `.8bs` a signature to call.

Each static component instance receives fixed storage.

Example:

```8bx
<Player />
<Player />
```

means two known instances and therefore two known state layouts.

No heap is required.

### 37. State storage

A static instance may lower conceptually into compiler-generated globals:

```text
__bx_Player_1_frame
__bx_Player_1_health

__bx_Player_2_frame
__bx_Player_2_health
```

Later this should optimize into structured contiguous layouts.

**Where it lives (decided 2026-09-16):** the ordinary variables section, the same one a module-level `let` goes to — no new section, no zero-page claim. It is counted in `memory.variables`, so a project's `requires` floor sees it, and `8bs build --size` lists it per instance (§119: `state Player[1]  6 bytes RAM`). Zero page stays the call convention's; a dedicated state section waits for pools (§63), where contiguity starts paying for itself.

The important first property is:

> memory usage is deterministic and visible at compile time.

### 38. State is not automatically reactive

Writing:

```8bs
health = health - 1;
```

does not implicitly redraw an entire component tree.

A game can render every frame.

A desktop library can maintain dirty regions.

A tracker can redraw only changed cells.

A raster kernel may never "render" in the UI sense at all.

That policy belongs to components/frameworks, not the 8BX core language.

### 39. Component methods

Components should eventually support methods:

```8bx
component Player {
    state health: utinyint = 100;

    function damage(amount: utinyint): void {
        health = health - amount;
    }

    function update(): void {
        ...
    }
}
```

Methods are ordinary compiled machine code.

No reflection is needed.

### 40. Avoid universal lifecycle hooks

Do not make every component automatically receive:

```text
mount
render
update
destroy
```

That would make the component model secretly visual/game-loop oriented.

Instead, runtime participation should be explicit.

For example, a standard package could define composition primitives such as:

```8bx
<FrameTask handler={update} />
<Interrupt handler={irq} />
<RasterTask line={100} handler={splitScreen} />
<InputBinding ... />
<AudioVoice ... />
```

The component returns/contributes those things.

### 41. Components can contribute behavior

A component may contribute any combination of:

```text
code
data
state
startup routines
shutdown routines
frame tasks
interrupt handlers
raster handlers
audio routines
input bindings
resources
child components
compile-time tables
native assembly
target-specific sources
```

This is what makes 8BX useful beyond UI.

## Part 10 — Domain Examples

### 42. Example: raster title

Eventually this should be a natural 8BX design:

```8bx
component TitleScreen {
    return (
        <RasterKernel>
            <RasterRegion from={0} to={47}>
                <Logo />
            </RasterRegion>

            <RasterRegion from={48} to={180}>
                <CopperBars />
                <SpriteScroller />
            </RasterRegion>

            <RasterRegion from={181} to={239}>
                <Menu />
            </RasterRegion>
        </RasterKernel>
    );
}
```

On C64 the components could compile into:

```text
IRQ setup
raster compare writes
VIC register changes
sprite multiplexing
cycle-sensitive routines
```

There is no DOM involved.

### 43. Raster components must allow exact control

For demoscene-quality work:

```8bs
// raster.8bs — the exact cycle-counted routine
export function irq(): void {
    asm6502 {
        ...
    }
}
```

```8bx
// CustomRasterThing.8bx — the composition around it
import { irq } from "./raster.8bs";

export component CustomRasterThing() {
    return <RasterIRQ line={72} handler={irq} />;
}
```

8BX becomes the high-level composition mechanism around extremely low-level code — and the low-level code stays in `.8bs`, where it can be read, measured and reused without an element in sight (2.6).

That is exactly what we want.

### 44. Example: line/vector engine

```8bx
<VectorScene>
    <Camera x={cameraX} y={cameraY} />
    <WireframeModel model={ship} />
    <HUD />
</VectorScene>
```

`VectorScene` may ultimately call a software line renderer.

No assumption about sprites, tiles, or character cells should leak into 8BX itself.

### 45. Example: raycaster

```8bx
<Game>
    <Raycaster
        map={level}
        cameraX={playerX}
        cameraY={playerY}
        heading={heading}
    />

    <Enemies />
    <Weapon />
    <HUD />
    <Audio />
</Game>
```

This needs to be completely legitimate even if every pixel is generated in software.

### 46. Example: tracker

```8bx
<Tracker>
    <PatternEditor />
    <ChannelMeters />
    <InstrumentEditor />
    <PianoKeyboard />
    <Transport />
    <AudioEngine />
</Tracker>
```

Some components draw.

Some process input.

Some mutate music data.

Some generate sound.

Some do all of those.

That is fine.

### 47. Example: 8BitScript Studio

Long-term dogfood target:

```8bx
<Studio>
    <MenuBar />

    <Workspace>
        <ProjectExplorer />
        <CodeEditor />
        <SpriteEditor />
        <CharacterEditor />
        <TileEditor />
        <MusicTracker />
        <MemoryInspector />
        <Debugger />
    </Workspace>
</Studio>
```

Web/X16/C64/PET/etc. may elaborate this very differently.

The composition is shared.

The constraints are not hidden.

## Part 11 — Conditional Composition & Compile-Time Facts

### 48. Conditional composition

8BX badly needs conditional-expression support.

The lexer already recognizes `?` and `:`, but the parser currently does not provide a normal conditional-expression AST.

Add:

```text
ConditionalExpression
```

so this can work:

```8bx
{hasSprites
    ? <SpriteLogo />
    : <TextLogo />
}
```

This should be an early prerequisite.

### 49. Compile-time target conditions

The killer feature is combining BX with existing compile-time facts.

Example:

```8bx
{Video.SPRITES > 0
    ? <SpriteLogo />
    : <CharacterLogo />
}
```

When the condition is compile-time known, only one branch should survive elaboration.

That gives us responsive design based on **hardware capabilities**, not merely screen width.

### 50. Runtime conditions

Runtime conditions remain runtime:

```8bx
{paused
    ? <PauseScreen />
    : <GameWorld />
}
```

The elaborator can lower both branches to ordinary control flow.

It still does not require a component tree.

### 51. Arrays, repetition, and JSX-like mapping

Do not fake `.map()` before the language actually supports the required semantics.

Eventually we want:

```8bx
{items.map(item =>
    <Item value={item} />
)}
```

But that requires:

- stronger array semantics
- callbacks/closures or compile-time equivalents
- arrow functions
- richer type inference

Implement these honestly rather than special-casing `.map()` in 8BX.

### 52. First repetition mechanism

Until proper functional iteration exists, support a compiler-friendly bounded composition mechanism.

Possible future spelling:

```8bx
<For each={items}>
    ...
</For>
```

or allow normal 8BitScript loops around element statements.

But this syntax should be decided only after the component foundation works.

Do not accidentally invent a second scripting language inside JSX braces.

### 53. Spread props

Eventually support:

```8bx
<Component {...props} />
```

but only after 8BitScript has an actual struct/object type capable of representing `props`.

Do not make spread a magic untyped bag.

## Part 12 — OOP Foundation: struct, class, interface

### 54. OOP foundation

8BX will expose the need for richer structured types.

This should become a parallel core-language project.

Recommended order:

```text
struct
methods
interface
class
explicit dynamic allocation/pools much later
```

### 55. struct

Add fixed-layout value types first:

```8bs
struct Vec2 {
    x: int;
    y: int;
}
```

Properties:

- size known at compile time
- field offsets known at compile time
- no hidden pointer
- no heap
- usable from `.8bs` and `.8bx`
- backend layout deterministic

This becomes the basis for:

```text
component state
props structures
game entities
audio data
graphics structures
editor models
```

### 56. Methods

Allow behavior on structured types:

```8bs
struct Vec2 {
    x: int;
    y: int;

    function move(dx: int, dy: int): void {
        x += dx;
        y += dy;
    }
}
```

The compiler can lower this to a normal function taking an implicit address/reference.

No dynamic dispatch is necessary.

### 57. Interfaces

Interfaces should be compile-time contracts:

```8bs
interface Drawable {
    function draw(): void;
}
```

No runtime metadata is required.

This eventually allows typed component slots:

```text
RasterPart
AudioNode
Drawable
InputSource
EditorPane
```

### 58. Classes

Classes can eventually add:

- encapsulated state
- constructors
- methods
- access modifiers if useful

but must preserve explicit memory semantics.

Do not make:

```8bs
new Foo()
```

silently allocate from a heap that did not previously exist.

Possible allocation models later:

```text
static instance
stack/frame instance
explicit arena
explicit pool<N>
explicit heap package
```

The allocation mechanism must be visible.

### 59. Avoid inheritance initially

Prefer:

```text
composition
interfaces
traits/protocols
components
```

over inheritance hierarchies.

If inheritance ever arrives, dynamic dispatch costs must be explicit.

A hidden vtable is exactly the sort of thing 8BitScript normally tries not to surprise the programmer with.

### 60. Relationship between classes and components

A useful conceptual split:

```text
struct     = fixed data
class      = data + runtime behavior
component  = compile-time/runtime composition unit
```

A component may internally use structs and classes.

A class does not have to participate in 8BX.

A component does not have to allocate a class instance.

### 61. Component state should eventually lower to structs

Instead of generating unrelated globals forever:

```text
PlayerState {
    frame
    health
    x
    y
}
```

Each component instance can get a statically allocated state struct.

This improves:

- layout
- debugging
- generated code
- repeated component instances
- eventual pools
- method reuse

## Part 13 — Static & Dynamic Instances

### 62. Static instances first

For 8BX v1:

> Every component instance in the source is statically known.

This is perfect for 8-bit systems.

Example:

```8bx
<Player />
<HUD />
<Audio />
```

The compiler knows there are exactly three instances.

### 63. Dynamic component instances later

Games will eventually need:

```text
up to 16 enemies
up to 8 bullets
up to 32 particles
```

Do not implement this with a heap-backed React-style component array.

Use explicit bounded pools:

```text
pool<Enemy, 16>
pool<Bullet, 8>
```

or equivalent future syntax.

Memory remains deterministic.

### 64. Props: compile-time vs runtime

The semantic layer should classify props.

Example:

```8bx
<Sprite
    width={24}
    x={playerX}
/>
```

`width=24` is compile-time known.

`x=playerX` may be runtime.

The compiler should specialize/fold everything it safely can.

This can produce dramatically smaller code than treating all props as runtime fields.

### 65. Component specialization

Given:

```8bx
<Button width={10} />
<Button width={20} />
```

the compiler may create specialized static layout/data for each width while sharing code where sensible.

The goal should be:

> constant information becomes data/code decisions during compilation, not runtime branches.

### 66. No mandatory retained component tree

This deserves its own explicit rule.

Do not allocate something equivalent to:

```c
struct Component {
    type;
    props;
    parent;
    children;
    state;
}
```

for every 8BX element.

That would destroy the entire point on machines with a few KB of RAM.

The tree is primarily a compiler concept.

## Part 14 — Retained-Mode Libraries & UI Dogfood

### 67. Optional retained-mode libraries

A GEOS-like desktop may genuinely need:

- windows
- parent/child relationships
- focus
- hit testing
- z-order
- invalidation

That framework can explicitly retain the state it requires.

8BX should make it pleasant to build.

It should not charge a raycaster or raster demo for it.

### 68. Existing @8bitscript/ui should become the first dogfood target

The current menu bar is ideal.

It is intentionally immediate-mode and carefully optimized for these machines.

Do **not** rewrite it into an expensive retained structure.

Instead create an 8BX wrapper whose elaboration is essentially:

```text
menubar.begin(...)
menubar.item(...)
menubar.item(...)
menubar.end()
```

A source usage could become:

```8bx
<MenuBar selected={selected}>
    <MenuItem label="FILE" />
    <MenuItem label="EDIT" />
    <MenuItem label="HELP" />
</MenuBar>
```

The generated program should stay close to the current immediate-mode implementation.

### 69. Use the menu bar as the zero-cost-abstraction benchmark

Measure:

```text
existing hand-written 8BS usage
8BX usage
generated code size
variable RAM
runtime behavior
```

The 8BX version should ideally be equal or smaller once compile-time layout begins doing work the current runtime package does itself.

If 8BX makes this dramatically larger, stop and fix the architecture before adding more components.

## Part 15 — Standard Packages & Target Variants

### 70. Standard component package architecture

Do not put all standard components in one giant package.

Suggested eventual layering:

```text
@8bitscript/bx
    foundational composition contracts

@8bitscript/ui
    menus/windows/layout/text-oriented application widgets

@8bitscript/graphics
    portable graphics concepts where they genuinely exist

@8bitscript/raster
    scanline/raster scheduling concepts

@8bitscript/audio
    audio composition

@8bitscript/input
    existing input layer + component bindings

@8bitscript/studio
    editor components
```

Actual package names can be decided as features land.

The important thing is that 8BX itself remains neutral.

### 71. Intrinsics should be rare

Most things that look like:

```8bx
<Sprite />
<RasterIRQ />
<AudioChannel />
```

should ideally come from ordinary 8BitScript packages.

Compiler-only intrinsics should be reserved for things that cannot reasonably be expressed in normal code.

This keeps the core language small.

### 72. Component package implementation

A package should be able to export an 8BX component:

```json
{
    "8bitscript": {
        "exports": {
            "./window": "./src/Window.8bx"
        }
    }
}
```

Then:

```8bx
import { Window } from "@8bitscript/ui/window";
```

works like any other source module.

### 73. Target-specific component packages

The existing package resolver gives us a major advantage.

A portable package may expose one component API while the target package provides different implementations.

For example:

```text
RasterKernel.c64.8bx
RasterKernel.vic20.8bx
RasterKernel.atari8.8bx
RasterKernel.nes.8bx
RasterKernel.web.8bx
```

The public component remains conceptually the same while each machine gets native behavior.

### 74. Web target

Do not implement 8BX by translating it to React.

The web target should continue representing **8BitScript machine semantics**.

8BX should lower through the same composition/core IR path as native machines.

The web backend may eventually use:

```text
Canvas
WebGL/WebGPU
WebAudio
DOM
```

internally for some standard components, but that is a target implementation detail.

#### Fluid web is in milestone 1

Decided 2026-09-16. Today the web target is one more fixed-geometry skin — a 48×27 grid, or a C64/PET/VIC-20 skin, each its own wasm build, no simulated resize; `packages/web/AGENTS.md` says it "proves semantics, never fit." 8BX adds a fourth case, and it ships with the first milestone rather than after it: **a fluid web build variant** where the same `.8bx` source lays itself out to the viewport.

The constraints it has to satisfy, and that the first milestone's design has to answer before stateless components ship:

- **The viewport is a `run` fact, not a `build` fact.** Window size is not knowable at compile time the way `video.columns` is on a PET. It belongs with `input.mouse` and `input.paddles` — detectable, not foldable. So fluid web is the one target where 8BX cannot fully honor "if the compiler can do it, the compiler does it," and it needs a **real, small, named runtime layout step**. This spec states that exception here, explicitly, rather than let every other target's docs imply it never happens.
- **The other eight targets pay nothing for it.** Whatever runtime layout resolver a fluid web build links, a PET build carries not one byte of it. The existing pattern is "each value its own wasm, never one binary switching `#system()`": fluid web is a *new build variant of the web target* (a hardware value in the web catalog, like a skin), not a code path inside the one that exists today.
- **Two responsive tiers coexist in one source.** Tier 1 is §78/§79: compile-time facts, folded, on every target including the web's fixed skins. Tier 2 is the fluid variant: the same components, with layout that a fact cannot decide resolved at run time. A component must not have to know which tier it is in; the layout package does.
- **Decided 2026-09-16 — how:**
  - **Canvas with a layout pass.** One wasm program, one canvas, the same code path as the fixed skins. A small runtime layout step reads the viewport and hands the program a grid that fits — columns and rows scale, cells stay cells. No DOM lowering, no second backend, nothing a PET build links.
  - **The viewport is read as run facts.** `video.columns` and `video.rows` keep their names; on the fluid variant they are *run* facts, read at start-up the way `input.mouse` is — the build-vs-run split the fact table already has. On every other target, and on the web's fixed skins, they fold as before. No new layout vocabulary.
  - **It is a web hardware value** — and it already exists: `machine=hifi`, the web's Modern host and its default, is the one resizable host, beside the fixed skins (`machine=c64`…). So it is a `release` entry, a named system, and `8bs run web` with no new flag, option or target; each value its own wasm, as today. No second option (`fit=…`) is added to mean the same thing.
  - **A resize re-lays out on the next `waitFrame()`.** The layout step re-runs between frames when the viewport changed — the page holds the measurement and applies it once the program is waiting in `waitFrame()`; a program that redraws each frame simply follows. Nothing reactive: no automatic redraw, no retained tree (§38, §66).

*Landed:* the first three were already true of the Modern host (#156: `gridFor`, the `MAX_CELLS` map, `Video.columns()`/`rows()`); the fourth is [#171](https://github.com/8BitScript/8bitscript/pull/171). `Video.COLUMNS` is the grid a program starts with, `Video.columns()` the live one.

This replaces the "Tier 2" section of `docs/project/8bx.md`, which now defers to this spec.

## Part 16 — Raster & Demoscene Architecture

### 75. Raster/demoscene architecture

Add advanced raster work only after generic component elaboration works.

Recommended structure:

```text
8BX component tree
    ↓
raster package/compiler contribution
    ↓
static raster schedule
    ↓
target-specific validation
    ↓
handler routines/tables
    ↓
MOS code
```

The compiler should be capable of knowing:

```text
which scanline
which handler
which registers
which resources
which IRQ owns the vector
```

without constructing a runtime scene graph.

### 76. Raster conflict diagnostics

Eventually diagnose impossible compositions such as:

```text
two components claiming the same exclusive IRQ
sprite schedule exceeding a target's limits
raster operation outside visible/valid lines
incompatible display modes active simultaneously
```

These should be target-aware.

Do not pretend the machines share one raster architecture.

### 77. Cycle budgets

For machines where timing can be calculated reliably, later allow optional compiler diagnostics:

```text
this raster segment has approximately X cycles available
known generated work consumes Y
```

Hand-written assembly may make exact analysis impossible.

In that case the compiler should say "unknown", not invent confidence.

### 78. 8BX and machine facts

8BX should make aggressive use of existing facts.

Examples:

```8bx
{Video.SPRITES > 0 && <SpriteLayer />}

{Video.COLUMNS >= 80
    ? <WideEditor />
    : <CompactEditor />
}
```

If the facts are known at build time, the unused components disappear.

This is 8BitScript's version of responsive design.

### 79. Responsive means capability-responsive

Do not define responsive design purely around:

```text
width
height
columns
```

The useful dimensions include:

```text
RAM
screen columns
screen rows
sprites
redefinable glyphs
bitmap modes
color depth
audio voices
keyboard
pointer
controller
storage
banked memory
CPU speed
raster capabilities
interrupt facilities
```

This is far more powerful than CSS-style breakpoints.

## Part 17 — Editor & LSP Tooling

### 80. Tooling: VS Code language registration

The extension currently treats `.8bs` as its source language.

Add `.8bx`.

I recommend separate language IDs:

```text
8bitscript
8bitscript-8bx
```

while both are displayed as 8BitScript.

Reason:

`.8bs` should not highlight:

```8bx
<Foo />
```

as valid markup.

`.8bx` should.

### 81. VS Code grammar

Keep:

```text
editors/vscode/syntaxes/8bs.tmLanguage.json
```

Add:

```text
editors/vscode/syntaxes/8bx.tmLanguage.json
```

The BX grammar should include the base 8BS grammar and add:

```text
element names
component names
attributes
fragments
expression containers
text children
opening/closing punctuation
```

Do not duplicate the entire 8BS grammar if TextMate inclusion can avoid it.

### 82. Language configuration

Reuse the existing comment/bracket/string configuration.

Add `<`/`>` behavior carefully.

Do **not** blindly auto-close `<` to `>` in every context if it makes:

```8bs
a < b
```

annoying in `.8bx`.

Editor auto-closing should be tested in actual `.8bx` editing.

### 83. VS Code extension activation

Add:

```text
workspaceContains:**/*.8bx
```

alongside:

```text
workspaceContains:**/*.8bs
```

Project detection must consider either source type.

### 84. LSP document selector

The VS Code client should start the same 8BitScript LSP for both:

```text
8bitscript
8bitscript-8bx
```

The server should not become a separate 8BX server.

One compiler.

One language server.

Two source modes.

### 85. LSP source kind

Pass/infer the document's filename extension so:

```text
foo.8bs
```

gets core grammar and:

```text
Foo.8bx
```

gets BX grammar.

Untitled documents may need a language-id hint because no filename exists.

Add an optional source-kind parameter to compiler analysis APIs for this.

### 86. 8BX IntelliSense

Once the binder exists, add:

##### Tag completion

Typing:

```8bx
<
```

should offer imported/visible components.

##### Attribute completion

Typing:

```8bx
<Player 
```

should offer:

```text
x
y
health
sprite
...
```

##### Hover

Hover:

```8bx
<Player />
```

shows component docs/signature.

##### Prop hover

Hover:

```8bx
<Player x={...} />
```

shows `x` type/docs.

##### Closing tags

Typing:

```8bx
<Window>
```

should make completing:

```8bx
</Window>
```

easy.

##### Go to definition

`<Player>` should navigate to:

```8bx
component Player ...
```

This requires binder/symbol support and is a good reason to finally add it.

### 87. LSP evolution enabled by binder

The binder also unlocks normal 8BitScript features we already want:

```text
user-defined hover
go-to-definition
rename
find references
better completion
real type errors
cross-module diagnostics
```

So the binder is not "work only for 8BX."

It upgrades the language as a whole.

### 88. Formatter

Do not make a formatter a blocker for initial 8BX.

But eventually formatting needs to understand:

```8bx
<Component
    foo={bar}
    baz="hello"
>
    <Child />
</Component>
```

A generic TS formatter should not be used because it does not know 8BitScript's grammar.

### 89. Diagnostics

Add specific 8BX diagnostic codes instead of overloading generic syntax errors.

Examples:

```text
8BS12xx  BX syntax
8BS22xx  BX semantic/component errors
```

Potential diagnostics:

```text
mismatched closing component
unterminated component
unknown component
symbol is not a component
unknown prop
duplicate prop
missing required prop
prop type mismatch
children not accepted
text children not accepted
invalid slot
component state used illegally
dynamic instance count not bounded
component cannot exist on target
asm6502 not allowed in .8bx            (2.6 A, error)
.8bx cannot be a program entry         (4.3, error)
ordinary code in .8bx                  (2.6 B, warning)
children required                      (4.5)
```

Use whatever exact code ranges fit the existing diagnostic registry.

## Part 18 — Compiler Discipline: Recovery, Checking, Backend, IR

### 90. Error recovery is critical

The parser must remain useful while someone has typed only:

```8bx
<Player
```

or:

```8bx
<Window>
    <But
</Window>
```

or:

```8bx
<Component value={
```

The existing "never throw, recover and continue" compiler rule applies equally to 8BX.

This is especially important because markup is edited in partially complete states constantly.

### 91. AST walking

The current generic AST walker walks nested objects automatically.

Make BX node properties ordinary AST nodes/arrays so existing passes can see expressions such as:

```8bx
<Player x={someExpression} />
```

without each generic tree utility needing BX-specific traversal code.

### 92. Checker integration

The existing checker should continue checking expressions embedded in BX.

Example:

```8bx
<Player x={300} />
```

where `x` is `utinyint` should report the same kind of width/type problem as an ordinary function call.

Do not write a separate "template checker."

### 93. Component type checking

Add a component signature representation:

```text
ComponentSignature
    name
    props
    children policy
    state
    methods
    output/contribution type
```

This belongs in semantic analysis, not the backend.

### 94. BX compile-only types

Introduce internal semantic concepts such as:

```text
Component
ComponentInstance
Children
Slot
Composition
```

These do not necessarily become runtime types.

The compiler must prevent nonsense like:

```8bs
let x: utinyint = <Player />;
```

unless some future explicit conversion defines a meaning for it.

**One rule, not three examples.** An element or fragment has the compile-only type `Composition`. Exactly three positions accept it: a statement (§95, elaborated in place), a component's `return` (§96, the instance's contribution), and a child position inside another element. Anywhere else — a `let` initializer, a function argument, an operand — is `8BS22xx: a composition is not a value`. A `?:` whose arms are both `Composition` is itself `Composition` (§48); mixed arms are the same diagnostic.

### 95. Element expressions as statements

This should be valid in `.8bx`:

```8bx
function draw(): void {
    <HUD score={score} />;
}
```

That means:

> invoke/elaborate this component at this source location.

This is useful for immediate-mode and game code.

From an `.8bs` file the same statement is spelled as a call — `HUD(score);` — see 4.5. Both spellings reach the same elaboration.

### 96. Element expressions inside components

Likewise:

```8bx
component Game {
    return (
        <>
            <World />
            <HUD />
        </>
    );
}
```

The component composition tree can be built recursively.

### 97. Top-level elements

Do not require this for the first version.

Long term it may be useful:

```8bx
export <Application>
    ...
</Application>;
```

But 8BitScript's entry/main model is what starts a program, and the entry is `.8bs` (4.3). That stays.

The root of a composition is reached from the program's `.8bs` entry as a call (4.5):

```8bs
// src/main.8bs
import { App } from "./App.8bx";

export function main(): void {
    App();
}
```

Element statements (§95) remain the spelling *inside* `.8bx` component bodies and methods.

### 98. No generated entry points

An earlier draft allowed `entry: "src/App.8bx"`, with an exported root component generating the entry routine. That is withdrawn by 4.3: the two-line `main.8bs` that calls `App()` *is* the entry, by design.

It is where the program's identity lives — its name, targets and requirements — and, with several programs in one project, where each one starts. Nothing about an `.8bx` file should have to know it is a program.

### 99. Existing backend strategy

The first 8BX milestone should require **zero BX-specific code** in:

```text
MOS backend
WASM backend
assembler
linker output writer
machine file writers
```

If the 8BX elaborator produces existing core IR, both backends get support automatically.

This dramatically reduces risk.

### 100. New IR nodes only when justified

Later, some advanced features may genuinely deserve dedicated IR:

```text
raster schedule
banked resource
interrupt declaration
component state layout
```

Only add one when ordinary core IR cannot represent it efficiently or correctly.

Do not create a giant "UI IR."

### 101. Source maps / diagnostics after elaboration

Every generated operation must retain the source span of the component/attribute that caused it.

If:

```8bx
<RasterIRQ line={999} />
```

is invalid on a target, the diagnostic should underline `999` or the relevant prop.

Generated-code errors should never point at invisible compiler-generated symbols if the compiler can identify the source element.

### 102. Generated symbol naming

Use deterministic internal symbols:

```text
__bx_Player_1_state
__bx_Player_1_update
__bx_Window_3_layout
```

But never expose these as normal user namespace names.

They should be collision-proof and excluded from naming-style checks. They are also exempt from the linker's collision renaming (the `_2` suffix a second module's clashing name receives): a `__bx_` name is unique by construction — component, instance, member — and the linker must never have cause to touch one.

### 103. Component instance identity

A static component's identity should derive from its semantic source location/tree position rather than runtime allocation.

That gives deterministic:

```text
state layout
generated names
debug information
build output
```

### 104. Side-effect safety in prop expansion

Do not naïvely substitute:

```8bx
<Foo value={nextValue()} />
```

everywhere `value` appears in Foo's expansion.

If Foo references the prop twice, `nextValue()` must not accidentally execute twice.

The elaborator should synthesize a temporary when necessary:

```text
tmp = nextValue()
...
use tmp
...
use tmp
```

This is a major difference between typed AST expansion and textual macros.

### 105. Children must also preserve execution semantics

If a component places its child slot once:

```text
child executes once
```

If a future component deliberately places it twice:

```text
child executes twice
```

That behavior needs to be explicit and testable.

### 106. Recursion protection

Component expansion can recurse:

```8bx
component Foo {
    return <Foo />;
}
```

Detect direct and indirect compile-time component recursion and report it cleanly.

Do not let the compiler stack-overflow.

## Part 19 — Components & Surrounding Code

### 107. Components and ordinary functions

A component should freely call ordinary 8BS functions.

Ordinary functions should not need to know 8BX exists.

Example:

```8bx
import { drawWaveform } from "./waveform.8bs";

component Waveform(samples: array<utinyint, 64>) {
    function draw(): void {
        drawWaveform(samples);
    }

    ...
}
```

The heavy algorithm remains ordinary 8BitScript, in an `.8bs` file.

8BX provides composition around it. A component method (`draw`) is the glue, and the lint (2.6) leaves component methods alone.

### 108. Components and namespaces

Support APIs such as:

```8bx
<Audio.Channel />
<Graphics.Sprite />
<Raster.Region />
```

Namespaces already exist in the language, so this should build on that semantic model instead of inventing another module mechanism.

### 109. Components and asm6502

`asm6502` is refused in `.8bx` (2.6 A). A component reaches assembly through an imported `.8bs` function, and that function's assembly block remains opaque exactly as it is today.

Do not attempt to parse assembly as BX — the lexer never sees one in BX mode, because the block cannot appear in a BX file.

Example:

```8bs
// stable-raster.8bs
export function irq(): void {
    asm6502 {
        ...
    }
}
```

```8bx
// StableRaster.8bx
import { irq } from "./stable-raster.8bs";

export component StableRaster() {
    return <Raster.IRQ handler={irq} />;
}
```

The §121 lexer matrix row "asm6502 inside surrounding component source" becomes a negative test: the diagnostic, with the block's span, and recovery past it.

### 110. Component resource ownership

Eventually the composition pass should track scarce resources:

```text
IRQ vectors
zero page
sprites
audio channels
video banks
cartridge banks
memory windows
DMA channels
```

A component can declare what it needs.

The compiler can then detect conflicts before running the program.

This is a natural extension of the existing machine-fact/hardware model.

### 111. Resource claims must expose constraints

Do not turn:

```text
C64: 8 sprites
NES: 64 sprites, 8 per scanline
Atari: player/missile graphics
PET: none
```

into one fake `sprites=8` abstraction.

Components should ask for semantic capabilities and the target implementation should expose the actual limiting factors where they matter.

This follows the existing project's "abstract concepts, expose constraints" rule.

### 112. Component capability contracts

Eventually a component can declare requirements:

```text
requires Video.SPRITES > 0
requires Audio.VOICES >= 3
requires Input.KEYBOARD
```

The compiler can:

- select a fallback
- remove the component
- choose a target variant
- issue an error

depending on how the program expressed the requirement.

### 113. Fallback composition

A future clean mechanism could be:

```8bx
<Capability when={Video.SPRITES > 0}>
    <SpriteLogo />

    <fallback>
        <CharacterLogo />
    </fallback>
</Capability>
```

But normal 8BS conditional expressions may make a special fallback element unnecessary.

Prefer ordinary language syntax unless a dedicated construct gives a real benefit.

## Part 20 — Styling, Layout & Debug Tooling

### 114. Styling

Do not start by cloning CSS.

Initial components simply have typed properties:

```8bx
<Text
    color={TextColor.WHITE}
    reverse={selected}
    x={10}
    y={4}
>
    START
</Text>
```

A UI package may later introduce:

```text
Style
Layout
Theme
```

as normal types/components.

8BX itself should not know what `color`, `margin`, `padding`, or `display:flex` mean.

### 115. Layout

Likewise, layout is a library/compiler-domain feature, not core JSX syntax.

Possible high-level components:

```8bx
<Stack />
<Grid />
<Dock />
<Window />
```

but a raycaster or raster demo never pays for them.

### 116. Compile-time layout

Whenever layout is static, compute it at compile time.

Example:

```8bx
<MenuBar width={40}>
    <MenuItem label="FILE" />
    <MenuItem label="EDIT" />
</MenuBar>
```

If every label and width is known, the compiler/package should ideally precompute:

```text
positions
hit ranges
clipping
padding
```

and emit data/direct calls.

Do not repeat calculations every frame.

### 117. Runtime layout only when genuinely runtime

If width comes from runtime information:

```8bx
<Panel width={currentWidth} />
```

then runtime layout is legitimate.

The rule is not "everything compile time."

The rule is:

> compile-time-known work does not belong on the target CPU.

### 118. 8BX debug/inspection output

Add compiler tooling eventually:

```bash
8bs inspect --bx src/App.8bx
```

or similar.

Useful output:

```text
App
├── MenuBar
│   ├── MenuItem
│   └── MenuItem
├── Editor
└── AudioEngine
```

With optional:

```text
state bytes
code bytes
resources
selected target variants
removed compile-time branches
```

This would be immensely useful for understanding generated programs.

Do not make this a v1 blocker.

### 119. Size reports

Extend `8bs build --size`.

In addition to functions, eventually show component-origin information:

```text
component App/MenuBar       146 bytes
component App/Tracker       612 bytes
component App/RasterKernel  184 bytes
state Player[0]               6 bytes RAM
state Player[1]               6 bytes RAM
```

This makes abstractions accountable.

## Part 21 — Testing Strategy

### 120. Testing strategy

Every 8BX feature needs tests in the same PR.

Create files along the lines of:

```text
packages/compiler/test/bx-lexer.test.mjs
packages/compiler/test/bx-parser.test.mjs
packages/compiler/test/bx-binder.test.mjs
packages/compiler/test/bx-checker.test.mjs
packages/compiler/test/bx-elaborate.test.mjs
packages/compiler/test/bx-linker.test.mjs
packages/compiler/test/bx-resolver.test.mjs
packages/compiler/test/bx-codegen.test.mjs
```

Exact organization can follow existing conventions.

### 121. Lexer test matrix

Include:

```text
simple self-closing tag
opening/closing tag
nested elements
fragment
attribute strings
attribute expressions
raw child text
comments
nested braces
comparison operator in expression
generic/type < >
shift operators
unterminated tags
half-written tags
mismatched tags
asm6502 inside surrounding component source   (negative: refused, 2.6 A)
templates inside prop expressions
whitespace normalization of text children       (§35)
{/* */} inside children; // inside text is text (§35)
```

### 122. Parser test matrix

Snapshot/inspect AST for:

```8bx
<Foo />
<Foo a={1} />
<Foo>Hello</Foo>

<>
    <Foo />
    <Bar />
</>
```

Test accurate source spans.

### 123. Resolver test matrix

Test:

```text
.8bs → .8bs
.8bx → .8bx
.8bx importing .8bs
.8bs importing ordinary export from .8bx
package entry .8bx
package subpath .8bx
machine .8bx variant
machine+hardware-tag .8bx variant
missing .8bx
wrong target variant
```

### 124. Semantic test matrix

Test:

```text
unknown component
component import
wrong prop type
missing prop
unknown prop
duplicate prop
children accepted
children rejected
component recursion
state isolation between instances
compile-time prop folding
runtime prop evaluation exactly once
component called from .8bs as a positional call (4.5)
children-required slot called from .8bs is refused
.8bx as a program entry is refused by name
asm6502 in .8bx is refused with the block's span (2.6 A)
top-level function without an element in .8bx warns; a component method does not (2.6 B)
bx.strict: false silences the warning and not the errors
```

### 125. Backend tests

At least one BX source should compile all the way to:

```text
6502
WASM
```

without BX-specific logic in the backend.

The test should prove the elaborated IR is ordinary valid IR.

### 126. Emulator tests

Build increasingly ambitious proof programs.

#### Proof 1: PET

```text
BX text/menu component
```

Shows that component composition works on the simplest target.

#### Proof 2: C64

```text
sprite or color/raster component
```

Proves BX is not a character-grid framework.

#### Proof 3: NES

```text
tile/sprite composition
```

Proves the abstraction survives a fundamentally different video architecture.

#### Proof 4: Web

Same conceptual source executes through WASM.

## Part 22 — Dogfood Ladder & Performance Gates

### 127. Dogfood ladder

Do not attempt Studio first.

Use this order:

##### 1. Hello BX

```8bx
<Text>Hello World!</Text>
```

##### 2. Existing menu bar

Wrap the existing optimized immediate-mode implementation.

##### 3. 2048 title/menu

Move the 2048 game's frontend composition to 8BX.

##### 4. 2048 board

Prove runtime variables/state and repeated visual elements.

##### 5. Raster title

Prove cycle-sensitive custom rendering.

##### 6. Tracker mockup

Prove dense application UI plus audio behavior.

##### 7. Small vector demo

Prove non-grid graphics.

##### 8. Raycaster demo

Prove 8BX does not constrain the rendering architecture.

##### 9. Studio

Begin migrating real editor surfaces.

### 128. Performance gates

For every dogfood stage record:

```text
program bytes
RAM bytes
zero-page use
frame time/cycles where meaningful
generated component state
```

8BX should have explicit performance budgets.

A beautiful syntax that triples every program is not success.

## Part 23 — Milestones 1–6

### 129. First milestone definition

The first **real** 8BX milestone should be deliberately narrow:

```text
✓ .8bx recognized everywhere
✓ .8bx may contain all current .8bs syntax
✓ .8bs behavior completely unchanged
✓ element syntax parses
✓ fragments parse
✓ string attributes
✓ expression attributes
✓ raw text children
✓ expression children
✓ custom component declarations
✓ imported components
✓ typed props
✓ components callable from .8bs (4.5)
✓ child slot
✓ stateless static components
✓ elaboration to existing core AST/IR
✓ PET build
✓ web build (fixed-grid skins)
✓ fluid web build variant — viewport as a run fact, the runtime layout step named (§74)
✓ asm6502 refused in .8bx; ordinary-code lint (2.6)
✓ programs / images accepted and validated in the config (4.6, 4.7)
✓ VS Code highlighting
✓ LSP diagnostics
```

Not yet required:

```text
stateful components
classes
interfaces
spread props
arrow functions
.map()
dynamic component pools
raster scheduler
reactive UI
named slots
component inheritance
```

That gives us a real usable foundation without boiling the ocean.

### 130. Second milestone

Add:

```text
component state
multiple static instances
component methods
conditional elements
ternary expression
compile-time dead-component elimination
size reporting
C64/VIC-20/NES builds
UI package wrapper
2048 migration
```

### 131. Third milestone

Add the structured-language work:

```text
struct
field access
methods
interfaces
typed component contracts
typed slots
component state structs
refs
better binder/type checker
go-to-definition
rename/references
```

### 132. Fourth milestone

Advanced composition:

```text
explicit frame tasks
interrupt composition
raster schedules
resource claims
compile-time conflict checking
audio graphs
graphics pipelines
target-specialized components
cycle-sensitive components
```

This is where demoscene-grade 8BX becomes real.

### 133. Fifth milestone

Dynamic/bounded systems:

```text
component pools
bounded entity instances
explicit arenas
iterators
arrow functions where useful
bounded map/filter-style operations
spread props
richer generic types
```

Still no mandatory heap.

### 134. Sixth milestone

Full application framework:

```text
windows
focus
pointer dispatch
keyboard navigation
desktop/window manager
menus
dialogs
editors
dock/layout system
dirty-region redraw
themes
accessibility-style semantic input where useful
```

This is a library built on 8BX, not what 8BX itself means.

## Part 24 — PR Sequence

### 135. Suggested implementation PR sequence

Keep every PR independently understandable and green.

#### PR 0 — Config shape

- typed `defineConfig()` from `@8bitscript/cli`; `packages/cli/schemas/config.json`
- `programs` accepted, validated, and driving `build`/`run`/`--release`; `entry` kept as sugar (4.6)
- `images` accepted and validated; building one reports "not written yet" (4.7)
- `bx.strict` accepted (2.6)
- config-only: no source-kind change, no grammar. This is the PR that stops a later refactor.

#### PR 1 — Source kinds

- add `.8bx` source kind
- centralize source extensions
- generalize target variants
- CLI accepts `.8bx` anywhere in the graph, and refuses it as a program entry with the rule named (4.3)
- resolver accepts explicit `.8bx`
- package entries may use `.8bx`
- tests
- no BX syntax yet

An `.8bx` file at this stage behaves exactly like `.8bs`.

#### PR 2 — Editor recognition

- VS Code registers `.8bx`
- separate BX language ID
- BX TextMate grammar initially includes ordinary 8BS
- extension activation includes `.8bx`
- LSP client selects both language IDs
- tests/docs

Still no element syntax.

#### PR 3 — Binder foundation

- symbol table
- lexical scopes
- module declarations
- imports
- functions
- variables
- consts
- namespaces
- parameters
- user-defined hover/definition groundwork
- tests

Do this before trying to resolve `<Component>` names.

#### PR 4 — BX lexer

- source-kind lexer mode
- BX text/tag scanning
- no parser lowering yet
- extensive ambiguity/error-recovery tests

#### PR 5 — BX parser/AST

Add:

```text
BxElement
BxFragment
BxAttribute
BxText
BxExpressionChild
```

Parser handles nested elements and fragments.

IR lowering deliberately reports "valid 8BX construct not compilable yet."

This matches the compiler's existing exhaustive-with-error philosophy.

#### PR 6 — Component declarations

Add:

```text
component
```

to `.8bx`.

Support:

```8bx
component Foo(a: utinyint) {
    ...
}
```

Bind component symbols/signatures.

No state yet.

#### PR 7 — Component checker

Validate:

```text
component existence
props
prop types
missing props
children
closing tag semantics
component recursion
```

#### PR 8 — Stateless elaboration

Implement:

```text
BX AST
→ Composition IR
→ core AST/IR
```

Support:

```8bx
<Foo />
<Foo x={value} />
<Wrapper><Foo /></Wrapper>
<>
    ...
</>
```

MOS/WASM remain unaware of BX.

#### PR 9 — End-to-end Hello BX

Create an example package.

Build/run on:

```text
PET
web
```

Add emulator/screenshot verification where appropriate.

#### PR 9b — Fluid web variant

A `fluid` hardware value in the web catalog; the runtime layout step, named and measured; Hello BX and the menu bar laid out to the viewport. A PET build of the same source is byte-identical to before this PR — that is the test (§74).

#### PR 10 — Existing UI dogfood

Add 8BX component wrappers around the menu bar.

Measure size versus ordinary 8BS use.

Fix compiler specialization/elaboration if the cost is unacceptable.

#### PR 11 — Conditional expression

Add proper `?:` support to core 8BitScript.

Use it for conditional children/components.

Verify compile-time conditions prune unused branches.

#### PR 12 — Component state

Add:

```text
state
per-static-instance layout
state references
state methods
```

Memory usage must appear in the compiler's normal memory report.

#### PR 13 — 2048 migration

Move appropriate frontend/game composition into `.8bx`.

Keep core algorithms in `.8bs` where that is cleaner.

This becomes the first serious mixed `.8bs` / `.8bx` project.

#### PR 14 — Struct foundation

Implement fixed-layout structs.

Use them internally for richer component state.

#### PR 15 — Rich IntelliSense

Using binder information add:

```text
component completion
prop completion
hover
definition
closing-tag support
user symbols
```

#### PR 16+ — Advanced graphics/audio/raster

Only after the component model has survived real programs.

## Part 25 — Files Touched Early

### 136. Files likely touched early

#### Compiler

```text
packages/compiler/index.mjs

packages/compiler/src/source/
packages/compiler/src/lexer/index.mjs
packages/compiler/src/lexer/AGENTS.md
packages/compiler/src/parser/index.mjs
packages/compiler/src/ast/index.mjs

packages/compiler/src/binder/
packages/compiler/src/bx/
packages/compiler/src/checker/
packages/compiler/src/ir/index.mjs
packages/compiler/src/resolver/index.mjs
packages/compiler/src/linker/index.mjs
packages/compiler/src/intellisense/index.mjs

packages/compiler/test/
```

#### CLI

```text
packages/cli/src/build.mjs
packages/cli/src/check.mjs
packages/cli/src/config.mjs
packages/cli/src/run.mjs
packages/cli/src/last-run.mjs
packages/cli/src/artifact-name.mjs
packages/cli/schemas/config.json
packages/cli/bin/8bs.mjs
```

Anywhere else that:

```text
assumes src/main.8bs
strips ".8bs"
recognizes target variants
prints ".8bs" in usage
discovers source files
```

#### Language server

```text
packages/language-server/src/server.mjs
packages/language-server/test/
```

Eventually the server should receive source kind/language ID for untitled buffers.

#### VS Code

```text
editors/vscode/package.json
editors/vscode/src/extension.cjs
editors/vscode/syntaxes/8bs.tmLanguage.json
editors/vscode/syntaxes/8bx.tmLanguage.json
editors/vscode/snippets/8bs.json
editors/vscode/snippets/8bx.json
editors/vscode/language-configuration.json
editors/vscode/README.md
```

#### Documentation

The documentation set was wiped ahead of the native-backend rewrite (#31); `docs/` today is `index.md`, `config.md`, `web-embedding.md` and `project/`. So:

Update:

```text
docs/project/8bx.md        (defers to this spec; stale 0.2.0 framing removed)
docs/config.md             (programs, images, defineConfig — 4.6–4.8)
docs/index.md
README.md                  (file-extensions table: .8bx)
AGENTS.md
packages/compiler/AGENTS.md
packages/compiler/src/lexer/AGENTS.md
packages/ui/AGENTS.md      (the menu bar wrapper, §68)
packages/web/AGENTS.md     (the fluid variant, §74)
```

Add, as the pages return with the rewrite: a language page for 8BX beside the compiler's, and the language-server page's 8BX section.

## Part 26 — Anti-Goals, Architecture & Definition

### 137. Documentation definition

I would describe 8BX publicly roughly as:

> **8BX is 8BitScript's declarative composition syntax. An `.8bx` file is an 8BitScript source file with additional JSX-like element expressions. Components may describe interfaces, games, graphics pipelines, raster programs, audio systems, resources, operating-system services, editors, or arbitrary programmer-defined abstractions. 8BX does not imply a DOM, virtual component tree, framebuffer, retained-mode interface, or garbage collected runtime. Components are resolved and specialized by the 8BitScript compiler wherever possible and lower to the same native program model as ordinary `.8bs` code.**

That should become the north-star definition.

### 138. What we should explicitly NOT do

Do not:

```text
translate 8BX into React
ship JSX runtime objects to the 6502
create a virtual DOM
assume components have rectangles
assume components render
make UI the core component type
require a framebuffer
require a game loop
require automatic rerendering
require a heap
make props dynamic dictionaries
represent children as heap arrays
hide state allocation
hide target limitations
force every target through one renderer
make raster hacks bypass 8BX
make target-specific code second-class
implement BX as regex/source rewriting
fork the compiler into 8BSCompiler and 8BXCompiler
put machine code in an .8bx file
let an .8bx file be a program
make a cartridge a config key instead of hardware
let a fluid web build cost a PET build one byte
```

### 139. Architectural picture

```text
                   ┌──────────────────┐
                   │     foo.8bs      │
                   │   core syntax    │
                   └────────┬─────────┘
                            │
                            │
                   ┌────────▼─────────┐
                   │   shared lexer   │
                   │   shared parser  │
                   └────────┬─────────┘
                            │
                            │
                            │
┌──────────────────┐        │
│     App.8bx      │        │
│                  │        │
│  core 8BS syntax│        │
│        +         │        │
│   BX elements    │        │
└────────┬─────────┘        │
         │                  │
         ▼                  │
┌──────────────────┐        │
│ lexer in BX mode │        │
│ parser in BX mode│        │
└────────┬─────────┘        │
         │                  │
         └──────────┬───────┘
                    ▼
              ┌───────────┐
              │    AST    │
              └─────┬─────┘
                    ▼
              ┌───────────┐
              │   fold    │
              │ #fact etc │
              └─────┬─────┘
                    ▼
              ┌───────────┐
              │  binder   │
              └─────┬─────┘
                    ▼
              ┌───────────┐
              │  checker  │
              └─────┬─────┘
                    ▼
          ┌────────────────────┐
          │ BX composition HIR │
          │ only where needed  │
          └─────────┬──────────┘
                    ▼
          ┌────────────────────┐
          │ BX elaboration     │
          │                    │
          │ specialize         │
          │ allocate state     │
          │ place children     │
          │ fold static props  │
          │ register resources │
          └─────────┬──────────┘
                    ▼
             ┌─────────────┐
             │  Core IR    │
             │             │
             │ no JSX/BX   │
             └──────┬──────┘
                    ▼
                linker
                    │
             ┌──────┴──────┐
             ▼             ▼
           MOS            WASM
             │             │
             ▼             ▼
       native 6502       browser
       machine code      runtime
```

## Part 27 — First Step & End State

### 140. The most important implementation decision

**Do not start by implementing `<Button>`.**

Start by implementing:

```text
.8bx source identity
binder
element AST
component signatures
component composition/elaboration
```

Then `<Button>`, `<RasterKernel>`, `<Tracker>`, `<Raycaster>`, and `<FileSystem>` are all just different things built on the same foundation.

If we begin with UI primitives first, we risk accidentally designing an HTML framework.

If we begin with a generic component model first, UI becomes merely one extremely useful application of it.

### 141. The first concrete step

The first code change I would make is:

> **Introduce a compiler-wide `SourceKind` / source-extension abstraction and make the resolver, linker, CLI, and editor understand `.8bx` as a first-class 8BitScript source file while parsing it exactly like `.8bs` for now.**

No markup yet.

After that PR:

```text
src/App.8bx
```

should:

```text
✓ compile if it contains ordinary 8BitScript
✓ be imported by src/main.8bs, and that program build and run
✓ import .8bs
✓ use target-specific .8bx variants
✓ work as a package entry
✓ receive diagnostics
✓ open as 8BitScript in VS Code
✓ use the language server
✗ be a program entry — refused with the rule named (4.3)
```

That gives us the actual `.8bs` / `.8bx` split first.

Then we add the extra grammar.

That is the safest path to making 8BX a genuine part of 8BitScript rather than a framework sitting awkwardly on top of it.

### 142. End state

The language should eventually feel like this. The program:

```8bs
// src/main.8bs — the program entry, always .8bs (4.3)
import { App } from "./App.8bx";

export function main(): void {
    App();
}
```

Its composition:

```8bx
// src/App.8bx
import { Video } from "@8bitscript/system";
import { Game } from "./game.8bs";
import { Tracker } from "./Tracker.8bx";
import { DemoTitle } from "./DemoTitle.8bx";

export component App() {
    state mode: utinyint = 0;

    function update(): void {
        Game.update();
    }

    return (
        <Application>
            {mode == 0
                ? <DemoTitle />
                : <GameView />
            }

            <AudioEngine />

            {Video.SPRITES > 0
                ? <SpriteEffects />
                : <SoftwareEffects />
            }

            <DebugTools>
                <Tracker />
            </DebugTools>
        </Application>
    );
}
```

And `DemoTitle.c64.8bx` should be free to contain something like:

```8bx
export component DemoTitle {
    function rasterIRQ(): void {
        asm6502 {
            // exact cycle-sensitive C64 implementation
        }
    }

    return (
        <RasterKernel>
            <RasterIRQ line={48} handler={rasterIRQ} />
            <SpriteMultiplexer />
            <CopperBars />
            <Scroller />
        </RasterKernel>
    );
}
```

while another target gets a completely different implementation.

That is the version of 8BX worth building:

**JSX-like syntax, 8BitScript semantics, compile-time composition, explicit memory, unrestricted native access, and no assumption whatsoever that a "component" is a web widget.**
