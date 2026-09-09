# @8bitscript/ui

Reusable interface components for 8BitScript programs. A component draws on
the character grid through [`@8bitscript/text`](../text), so the same code
puts the same thing on a PET's 40 columns, a VIC-20's 22, and a Commander
X16's 76 — there is one menu bar, not nine.

Today there is one component.

```bash
pnpm add @8bitscript/ui
```

```
import { text, TextColor } from "@8bitscript/text";
import { menubar } from "@8bitscript/ui/menubar";

export function main(): void {
    menubar.setColors(TextColor.WHITE, TextColor.YELLOW);
    menubar.select(1);

    menubar.begin(0, text.COLUMNS);
    menubar.item("FILE");
    if (menubar.item("EDIT")) {
        text.print(text.COLUMNS, "EDIT MENU");
    }
    menubar.item("VIEW");
    menubar.end();
}
```

```
 FILE -EDIT- VIEW
```

Every component is its own subpath, so a program links the ones it names
and nothing else — there is no `import ... from "@8bitscript/ui"`.

## The menu bar

`@8bitscript/ui/menubar` draws one row of items with the selected one
inverted — reverse video in the item colour, a filled bar rather than a
recoloured word.

| Call | What it does |
| --- | --- |
| `begin(at, cells)` | Open a bar at cell `at`, using `cells` cells and never one more |
| `item(name)` | Draw the next item; returns whether it is the highlighted one |
| `end()` | Close the bar, blanking whatever is left of it |
| `select(i)` / `selected()` | Which item is highlighted; 0 is the first |
| `count()` | How many items the last run offered, drawn or not |
| `clipped()` | Whether an item had to be dropped for want of room |
| `setColors(item, highlight)` | Item colour; invert uses it, `highlight` is unused |
| `setPadding(cells)` | Space either side of each label; 1 by default |
| `setMarker(s)` | The bracket, a one-character string; `"-"` by default, `""` for none |
| `HEIGHT` | Rows a bar occupies, so a program can lay out under it |

**The bar is a run of calls, not an object.** There is no list of items
kept anywhere: `begin()` opens the bar, each `item()` draws one and moves
the cursor along, and `end()` closes it. Redrawing means running the calls
again. Nothing allocates, and no RAM is spent remembering what the program
already knows — which matters on a machine with 3583 bytes for the whole
program.

**`item()` returns whether that item is the highlighted one**, so

```
if (menubar.item("FILE")) { drawFileMenu(); }
```

is how a program hangs behaviour off the selection. Nothing moves the
highlight on its own: this component never reads input, so a program
calls `select()`, `next()`, `previous()` or `deselect()` itself, driving
them from `@8bitscript/input` or from anything else it likes.

**The selected item is inverted, not recoloured.** Reverse video fills the
label and its padding in the item colour; a reverse space is a solid
block, so the item reads as a button. That works on all nine, including
the three with no per-cell colour: the NES ships inverted copies of its
font at ASCII+128, and the PET and Atari invert with bit 7 of the screen
code.

**Drawing goes through `text.print`, and that is worth 423 bytes.**
`print` does a machine's per-run video setup once and then walks the string;
`putChar` is self-sufficient, so it redoes that setup — and an ASCII
conversion, and a sixteen-bit pointer build — for every cell, inlined into
wherever it was called. So the bar prints everything: `begin()` blanks the
row in one pass, `item()` prints its label and a padding space either side
(reverse spaces are the filled ends of a selected item), and reverse rides
along on `print` rather than a second pass over the cells. Built the obvious
way instead — runs of
`putChar` for padding, marker, label, marker, padding — `item()` compiled to
743 bytes on a C64 rather than 285. Adding the bar to Studio costs 423 bytes
on a C64 and 396 on a VIC-20;
[AGENTS.md](AGENTS.md#what-it-costs) has the table for every machine, the
four shapes measured on the way, and the `@8bitscript/text` primitive that
would take another bite out of it.

**Drawing a bar leaves the text colour set to the bar's.** That is how the
colour gets on without a second pass, and there is no `text.getColor` to put
your setting back with. Draw the bar, *then* set your own colour:

```
menubar.setColors(TextColor.CYAN, TextColor.WHITE);
drawBar();
text.setColor(TextColor.WHITE);   // the rest of the screen is yours
```

**A bar never writes past the cells it was given.** An item with no room
left is not drawn — it still takes its index, so which item is selected
does not depend on the width of the screen — and `clipped()` says so
afterwards. `FILE EDIT VIEW HELP` needs 24 cells and a VIC-20's row has 22,
so on that machine `HELP` is dropped and `clipped()` is true. What to do
about it is the program's decision: shorter labels, less padding, or a
second row.

## See it run

[8BitScript Studio](../studio) uses a four-item bar across the top of its
front door. Until 0.2.0, `8bs build` refuses every target, so that picture
is the pre-0.2.0 layout, not something trunk emits today. The VIC-20 is the
machine where `FILE EDIT VIEW HELP` does not fit a 22-column row: `HELP` is
dropped and `clipped()` is true.

## Adding a component

See [AGENTS.md](AGENTS.md): what belongs here rather than in a machine
package, what the character grid does and does not give you on each target,
and the rule that every component links for all nine.
