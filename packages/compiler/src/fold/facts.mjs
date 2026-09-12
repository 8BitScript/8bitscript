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
// the sheet because the level machines (packages/compiler/src/mos, FRAME_SYNC)
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
  ['video.palette', count('build', 'Colors the display can show at once.')],
  ['video.cellColors', count('build', 'Colors one cell can hold in the text mode the grid uses.')],
  ['video.colorPerCell', flag('build', 'A program can set one cell\'s color without changing its neighbors\'.')],
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
  ['video.spriteColors', count('build', 'Colors one hardware sprite can hold, not counting transparent.')],
  ['video.frameRate', count('build', 'Display refreshes a second, for timing a screenshot; not on the sheet, the machine may be NTSC or PAL at run time.', false)],
  ['video.characterSetSwapped', flag('build', 'The two-set character ROM\'s upper/lower-case halves are the other way round from every other model (measured against the real ROM: the original PET 2001\'s 901447-08 only) — packages/pet/src/text.8bs\'s own asciiToScreenCode reads this, not a program.', false)],
  ['video.bootsInTextMode', flag('build', 'The ROM leaves the machine in its mixed-case text character set at power-on rather than the upper-case/graphics one (the PET\'s business-keyboard editor ROMs do; the 3032 and 4032 do not). A target\'s text package encodes for whichever set this names, so it never has to switch a screen-wide character-set bit and never re-renders text already drawn — packages/pet/src/text.8bs reads it, not a program.', false)],
  ['memory.chrget', count('build', 'Zero-page address of BASIC\'s CHRGET routine (24 bytes): $70 on BASIC 2/4, $C2 on BASIC 1 (the original PET 2001). The native backend leaves that window alone so a SYS return still has an interpreter. Not on the program sheet.', false)],
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
  ['storage.kib', count('build', 'KiB that place holds — the medium\'s usable capacity, not its image size; 0 where there is nowhere to save. Where the route is a host directory or a card whose size is the owner\'s, it is the smallest real medium that route stands for, so a program that fits the fact fits the hardware. KiB rather than bytes because a disk does not fit in the 16 bits an 8-bit machine counts in — the same reason memory.bankedKib is KiB.')],
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
 * capitalized; the const is the rest in upper snake case.
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
 * Check a `requires` block against the table: what a program needs of the
 * machine it is built for, before the machine is known.
 *
 * A count is a floor and a flag must be true — "at least this much RAM",
 * "somewhere to save" — because that is the shape of every requirement a
 * program actually has. A `when: 'run'` fact cannot be required: whether a
 * mouse is plugged in is answered on the machine, not by the build, so a
 * program that needs one asks the capability and says so itself.
 *
 * @param {object} requires
 * @returns {string[]} the problems, in words; empty when clean
 */
export function requiresProblems(requires) {
  const problems = [];
  for (const [key, need] of Object.entries(requires ?? {})) {
    const fact = FACTS.get(key);
    if (!fact) {
      problems.push(`'${key}' is not a fact — the keys are ${PROGRAM_FACTS.join(', ')}`);
      continue;
    }
    if (!fact.program) {
      problems.push(`'${key}' is not on a program's sheet, so a program cannot require it`);
      continue;
    }
    if (fact.when === 'run') {
      problems.push(
        `'${key}' is settled on the machine, not by the build, so it cannot be required — `
        + 'ask the capability at run time instead',
      );
      continue;
    }
    if (fact.type === 'flag' && need !== true) {
      problems.push(`'${key}' is a flag: require it with true, or leave it out — not ${JSON.stringify(need)}`);
    }
    if (fact.type === 'count' && !(Number.isInteger(need) && need > 0)) {
      problems.push(`'${key}' is a count: require a whole number above zero, not ${JSON.stringify(need)}`);
    }
  }
  return problems;
}

/**
 * What a `requires` block asks for that a build's facts do not give.
 *
 * @param {object} requires  already checked by requiresProblems
 * @param {object} facts     the merged sheet for one build
 * @returns {{ key: string, need: number|boolean, have: number|boolean }[]} empty when the build is enough
 */
export function unmetRequirements(requires, facts) {
  const unmet = [];
  for (const [key, need] of Object.entries(requires ?? {})) {
    const have = facts?.[key] ?? factPlaceholder(key);
    const met = FACTS.get(key)?.type === 'flag' ? have === true : have >= need;
    if (!met) unmet.push({ key, need, have });
  }
  return unmet;
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
