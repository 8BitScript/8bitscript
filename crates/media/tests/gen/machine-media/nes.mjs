// Inputs for nes's lowerGraphics diagnostics and branches.
export default {
  pcm: true,
  cases({ graphics, audio, h }) {
    const red = [255, 0, 0, 255];
    const green = [0, 255, 0, 255];
    const blue = [0, 0, 255, 255];
    const white = [255, 255, 255, 255];
    const clear = [0, 0, 0, 0];
    const four = (x, y) => [red, green, blue, white][(x + 2 * y) % 4];
    graphics('no frames', h.sprite('8x8'), 0, []);
    graphics('one colour', h.sprite('8x8'), 0, [h.solid(8, 8, red)]);
    graphics('three colours', h.sprite('8x8'), 0, [h.frame(8, 8, (x) => [red, green, blue][x % 3])]);
    graphics('four colours quantized', h.sprite('8x8'), 0, [h.frame(8, 8, four)]);
    graphics('transparent holes', h.sprite('8x8'), 0, [h.frame(8, 8, (x, y) => ((x + y) % 2 ? clear : red))]);
    graphics('all transparent', h.sprite('8x8'), 0, [h.solid(8, 8, clear)]);
    graphics('16x16 tiles', h.sprite('16x16'), 0, [h.frame(16, 16, four)]);
    graphics('8x16 sprite', h.sprite('8x16'), 0, [h.frame(8, 16, (x, y) => (y < 8 ? red : green))]);
    graphics('16x8 sprite', h.sprite('16x8'), 0, [h.frame(16, 8, (x) => (x < 8 ? red : blue))]);
    graphics('tall sprite, short frame', h.sprite('16x16'), 0, [h.frame(8, 8, (x) => [red, green][x % 2])]);
    graphics('narrow frame', h.sprite('16x16'), 0, [h.frame(12, 16, (x, y) => [red, green, blue][(x + y) % 3])]);
    graphics('animation, three frames', h.anim('8x8', '0, 1, 2', 3), 0, [h.solid(8, 8, red), h.solid(8, 8, green), h.solid(8, 8, blue)]);
    graphics('animation, 16x16 frames', h.anim('16x16', '0, 1', 6), 0, [h.frame(16, 16, four), h.solid(16, 16, blue)]);
    graphics('animation index past the frames', h.anim('8x8', '0, 5', 2), 0, [h.solid(8, 8, red), h.solid(8, 8, green)]);
    graphics('animation, no frames decoded', h.anim('8x8', '0, 1', 2), 0, []);
    graphics('animation without frames', 'sprite s { source "s.png" size 8x8 animation a { every 6 } }', 0, [h.solid(8, 8, green)]);
    graphics('animation repeats a frame', h.anim('8x8', '1, 1, 0', 2), 0, [h.solid(8, 8, red), h.frame(8, 8, four)]);
    graphics('nine frames', h.anim('16x16', '0, 1, 2, 3, 4, 5, 6, 7, 8', 1), 0, Array.from({ length: 9 }, (_, i) => h.frame(16, 16, (x, y) => [red, green, blue][(x + y + i) % 3])));
    graphics('second sprite', `${h.sprite('8x8')}\n${h.anim('16x16', '0', 9)}`, 1, [h.solid(16, 16, white)]);
    graphics('non-ascii name', 'sprite é { source "s.png" size 8x8 }', 0, [h.frame(8, 8, four)]);

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

    const dpcm = (n, rate = 15) => ({ dpcm: { bytes: Array.from({ length: n }, (_, i) => (i * 37) & 255), rate, length: n } });
    const two = 'sample a { source "a.wav" fallback { synth noise } }\nsample b { source "b.wav" fallback { synth triangle } }';
    audio('dpcm for both samples', two, {}, { pcm: { a: dpcm(16), b: dpcm(32) } });
    audio('dpcm for one sample', two, {}, { pcm: { b: dpcm(16) } });
    audio('dpcm null', two, {}, { pcm: { a: { dpcm: null }, b: dpcm(16) } });
    audio('dpcm long', 'sample a { source "a.wav" fallback { synth noise } }', {}, { pcm: { a: dpcm(300) } });
    audio('dpcm, unrelated name', two, {}, { pcm: { other: dpcm(16) } });
    audio('dpcm, duplicate sample names', 'sample a { source "a.wav" fallback { synth noise } }\nsample a { source "a.wav" fallback { synth pulse } }', {}, { pcm: { a: dpcm(16) } });
  },
};
