// The fact sheet's keys: what a build knows about the machine it is for.
//
// A fact is a number or a flag with one meaning on every machine, keyed the
// way the machine packages' hardware catalogs spell it (`video.columns`,
// `memory.banked` — see docs/packages.md, "the hardware catalog"). The
// compiler owns the *keys* and their types; the machine packages own the
// *values*: each catalog's top-level `facts` is the stock machine's sheet
// and each hardware value's `facts` is what choosing it changes, and the
// CLI merges them for a build (packages/cli/src/hardware.mjs,
// resolveHardware). `#fact(video.columns)` folds to the merged value, and
// `@8bitscript/system` gives every key a const (`Video.COLUMNS`) so a
// program never spells a key itself.
//
// Two rules the table enforces. A fact is never missing: every catalog
// declares every key that is `program: true` (the CLI's catalog test holds
// them to it), so a machine without hardware sprites says `video.sprites`
// 0 and a program's branch on it folds away rather than failing to
// compile. And a fact is the worst case that matters, not the brochure
// figure: `video.spritesPerLine` is the number that decides whether a
// scene works (8 on the NES, whose 64 per frame would mislead), and where
// a chip has a cycle budget instead of a count (the X16), the package
// states the sprite size the count assumes.
//
// `when` says when the fact is settled. `build`: fixed by the build — the
// machine and the hardware it was built for — so the const is the truth on
// every machine the binary runs on. `run`: hardware the machine may or
// may not have when the program runs (a REU, a mouse in a port, banked
// RAM), which one binary can detect and use; the const then means "this
// build may use it" — the hardware was chosen for the build, so the
// capability's detection code is compiled in — and whether it is really
// there is the capability's runtime answer. A build that never asked for
// the hardware carries no code for it. Which facts are `run` is the
// machine's business as much as the key's: the table marks what is
// detectable *somewhere*, and a package that cannot detect it on its
// machine says so in its notes.
//
// `program: false` keys are the CLI's, not a program's: `video.frameRate`
// is what a screenshot's frame count is timed against, and it is not on
// the sheet because the level machines (packages/backend-6502, FRAME_SYNC)
// detect NTSC or PAL at run time — one binary runs at both — so a
// compile-time refresh rate would be a fact that is sometimes wrong.

/**
 * @typedef {object} Fact
 * @property {'count'|'flag'} type  a number (folds to an IntegerLiteral) or
 *   a yes/no (folds to a BooleanLiteral)
 * @property {'build'|'run'} when   see above
 * @property {boolean} program      on the program's sheet (`@8bitscript/system`)
 * @property {string} doc           one line, for hover and the editor's panel
 */

const count = (when, doc, program = true) => ({ type: 'count', when, program, doc });
const flag = (when, doc, program = true) => ({ type: 'flag', when, program, doc });

