// Inputs for web's lowerGraphics and lowerAudio diagnostics and branches.
export default {
  cases({ graphics, audio, h }) {
    const ink = [30, 30, 30, 255];
    const other = [200, 10, 10, 255];
    const clear = [0, 0, 0, 0];
    graphics('no frames', h.sprite('8x8'), 0, []);
    graphics('no frames, animation every', h.anim('8x8', '0', 3), 0, []);
    graphics('8x8 one ink', h.sprite('8x8'), 0, [h.frame(8, 8, (x, y) => ((x + y) % 2 ? clear : ink))]);
    graphics('8x8 solid', h.sprite('8x8'), 0, [h.solid(8, 8, ink)]);
    graphics('8x8 two colours', h.sprite('8x8'), 0, [h.frame(8, 8, (x) => (x < 4 ? ink : other))]);
    graphics('8x8 empty', h.sprite('8x8'), 0, [h.solid(8, 8, clear)]);
    graphics('8x8 alpha 15 and 16', h.sprite('8x8'), 0, [h.frame(8, 8, (x) => [1, 2, 3, x < 4 ? 15 : 16])]);
    graphics('16x16 reduced', h.sprite('16x16'), 0, [h.frame(16, 16, (x, y) => (x < 8 ? ink : clear))]);
    graphics('16x16 one pixel', h.sprite('16x16'), 0, [h.frame(16, 16, (x, y) => (x === 3 && y === 5 ? ink : clear))]);
    graphics('16x16 thin line', h.sprite('16x16'), 0, [h.frame(16, 16, (x, y) => (y === 7 && x % 2 === 0 ? ink : clear))]);
    graphics('16x16 half covered boxes', h.sprite('16x16'), 0, [h.frame(16, 16, (x, y) => (x % 2 === 0 ? ink : clear))]);
    graphics('3x3 enlarged', h.sprite('3x3'), 0, [h.frame(3, 3, (x, y) => (x === y ? ink : clear))]);
    graphics('12x4 frame', h.sprite('12x4'), 0, [h.frame(12, 4, (x) => (x < 6 ? ink : other))]);
    graphics('64x64 reduced', h.sprite('64x64'), 0, [h.frame(64, 64, (x, y) => (x < 32 ? ink : clear))]);
    graphics('animation, two steps', h.anim('8x8', '0, 1', 3), 0, [h.solid(8, 8, ink), h.frame(8, 8, (x) => (x < 4 ? ink : clear))]);
    graphics('animation, steps with sizes', h.anim('16x16', '0, 1', 3), 0, [h.solid(16, 16, ink), h.solid(16, 16, other)]);
    graphics('animation, eight steps', h.anim('8x8', '0, 1, 2, 3, 4, 5, 6, 7', 1), 0, Array.from({ length: 8 }, () => h.solid(8, 8, ink)));
    graphics('animation, nine steps', h.anim('8x8', '0, 1, 2, 3, 4, 5, 6, 7, 8', 1), 0, Array.from({ length: 9 }, () => h.solid(8, 8, ink)));
    graphics('animation, index past the frames', h.anim('8x8', '0, 4', 2), 0, [h.solid(8, 8, ink)]);
    graphics('animation without frames', 'sprite s { source "s.png" size 8x8 animation a { every 6 } }', 0, [h.solid(8, 8, ink)]);
    graphics('animation, all notes', h.anim('16x16', '0, 1, 2, 3, 4, 5, 6, 7, 8', 2), 0, Array.from({ length: 9 }, (_, i) => h.frame(16, 16, (x) => (x < 8 + i ? other : ink))));
    graphics('second sprite', `${h.sprite('8x8')}\n${h.anim('8x8', '0', 9)}`, 1, [h.solid(8, 8, ink)]);
    graphics('non-ascii name', 'sprite é { source "s.png" size 8x8 }', 0, [h.solid(8, 8, ink)]);

    const inst = 'instrument lead { waveform pulse }\ninstrument hiss { waveform noise }';
    const pat = (i) => `pattern a length 8 { track t { row 0 { note C4 instrument ${i} } row 4 { note E4 } } }`;
    audio('empty', '');
    audio('sample fallback noise', 'sample boom { source "boom.wav" fallback { synth noise } }');
    audio('sample fallback each', ['pulse', 'noise', 'triangle', 'saw'].map((w) => `sample ${w[0]}${w} { source "a.wav" fallback { synth ${w} } }`).join('\n'));
    audio('sample no fallback', 'sample none { source "none.wav" }');
    audio('song pulse', `${inst}\nsong s { tempo 120 speed 6 order { a } ${pat('lead')} }`);
    audio('song noise', `${inst}\nsong s { tempo 120 speed 6 order { a } ${pat('hiss')} }`);
    audio('two songs, one noise', `${inst}\nsong s { order { a } ${pat('lead')} }\nsong t { order { a } ${pat('hiss')} }`);
    audio('song without notes', 'song s { }');
    audio('songs and samples', `${inst}\nsample b { source "b.wav" fallback { synth saw } }\nsong s { order { a } ${pat('hiss')} }`);
    audio('non-ascii names', 'sample é { source "a.wav" fallback { synth noise } }\nsong ü { }');
  },
};
