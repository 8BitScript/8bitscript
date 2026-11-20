// Inputs for atari8's lowerGraphics diagnostics and branches.
export default {
  pcm: false,
  cases({ graphics, audio, h }) {
    const dark = [10, 10, 10, 255];
    const light = [250, 250, 250, 255];
    const clear = [0, 0, 0, 0];
    graphics('no frames', h.sprite('8x8'), 0, []);
    graphics('dark opaque', h.sprite('8x8'), 0, [h.solid(8, 8, dark)]);
    graphics('light opaque', h.sprite('8x8'), 0, [h.solid(8, 8, light)]);
    graphics('fully transparent', h.sprite('8x8'), 0, [h.solid(8, 8, clear)]);
    graphics('ink exactly at the limit', h.sprite('8x8'), 0, [h.frame(8, 8, (x, y) => (y * 8 + x < 29 ? dark : light))]);
    graphics('just over the limit', h.sprite('8x8'), 0, [h.frame(8, 8, (x, y) => (y * 8 + x < 30 ? dark : light))]);
    graphics('threshold 499 vs 500', h.sprite('8x8'), 0, [h.frame(8, 8, (x) => (x < 4 ? [166, 166, 167, 255] : [166, 166, 168, 255]))]);
    graphics('alpha 15 and 16', h.sprite('8x8'), 0, [h.frame(8, 8, (x) => [0, 0, 0, x < 4 ? 15 : 16])]);
    graphics('animation, frames collapsed', h.anim('8x8', '0, 1, 2', 3), 0, [h.solid(8, 8, dark), h.solid(8, 8, light), h.solid(8, 8, dark)]);
    graphics('animation, one frame', h.anim('8x8', '0', 5), 0, [h.solid(8, 8, dark)]);
    graphics('animation without frames', 'sprite s { source "s.png" size 8x8 animation a { every 6 } }', 0, [h.solid(8, 8, light)]);
    graphics('second sprite', `${h.sprite('8x8')}\n${h.anim('8x8', '0, 1', 2)}`, 1, [h.solid(8, 8, dark)]);
    graphics('non-ascii name', 'sprite é { source "s.png" size 8x8 }', 0, [h.solid(8, 8, dark)]);

    const inst = 'instrument lead { waveform pulse }\ninstrument hiss { waveform noise }\ninstrument tri { waveform triangle }\ninstrument saw { waveform saw }';
    const pat = (name, i, len = 8) => `pattern ${name} length ${len} { track t { row 0 { note C4 instrument ${i} } row 4 { note E4 } } }`;
    const song = (name, body) => `song ${name} { tempo 120 speed 6 ${body} }`;
    audio('empty', '');
    audio('samples, each fallback', ['pulse', 'noise', 'triangle', 'saw'].map((w) => `sample ${w[0]}${w} { source "a.wav" fallback { synth ${w} } }`).join('\n'));
    audio('sample, no fallback', 'sample none { source "none.wav" }');
    audio('song, one pattern, no order', `${inst}\n${song('s', pat('a', 'lead'))}`);
    audio('song, order', `${inst}\n${song('s', `order { a } ${pat('a', 'lead')}`)}`);
    audio('song, order repeats and skips', `${inst}\n${song('s', `order { b a z a } ${pat('a', 'lead')} ${pat('b', 'hiss', 4)}`)}`);
    audio('song, no order, two patterns', `${inst}\n${song('s', `${pat('a', 'hiss')} ${pat('b', 'lead', 4)}`)}`);
    audio('song, pattern names repeat', `${inst}\n${song('s', `${pat('a', 'hiss')} ${pat('a', 'lead', 4)}`)}`);
    audio('song, no patterns', 'song s { tempo 90 speed 3 }');
    audio('song, empty order', `${inst}\n${song('s', `order { } ${pat('a', 'lead')}`)}`);
    audio('song, waveforms', `${inst}\n${song('s', 'pattern a length 16 { track t { row 0 { note C4 instrument tri } row 2 { note D4 } row 4 { note E4 instrument saw } row 6 { note F4 instrument lead } row 8 { note G4 instrument hiss } } }')}`);
    audio('song, rows without a note', `${inst}\n${song('s', 'pattern a length 4 { track t { row 0 { instrument saw } row 1 { note C4 } row 2 { } } }')}`);
    audio('song, unknown instrument keeps the last', `${inst}\n${song('s', 'pattern a length 4 { track t { row 0 { note C4 instrument hiss } row 1 { note D4 instrument ghost } } }')}`);
    audio('song, no instrument', song('s', 'pattern a length 4 { track t { row 0 { note C4 } } }'));
    audio('song, two tracks', `${inst}\n${song('s', 'pattern a length 4 { track x { row 0 { note C4 instrument tri } } track y { row 1 { note D4 } } }')}`);
    audio('song, large rows and tempo', `${inst}\n${song('s', 'pattern a length 300 { track t { row 256 { note C4 } row 299 { note B8 } } }').replace('tempo 120 speed 6', 'tempo 300 speed 999')}`);
    audio('two songs', `${inst}\n${song('s', pat('a', 'saw'))}\n${song('t', pat('b', 'lead'))}`);
    audio('songs and samples', `${inst}\nsample b { source "b.wav" fallback { synth saw } }\n${song('s', pat('a', 'hiss'))}`);
    audio('non-ascii names', 'sample é { source "a.wav" fallback { synth noise } }\nsong ü { }');
  },
};