/** Every fact key, in the order the sheet lists them. @type {Map<string, Fact>} */
export const FACTS = new Map([
  // Video: the text grid and what the display is made of.
  ['video.columns', count('build', 'Cells across the text grid the portable text draws on.')],
  ['video.rows', count('build', 'Cells down the text grid.')],
  ['video.cellWidth', count('build', 'Pixels across one cell.')],
  ['video.cellHeight', count('build', 'Pixels down one cell.')],
  ['video.palette', count('build', 'Colours the display can show at once.')],
  ['video.cellColors', count('build', 'Colours one cell can hold in the text mode the grid uses.')],
  ['video.colorPerCell', flag('build', 'A program can set one cell\'s colour without changing its neighbours\'.')],
  ['video.glyphs', count('build', 'Characters a program can redefine at run time; 0 where the font is fixed.')],
  ['video.blockWidth', count('build', 'Pseudo-pixels across one cell from the fixed font\'s block glyphs; 0 where there are none.')],
  ['video.blockHeight', count('build', 'Pseudo-pixels down one cell from the block glyphs; 0 where there are none.')],
  ['video.bitmap', flag('build', 'A pixel-addressable mode exists.')],
  ['video.layers', count('build', 'Independent background layers.')],
  ['video.scroll', flag('build', 'Hardware fine scroll exists.')],
  ['video.sprites', count('build', 'Hardware sprites in total; 0 where moving objects are drawn in software.')],
  ['video.spritesPerLine', count('build', 'Hardware sprites one scanline can show — the number that decides whether a scene works.')],
  ['video.spriteWidth', count('build', 'Pixels across the largest hardware sprite.')],
  ['video.spriteHeight', count('build', 'Pixels down the largest hardware sprite.')],
  ['video.spriteColors', count('build', 'Colours one hardware sprite can hold, not counting transparent.')],
  ['video.frameRate', count('build', 'Display refreshes a second, for timing a screenshot; not on the sheet, the machine may be NTSC or PAL at run time.', false)],
  // Audio: the chip's shape.
  ['audio.voices', count('build', 'Voices the sound hardware plays at once.')],
  ['audio.noise', flag('build', 'A noise voice exists.')],
  ['audio.envelope', flag('build', 'Hardware volume envelopes (ADSR or similar) exist.')],
  ['audio.filter', flag('build', 'A hardware filter exists.')],
  ['audio.pcm', flag('build', 'Sample playback exists.')],
  ['audio.volume', flag('build', 'Each voice has its own volume.')],
  ['audio.entropy', flag('build', 'A hardware random source exists.')],
  // Input: the ports and what is plugged into them.
  ['input.keyboard', flag('build', 'A keyboard the program can read.')],
  ['input.joysticks', count('build', 'Joystick ports.')],
  ['input.pads', count('build', 'Console-style controller ports.')],
  ['input.mouse', flag('run', 'A mouse this build may use; whether one is plugged in is the capability\'s answer at run time.')],
  ['input.paddles', flag('run', 'Paddles this build may use; whether they are plugged in is the capability\'s answer at run time.')],
  // Storage.
  ['storage.save', flag('build', 'Somewhere this build can persist bytes: disk, SD card, battery RAM.')],
  // Memory.
  ['memory.ram', count('build', 'Bytes of RAM the program is linked to use, code and data together.')],
  ['memory.banked', flag('run', 'RAM beyond the CPU\'s window this build may use (a REU, an MMU bank, VERA-style banks); whether it is there is the capability\'s answer at run time.')],
  ['memory.bankedKib', count('run', 'KiB of that banked RAM the build was fitted with.')],
]);

/** The keys a program's sheet carries, in order. */
export const PROGRAM_FACTS = [...FACTS].filter(([, fact]) => fact.program).map(([key]) => key);

/**
 * The name `@8bitscript/system` gives a key: `video.spritesPerLine` is
 * `Video.SPRITES_PER_LINE`. The namespace is the key's first word
 * capitalised; the const is the rest in upper snake case.
 *
 * @param {string} key
 * @returns {{ namespace: string, name: string }}
 */
export function factConstName(key) {
  const [group, ...rest] = key.split('.');
  const member = rest.join('.');
  return {
    namespace: group[0].toUpperCase() + group.slice(1),
    name: member.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
  };
}

/**
 * The value a fact has when nothing set it: 0 or false — the placeholder
 * the fold uses with no machine in hand, and the value a catalog test
 * compares against when it insists a key was declared on purpose.
 *
 * @param {string} key
 */
export function factPlaceholder(key) {
  return FACTS.get(key)?.type === 'flag' ? false : 0;
}

/**
 * Check one facts object against the table: every key known, every value
 * of its key's type. Returns the problems, in words; empty when clean.
 *
 * @param {object} facts
 * @returns {string[]}
 */
export function factProblems(facts) {
  const problems = [];
  for (const [key, value] of Object.entries(facts ?? {})) {
    const fact = FACTS.get(key);
    if (!fact) {
      problems.push(`'${key}' is not a fact — the keys are ${[...FACTS.keys()].join(', ')}`);
      continue;
    }
    if (fact.type === 'flag' && typeof value !== 'boolean') problems.push(`'${key}' is a flag: true or false, not ${JSON.stringify(value)}`);
    if (fact.type === 'count' && !(Number.isInteger(value) && value >= 0)) problems.push(`'${key}' is a count: a whole number, not ${JSON.stringify(value)}`);
  }
  return problems;
}
