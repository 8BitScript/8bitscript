// Regenerates fixtures/parse.json from mos/asm/parse.ts, plus the OPCODES
// mnemonic/mode table the Rust parser keeps a private copy of. From the repo root:
//   node crates/mos/tests/gen/parse.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAsm } from '../../../../packages/compiler/src/mos/asm/parse.ts';
import { OPCODES } from '../../../../packages/compiler/src/mos/asm/encode.ts';

const texts = [
  // every spelling of a literal and addressing mode
  'sei\ncld\nnop',
  'lda #$FF\nlda #0xFF\nlda #%1010\nlda #42\nlda #255\nldx #$0\nldy #%101',
  'lda #256', 'lda #$100', 'lda #%100000000', 'lda #1e3', 'lda #<',
  'sta $84\nsta $0084\nsta 132\nsta 0x84\nsta 0x0084\nsta %10000100\nsta %000010000\nsta 300\njsr $84\njsr $FF5F\njsr 0xFFD2',
  'jsr some_routine\nlda #<some_routine\nlda #>some_routine\nlda #name\nsta some_label+1\nsta some_label + 12\nlda tbl+3,x',
  'lda screen,x\nlda screen , y\nlda $20,x\nldx $20,y\nlda $2000,y\nsta (ptr),y\nsta ($fb),Y\nlda ($fb,x)\nlda ( $fb , X )\njmp ($FFFC)\njmp (vec)\nlda (ptr) , y\nlda (ptr) ,y',
  'asl a\nasl A\nasl\nlsr $10\nrol a\nror a', 'inc a', 'sta a',
  'bne loop\nbeq 5\nbcc skip',
  '1: dex\n bne 1b\n2: nop\n beq 2b\n bne 1b',
  'bne 1f\nnop\n1: rts\n bne 1b\n beq 1f\n1: nop',
  'bne 1f', 'bne 1b', '1: nop\n1: nop\n bne 1b\n bne 1f\n1: rts',
  'loop: lda #1\n  bne loop', 'a: b: c: nop', '3: 4: nop\n bne 3b\n bne 4b', 'x:', '1:', 'x : nop', 'x :\nnop',
  // comments and whitespace
  '; only a comment\n// another\n\n  \nnop ; trailing\nlda #1 // trailing', 'nop;x', 'lda #$1;x//y', '   nop   ', '\tnop\t',
  // CRLF
  'lda #1\r\nsta $400\r\nrts\r\n', 'a:\r\n nop\r\n',
  // exotic whitespace: NBSP and U+FEFF inside a line, and U+0085 (not JS whitespace)
  'nop\u00a0', '\u00a0nop', '\ufeffnop', 'lda\u00a0#1', 'lda #1\ufeff', '\u0085nop', 'nop\u0085', 'a:\u00a0nop', 'a\u00a0: nop',
  'lda\t#1\n lda\t$10 ,\tx',
  // lowercase mnemonic
  'LdA #1\nStA $10\nRtS',
  // errors
  'frob', 'nop 1', 'lda', 'lda #', 'lda #$', 'lda #1+1', 'lda #<5', 'lda #>$10', 'rts #1', 'bne', 'bne $10', 'bne x+1', 'bne (x)',
  'jsr (x)', 'lda ($zz)', 'lda (x,y)', 'lda (x),x', 'lda x y', 'lda ,x', 'lda +1', 'lda x+', 'lda x+y', 'lda 1x', 'lda 1f', 'lda $FG',
  'ldx $20,x', 'sta #1', 'jmp x,x', 'jmp ($10,x)', 'bit #1', 'cpx $10,x', 'stx $10,x', 'lda 0x', 'lda %', 'lda %2', 'lda %0x', 'lda  -1',
  // Literals of 2^63 and up are K1 (an f64 in JS, saturated in Rust); only immediates, which error, are here.
  'lda #123456789012345678901234567890', 'lda #$FFFFFFFFFFFFFFFFFFFF', 'sta 4503599627370496',
  'nop\nlda #1\nbogus here', 'lda\n', 'lda "x"', 'ünop', 'nop ünop', 'lda #é', 'lda é',
];
const ids = ['t', 'native_0_0', 'a b'];
const seen = new Set();
const cases = [];
for (const text of texts) {
  for (const id of text.includes('1') || text.includes(':') ? ids : ['t']) {
    const result = parseAsm(text, id);
    const key = JSON.stringify([text, id]);
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push({ fn: 'parseAsm', args: [text, id], result });
  }
}
// Mnemonic/mode table, in OPCODES order (modes in literal order).
const opcodes = Object.entries(OPCODES).map(([m, forms]) => [m, Object.keys(forms)]);
const out = fileURLToPath(new URL('../fixtures/parse.json', import.meta.url));
mkdirSync(fileURLToPath(new URL('../fixtures/', import.meta.url)), { recursive: true });
writeFileSync(out, JSON.stringify({ opcodes, cases }));
console.log(cases.length, 'cases', opcodes.length, 'mnemonics');
