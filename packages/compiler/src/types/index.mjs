// The primitive integer type registry.
//
// One authoritative description of `utinyint`/`u8` and its seven siblings, so
// nothing downstream keeps its own copy. Before this module existed, the
// lexer's type-name set, the checker's range table, and each backend's width
// map were four hand-written lists that had to be kept in lockstep by hand.
// Now they all read this one.
//
// Naming is MySQL-inspired on purpose: `tinyint`/`smallint`/`mediumint`/`int`
// (and their `u`-prefixed unsigned counterparts) read as storage sizes to
// someone who has never seen `i8`/`u32`-style abbreviations, which is exactly
// the audience this is for. `i8`, `u8`, and so on remain as low-level aliases
// — the systems-programming spelling stays available, it just is not what the
// language leads with. `bigint`/`ubigint` are reserved for a future 64-bit
// type and deliberately not recognised anywhere yet.
//
// The canonical name IS the internal id: the IR and both backends key their
// own data by `canonicalName` (`utinyint`, not `u8`). `utinyint` and `u8` are
// never two types that happen to agree; they resolve to the same descriptor
// before anything downstream ever sees them.

/**
 * @typedef {object} IntegerType
 * @property {string} canonicalName  Preferred, human-readable spelling (e.g. "utinyint") —
 *                                    also the id every compiler stage stores internally.
 * @property {string} legacyAlias    The short systems-programming spelling (e.g. "u8").
 * @property {string[]} aliases      Every spelling other than the canonical one.
 * @property {boolean} signed
 * @property {number} bits
 * @property {number} bytes
 * @property {number} min            Inclusive.
 * @property {number} max            Inclusive.
 * @property {string} summary        One sentence, e.g. "Unsigned 1-byte integer."
 */

/** Signed base name by bit width; the unsigned spelling is always `u` + this. */
const WIDTH_NAME = { 8: 'tinyint', 16: 'smallint', 24: 'mediumint', 32: 'int' };

function makeIntegerType(bits, signed) {
  const range = 2 ** bits;
  const bytes = bits / 8;
  const base = WIDTH_NAME[bits];
  const canonicalName = signed ? base : `u${base}`;
  const legacyAlias = `${signed ? 'i' : 'u'}${bits}`;
  return {
    canonicalName,
    legacyAlias,
    aliases: [legacyAlias],
    signed,
    bits,
    bytes,
    min: signed ? -(range / 2) : 0,
    max: signed ? range / 2 - 1 : range - 1,
    summary: `${signed ? 'Signed' : 'Unsigned'} ${bytes}-byte integer.`,
  };
}

/**
 * Every canonical primitive integer type, narrowest first and signed before
 * unsigned within a width — the order completion offers them in:
 * tinyint, utinyint, smallint, usmallint, mediumint, umediumint, int, uint.
 */
export const PRIMITIVE_INTEGER_TYPES = [8, 16, 24, 32].flatMap(
  (bits) => [makeIntegerType(bits, true), makeIntegerType(bits, false)],
);

const BY_SPELLING = new Map();
for (const type of PRIMITIVE_INTEGER_TYPES) {
  BY_SPELLING.set(type.canonicalName, type);
  for (const alias of type.aliases) BY_SPELLING.set(alias, type);
}

/** Every spelling a primitive integer type can be written with, canonical or alias. */
export const INTEGER_TYPE_NAMES = [...BY_SPELLING.keys()];

/**
 * Resolve any spelling — canonical (`utinyint`) or legacy alias (`u8`) — to
 * its descriptor. Two different spellings of the same type return the same
 * object, which is what "not a separate type internally" means in practice.
 *
 * @param {string} name
 * @returns {IntegerType | undefined}
 */
export function resolveIntegerType(name) {
  return BY_SPELLING.get(name);
}

/**
 * Inclusive `[min, max]` ranges, keyed by every recognised spelling. Kept for
 * callers that only ever needed bounds — the checker's original shape, before
 * it had a reason to ask for anything else.
 */
export const INTEGER_RANGES = Object.fromEntries(
  INTEGER_TYPE_NAMES.map((name) => {
    const type = resolveIntegerType(name);
    return [name, [type.min, type.max]];
  }),
);
