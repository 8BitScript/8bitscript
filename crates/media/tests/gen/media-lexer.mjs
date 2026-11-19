// Regenerates fixtures/media-lexer.json. Run from the repo root:
//   node crates/media/tests/gen/media-lexer.mjs
import { tokenizeMedia } from '../../../../packages/compiler/src/media/lexer.mjs';
import { write } from './util.mjs';

const rows = [];
const add = (name, text, sourceKind = '.8bg') => {
  const result = tokenizeMedia(text, 'a' + sourceKind, { sourceKind });
  rows.push({ fn: 'tokenizeMedia', name, args: [text, 'a' + sourceKind, sourceKind], result });
};

add('empty', '');
add('whitespace only', ' \t\r\n  ');
add('identifiers', 'sprite hero_1 _x A9z');
add('numbers', '0 7 007 12345 99999999999999999999');
add('number beyond f64', '9'.repeat(400));
add('punctuation', '{}(),;=');
add('x is an identifier', '16x16 x 3 x');
add('line comment', 'a // hi there\nb');
add('line comment at eof', 'a // tail');
add('block comment', 'a /* one\ntwo */ b');
add('block comment unterminated', 'a /* never closed');
add('slash alone', 'a / b');
add('double string', 'source "hero.png"');
add('single string', "source 'hero.png'");
add('string escapes', String.raw`"a\"b\'c\\d\ne"`);
add('string with other quote', `"it's" 'say "hi"'`);
add('trailing backslash', '"abc\\');
add('unterminated at eof', 'source "hero.png');
add('unterminated at newline', 'source "hero.png\nsprite');
add('escape swallows newline', '"a\\\nb" c');
add('unexpected characters', 'a @ b # c', '.8bg');
add('unexpected characters audio', 'a @ b # c', '.8ba');
add('unterminated audio', 'song "x', '.8ba');
add('unterminated graphics', 'sprite "x', '.8bg');
add('non-ascii before spans', '// café\nsprite é "naïve" 12 {}');
add('non-ascii identifier char', 'sprite é');
add('emoji in comment and string', '/* 😀 */ "😀x" 5 {');
add('every token kind', 'sprite hero { source "h.png" size 16x16 // c\n transparent 3, /* b */ }');
add('audio source kind tokens', 'song s { tempo 120; }', '.8ba');
write('media-lexer', rows);
