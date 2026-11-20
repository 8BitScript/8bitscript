// Regenerates fixtures/media-audio.json. Run from the repo root:
//   node crates/media/tests/gen/media-audio.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { tokenizeMedia } from '../../../../packages/compiler/src/media/lexer.mjs';
import { parseAudio } from '../../../../packages/compiler/src/media/audio/parse.mjs';
import { checkAudio, songRows } from '../../../../packages/compiler/src/media/audio/check.mjs';
import { songEvents, encodeSong } from '../../../../packages/compiler/src/media/audio/song.mjs';
import { write } from './util.mjs';

const rows = [];
const add = (name, text, file = 'a.8ba') => {
  const { tokens } = tokenizeMedia(text, file, { sourceKind: '.8ba' });
  const { air, diagnostics } = parseAudio(tokens, text, file);
  const checked = checkAudio(air, file);
  rows.push({ fn: 'parseAudio', name, args: [text, file], result: { air, diagnostics, checked } });
  // Every song of the file also goes through songRows, songEvents and encodeSong.
  air.songs.forEach((song, i) => {
    rows.push({ fn: 'songRows', name: `${name} / song ${i}`, args: [text, file, i], result: songRows(song) });
    rows.push({ fn: 'songEvents', name: `${name} / song ${i}`, args: [text, file, i], result: songEvents(air, song) });
    rows.push({ fn: 'encodeSong', name: `${name} / song ${i}`, args: [text, file, i], result: encodeSong(air, song) });
  });
};

const inst = 'instrument lead { waveform pulse }';
const song = (body) => `${inst}\nsong s { ${body} }`;
const pat = 'pattern a length 4 { track t { row 0 { note C4 instrument lead } row 2 { note E4; length 2 } } }';

add('empty file', '');
add('comments only', '// nothing\n/* here */');

// Instruments.
add('instrument minimal', 'instrument a { }');
for (const w of ['pulse', 'triangle', 'saw', 'noise']) add(`waveform ${w}`, `instrument a { waveform ${w} }`);
add('waveform unknown', 'instrument a { waveform sine }');
add('waveform missing', 'instrument a { waveform }');
add('waveform number', 'instrument a { waveform 5 }');
add('polyphony 1', 'instrument a { polyphony 1 }');
add('polyphony 2', 'instrument a { polyphony 2 }');
add('polyphony missing', 'instrument a { polyphony }');
add('polyphony fractional', 'instrument a { polyphony 1.5 }');
add('volume and decay', 'instrument a { volume 8; decay 20; }');
add('volume without semicolon', 'instrument a { volume 8 decay 20 }');
add('volume out of range', 'instrument a { volume 16 }');
add('volume missing value', 'instrument a { volume }');
add('decay out of range', 'instrument a { decay 256 }');
add('decay missing value', 'instrument a { decay ; }');
add('instrument unknown field', 'instrument a { wobble 3 }');
add('instrument field not identifier', 'instrument a { 3 waveform pulse }');
add('instrument no name', 'instrument { waveform pulse }');
add('instrument no block', 'instrument a');
add('instrument unclosed', 'instrument a { waveform pulse');
add('instrument duplicate', 'instrument a { }\ninstrument a { }');
add('instrument all fields', 'instrument lead { waveform saw polyphony 1 volume 12; decay 4; }');

// Samples.
add('sample clean', 'sample boom { source "boom.wav" fallback { synth noise } }');
add('sample flac', 'sample boom { source "boom.flac" fallback { synth triangle } }');
add('sample missing source', 'sample boom { fallback { synth noise } }');
add('sample empty source', 'sample boom { source "" fallback { synth noise } }');
add('sample source not string', 'sample boom { source 5 fallback { synth noise } }');
add('sample missing fallback', 'sample boom { source "boom.wav" }');
add('sample empty fallback', 'sample boom { source "boom.wav" fallback { } }');
add('sample fallback default synth', 'sample boom { source "b.wav" fallback { } }');
add('sample fallback bad synth', 'sample boom { source "b.wav" fallback { synth sine } }');
add('sample fallback junk', 'sample boom { source "b.wav" fallback { wobble } }');
add('sample fallback unclosed', 'sample boom { source "b.wav" fallback { synth noise');
add('sample fallback no brace', 'sample boom { source "b.wav" fallback synth noise }');
add('sample fallback missing synth waveform', 'sample boom { source "b.wav" fallback { synth } }');
add('sample unknown field', 'sample boom { loud true }');
add('sample field not identifier', 'sample boom { "x" }');
add('sample no name', 'sample { }');
add('sample duplicate of instrument', `${inst}\nsample lead { source "a.wav" fallback { synth pulse } }`);
add('sample duplicate sample', 'sample a { }\nsample a { }');

