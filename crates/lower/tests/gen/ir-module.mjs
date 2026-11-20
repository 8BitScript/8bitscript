// Regenerates fixtures/ir-module.json from packages/compiler/src/ir (the JS oracle).
// Run from the repo root: node crates/lower/tests/gen/ir-module.mjs
//
// Every row is a front tap record (scripts/oracle/front-tap): `lower` runs through the tap's
// wrapper over a small module and the row is read back from its output, so `args` is
// `[ast, file, source]` and `result` is `{ir, diagnostics}` in the tap's encoding (a Map is
// `[[k, v], ...]`). The modules cover each top-level kind and each way module lowering refuses
// one; a few reach a function body, which this unit does not lower.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, tokenize } from '../../../../packages/compiler/src/front/index.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ir-module-gen-'));
process.env.EIGHTBS_FRONT_TAP = dir;
delete process.env.EIGHTBS_FRONT_TAP_ROOTS;
const { lower } = await import('../../../../scripts/oracle/front-tap/shims/ir.mjs');

const log = join(dir, '0.jsonl');
function take() {
  const rows = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  if (existsSync(log)) rmSync(log);
  return rows;
}

const sources = {
  empty: '',
  'const literals': `const A: u8 = 4;
const B: u16 = 300;
const NEG: i8 = -5;
const POS: i8 = +5;
const FLAG: bool = true;
const OFF: bool = false;
const COPY: u8 = A;
const WIDE: usmallint = 24;
const BIG: u32 = 70000;
const UNTYPED = 7;
pub const OUT: u8 = 1;
`,
  'const pending': `use "other.8bs"::{Imported};
const FROM_IMPORT: u8 = Imported;
const FROM_MEMBER: u8 = Colors.BLUE;
const AFTER: u8 = FROM_IMPORT;
const ARR: [u8; 2] = [FROM_IMPORT, 1];
`,
  'const refused': `const NO_INIT: u8;
const SUM: u8 = 1 + 2;
let own: u8 = 1;
const FROM_OWN: u8 = own;
const BAD: thing = 1;
const VOL: volatile<u8> = 1;
@address(0x10) const MAPPED: u8 = 1;
`,
  globals: `let a: u8;
let mut b: u16 = 5;
let c: i8 = -3;
let d: u32;
let flag: bool;
let on: bool = true;
let low: utinyint = 0;
pub let mut shown: u8 = 9;
`,
  'volatile and address': `const REG: u16 = 0x9000;
@address(0xD020) let mut border: u8;
@address(REG) let mut reg: volatile<u8>;
let mut port: volatile<u8>;
let mut wide: volatile<u16> = 3;
@address(0x10) let mut mapped_init: u8 = 1;
@address(Colors.BLUE) let mut member_address: u8;
@address() let mut no_argument: u8;
@size(2) let mut other_decorator: u8;
let mut bad_volatile: volatile<thing>;
let mut no_volatile: volatile;
`,
  'global refused': `let untyped = 1;
let thing_typed: thing;
let own: u8 = 1;
let from_own: u8 = own;
let from_sum: u8 = 1 + 2;
let from_member: u8 = Colors.BLUE;
let from_import: u8 = Imported;
let from_neg: i8 = -(3);
let from_ternary: u8 = true ? 1 : 2;
let from_not: bool = !true;
let from_tilde: u8 = ~1;
let from_template: u8 = \`text\`;
let from_array: u8 = [1, 2];
let from_record: u8 = { x: 1 };
let from_string: u8 = "x";
let from_index: u8 = TABLE[1];
let from_length: u8 = TABLE.length;
const TABLE: [u8; 3] = [1, 2, 3];
`,
  'string consts and buffers': `const HELLO: string = "HELLO";
const SAME: string = "HELLO";
const CAP: u8 = 6;
let name: string<4>;
let greeting: string<8> = "HI";
let sized: string<CAP> = "ABC";
pub let mut shown: string<2>;
`,
  'string refused': `const WITH_ARGS: string<4> = "HI";
const NOT_LITERAL: string = 3;
const NO_INIT: string;
@address(0x10) let mapped: string<4>;
let no_capacity: string;
let two: string<4, 5>;
let zero: string<0>;
let huge: string<256>;
let unknown: string<MISSING>;
let fraction: string<1.5>;
let too_long: string<2> = "TOO LONG";
let not_literal: string<4> = 7;
let nested: string<array<u8, 2>>;
let wide_text: string<4> = "é€";
`,
  'arrays': `const COUNT: u8 = 4;
let hp: [usmallint; 4];
const TABLE: [utinyint; 3] = [1, 2, 3];
let sized: [u8; COUNT];
let scores: [u8; 2] = [10, 20];
let flags: [bool; 2] = [true, false];
let signed: [i8; 2] = [-1, 127];
@address(0x0400) let screen: [u8; 8];
pub let mut exported: [u8; 2];
const FROM_CONST: [u8; 2] = [COUNT, 2];
`,
  'array refused': `let zero: [u8; 0];
let missing: [u8; NOPE];
let no_type: array<u8>;
let strings: [string; 2];
let short: [u8; 4] = [1, 2];
let long: [u8; 1] = [1, 2];
let range: [u8; 2] = [1, 300];
let negative: [u8; 1] = [-1];
let not_const: [u8; 1] = [own];
let own: u8 = 1;
const NO_VALUES: [u8; 2];
@address(0x10) const MAPPED: [u8; 2] = [1, 2];
@address(0x10) let mapped_init: [u8; 2] = [1, 2];
@size(2) let other: [u8; 2];
@address(nope) let bad_address: [u8; 2];
let not_literal: [u8; 2] = 5;
let element_sum: [u8; 1] = [1 + 1];
let one: [u8; 1] = [1];
`,
  'array pending': `let imported: [u8; 3] = [Imported, 1, Colors.BLUE];
const PENDING: u8 = Other;
let after: [u8; 1] = [PENDING];
`,
  'namespace consts': `pub mod Colors {
    const BLUE: utinyint = 6;
    const WIDE: usmallint = 24;
    const NEG: tinyint = -2;
    const FLAG: bool = true;
    pub const LABEL: string = "READY";
    const COPY: utinyint = BLUE;
    const OTHER: utinyint = Elsewhere.X;
    const IMPORTED: utinyint = Imported;
}
mod Empty {
}
const OUTER: u8 = 3;
mod Uses {
    const FROM_OUTER: u8 = OUTER;
}
`,
  'namespace refused': `let own: u8 = 1;
mod Bad {
    let mut value: u8 = 1;
    const NO_TYPE = 1;
    const WEIRD: thing = 1;
    const VOIDED: void = 1;
    const SUM: u8 = 1 + 2;
    const FROM_OWN: u8 = own;
    const NO_INIT: u8;
    const NOT_STRING: string = 3;
    const NO_STRING_INIT: string;
    const TEMPLATE: u8 = \`t\`;
}
`,
  imports: `use "a.8bs"::{One, Two as Second};
use "b.8bs"::Three;
use lib::shapes::{Circle, Square as Box};
use lib::util::Helper;
use "c.8bs"::{};
`,
  'import refused': `use ;
use "";
use "d.8bs"::{ ;
`,
  'top level refused': `1 + 2;
let a: u8 = 1;
{ }
if true { }
state s: u8 = 1;
component Thing() { }
`,
  'expressions in initializers': `const SELF: string = "SELF";
const T: [u8; 2] = [1, 2];
let from_string_index: u8 = SELF[0];
let from_string_length: u8 = SELF.length;
let from_array_length: u8 = T.length;
let from_array_bad_member: u8 = T.size;
let from_member_of_call: u8 = (1 + 2).length;
let from_member_of_index: u8 = T[0].length;
let from_deep_member: u8 = a.b.c;
let from_index_out: u8 = T[5];
let from_index_negative: u8 = T[-1];
let from_index_var: u8 = T[i];
let from_index_of_const: u8 = SELF2[0];
let from_array_name: u8 = T;
let from_unknown_array: u8 = Imported[0];
let from_non_array: u8 = i[0];
let i: u8 = 0;
let from_nested_ternary: u8 = true ? (false ? 1 : 2) : 3;
let from_mixed_ternary: u8 = true ? 1 : Imported;
let from_comparison: bool = 1 < 2;
let from_logic: bool = true && false;
let from_mixed: u8 = 1 + Imported;
let from_wide: u16 = 1 + 300;
`,
  'function bodies': `const A: u8 = 4;
let g: u8 = 1;
const GREETING: string = "HI";
pub fn main() {
    g = A;
}
fn helper(n: u8) -> u8 {
    return n;
}
let after: u8 = 2;
mod screen {
    const BLUE: utinyint = 6;
    fn border(color: utinyint) {
    }
    const AFTER: string = "AFTER";
}
use "x.8bs"::{Y};
`,
  'function with template': `let a: u8;
pub fn main() {
    text::print(0, \`TICK \${a % 10:1}\`);
}
`,
  'call in initializer': `fn f() -> u8 { return 1; }
let a: u8 = f();
const B: u8 = f();
mod m {
    const C: u8 = f();
}
let arr: [u8; 1] = [f()];
`,
  'unterminated and holes': `let a: u8 =
const B: u8 = ;
let c: [u8; ] = [;
mod {
}
mod M {
    const X: u8 = ;
    fn
}
let d: string<
`,
  // A literal past the i64 range: the IR value saturates, the message keeps the JS number.
  'huge literal': `let g: u8 = 99999999999999999999;
const BIG: i32 = 99999999999999999999;
let h: u8 = BIG;
let a: [u8; 1] = [99999999999999999999];
let b: [u8; 1] = [-BIG];
`,
  // Negating a saturated const must not overflow.
  'negated huge const': `const X: i32 = -99999999999999999999;
let g: i16 = -X;
`,
};

const rows = [];
for (const [key, text] of Object.entries(sources)) {
  const file = `${key.replaceAll(' ', '-')}.8bs`;
  const { tokens } = tokenize(text, file, { sourceKind: '.8bs' });
  const { ast } = parse(tokens, text, file, { sourceKind: '.8bs' });
  lower(ast, file, text);
  for (const row of take()) {
    const { seq, ...rest } = row;
    rows.push({ name: key, ...rest });
  }
}
// A module without a source text.
{
  const text = 'let a: u8;\n';
  const { tokens } = tokenize(text, 'n.8bs', { sourceKind: '.8bs' });
  const { ast } = parse(tokens, text, 'n.8bs', { sourceKind: '.8bs' });
  lower(ast, 'n.8bs');
  for (const row of take()) {
    const { seq, ...rest } = row;
    rows.push({ name: 'no source', ...rest });
  }
}

writeFileSync(fileURLToPath(new URL('../fixtures/ir-module.json', import.meta.url)), `${JSON.stringify(rows)}\n`);
rmSync(dir, { recursive: true, force: true });
console.log(`wrote ${rows.length} rows`);