// Songs.
add('song minimal', 'song s { }');
add('song defaults', song(''));
add('song tempo speed', song('tempo 90 speed 4'));
add('song tempo zero', song('tempo 0 speed 0'));
add('song tempo missing', song('tempo speed 3'));
add('song loop true', song('loop true'));
add('song loop false', song('loop false;'));
add('song loop bad word', song('loop maybe'));
add('song loop missing', song('loop }'));
add('song order', song(`order { a, b } ${pat} pattern b length 2 { }`));
add('song order trailing comma', song(`order { a, } ${pat}`));
add('song order empty', song(`order { } ${pat}`));
add('song order repeats', song(`order { a a a } ${pat}`));
add('song order unknown pattern', song(`order { a z } ${pat}`));
add('song order unclosed', song('order { a, b'));
add('song order no brace', song('order a'));
add('song order comma first', song('order { , a }'));
add('song pattern', song(pat));
add('song pattern default length', song('pattern a { }'));
add('song pattern length missing', song('pattern a length { }'));
add('song pattern no name', song('pattern { }'));
add('song patterns same name', song('pattern a length 2 { } pattern a length 8 { }'));
add('song unknown field', song('swing 3'));
add('song field not identifier', song('7'));
add('song duplicate', 'song s { }\nsong s { }');
add('song no name', 'song { tempo 100 }');
add('song unclosed', 'song s { tempo 100');
add('song too many rows', song('order { a b } pattern a length 200 { } pattern b length 100 { }'));
add('song exactly 255 rows', song('pattern a length 255 { }'));
add('song fractional pattern length', song('pattern a length 1.5 { track t { row 0 { note C4 } } }'));

// Tracks and rows.
add('track two rows', song(pat));
add('track unknown field', song('pattern a { track t { beat 1 } }'));
add('track no name', song('pattern a { track { row 0 { note C4 } } }'));
add('track field not identifier', song('pattern a { track t { 3 } }'));
add('row note', song('pattern a { track t { row 0 { note C4 } } }'));
add('row every note low', song('pattern a { track t { row 0 { note C0 } row 1 { note CS0 } row 2 { note B6 } } }'));
add('row note lower case', song('pattern a { track t { row 0 { note c4 } row 1 { note cs4 } } }'));
add('row note unknown', song('pattern a { track t { row 0 { note H4 } } }'));
add('row note out of octave', song('pattern a { track t { row 0 { note C7 } } }'));
add('row note missing', song('pattern a { track t { row 0 { note } } }'));
add('row note semicolon', song('pattern a { track t { row 0 { note C4; } } }'));
add('row instrument', song('pattern a { track t { row 0 { note C4 instrument lead; } } }'));
add('row instrument unknown', song('pattern a { track t { row 0 { note C4 instrument nope } } }'));
add('row instrument missing name', song('pattern a { track t { row 0 { note C4 instrument } } }'));
add('row length', song('pattern a { track t { row 0 { note C4 length 3 } } }'));
add('row length zero', song('pattern a { track t { row 0 { note C4 length 0 } } }'));
add('row length too long', song('pattern a { track t { row 0 { note C4 length 256 } } }'));
add('row length missing', song('pattern a { track t { row 0 { note C4 length } } }'));
add('row volume', song('pattern a { track t { row 0 { note C4 volume 9; } } }'));
add('row volume too loud', song('pattern a { track t { row 0 { note C4 volume 16 } } }'));
add('row volume missing', song('pattern a { track t { row 0 { note C4 volume } } }'));
add('row without note', song('pattern a { track t { row 0 { instrument lead } } }'));
add('row empty', song('pattern a { track t { row 0 { } } }'));
add('row no number', song('pattern a { track t { row { note C4 } } }'));
add('row no block', song('pattern a { track t { row 0 } }'));
add('row unknown field', song('pattern a { track t { row 0 { pan 3 } } }'));
add('row field not identifier', song('pattern a { track t { row 0 { 3 } } }'));
add('row outside pattern', song('pattern a length 2 { track t { row 5 { note C4 } } }'));
add('row at pattern length', song('pattern a length 2 { track t { row 2 { note C4 } } }'));
add('row two tracks same row', song('pattern a { track x { row 1 { note C4 } } track y { row 1 { note D4 } } }'));
add('row same track same row', song('pattern a { track x { row 1 { note C4 } row 1 { note D4 } } }'));
add('row two tracks same row three', song('pattern a { track x { row 1 { note C4 } } track y { row 1 { note D4 } } track x { row 1 { note E4 } } }'));
add('rows out of order', song('pattern a length 8 { track t { row 5 { note E4 } row 1 { note C4 } row 3 { note D4 } } }'));
add('instrument carries between rows', 'instrument a { waveform saw volume 7; decay 3; }\ninstrument b { waveform noise }\nsong s { pattern p length 8 { track t { row 0 { note C4 instrument a } row 1 { note D4 } row 2 { note E4 instrument b } row 3 { note F4 volume 2 length 2 } row 4 { note G4 instrument zz } } } }');
add('two patterns offset', song('order { a b } pattern a length 4 { track t { row 1 { note C4 } } } pattern b length 4 { track t { row 1 { note E4 } row 3 { note G4 } } }'));
add('order skips unknown pattern', song('order { a x b } pattern a length 4 { track t { row 1 { note C4 } } } pattern b length 4 { track t { row 1 { note E4 } } }'));
add('no order uses first pattern', song('pattern a length 4 { track t { row 1 { note C4 } } } pattern b length 4 { track t { row 1 { note E4 } } }'));
add('event past row 254', song('order { a b } pattern a length 250 { track t { row 249 { note C4 } } } pattern b length 20 { track t { row 4 { note D4 } row 5 { note E4 } } }'));
add('event clash across tracks', song('pattern a { track x { row 1 { note C4 } } track y { row 1 { note D4 } } }'));
add('song loop false encode', song(`loop false ${pat}`));
add('song speed over 255', song(`speed 300 ${pat}`));
add('song volume masking', 'instrument a { volume 20; decay 300; }\nsong s { pattern p length 4 { track t { row 0 { note C4 instrument a volume 17 length 260 } } } }');
add('song duplicate instruments', 'instrument a { waveform noise }\ninstrument a { waveform saw }\nsong s { pattern p length 4 { track t { row 0 { note C4 instrument a } } } }');

// Top level.
add('stray token', 'wobble');
add('stray number', '5');
add('stray number after song', 'song s { } 5');
add('target block', 'target c64 { }\ninstrument a { }');
add('target then song', 'target c64 { song x { } }\nsong y { }');
add('unknown declaration skips to next', 'wobble 1 2 3 instrument a { }');
add('unknown declaration skips to song', 'wobble { } song s { }');
add('unterminated string', 'sample a { source "x.wav');
add('unexpected character', 'instrument a { waveform pulse } #');
add('non-ascii', '// é😀\ninstrument lead { waveform pulse } /* é */ @');
add('crlf', 'instrument a {\r\n waveform saw\r\n}\r\n');

// The corpus.
const files = readdirSync('packages', { recursive: true })
  .filter((f) => f.endsWith('.8ba') && !f.includes('node_modules'))
  .map((f) => `packages/${f}`)
  .sort();
for (const f of files) add(`corpus ${f}`, readFileSync(f, 'utf8'), f.split('/').pop());

write('media-audio', rows);
