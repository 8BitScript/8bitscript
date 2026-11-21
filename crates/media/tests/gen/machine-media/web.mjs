// Inputs for web's lowerGraphics and lowerAudio diagnostics and branches.
// A cx16 `--web` build keeps the cx16 facts: only the module is swapped.
const WEB = { 'video.sprites': 16, 'video.spriteWidth': 64, 'video.spriteHeight': 64, 'video.spriteKib': 16 };
const CX16 = { 'video.sprites': 128, 'video.spriteWidth': 64, 'video.spriteHeight': 64, 'video.spriteKib': 32 };
const T = { graphics: 1, audio: 0, audioBytes: 0 };

export default {
  corpusGraphics: [{ label: 'web', facts: WEB, slots: T }, { label: 'cx16 --web', facts: CX16, slots: T }],
  cases({ graphics, audio, h }) {
    const ink = [30, 30, 30, 255];
    const other = [200, 10, 10, 255];
    const clear = [0, 0, 0, 0];
    const slots = (extra = {}) => ({ ...T, ...extra });
    const reds = (n) => h.frame(16, 16, (x) => [Math.min(x, n - 1) * 16, 0, 0, 255]);
    graphics('no facts', h.sprite('8x8'), 0, [h.solid(8, 8, ink)], {}, null);
    graphics('slot 16 of 16', h.sprite('8x8'), 0, [h.solid(8, 8, ink)], WEB, slots({ graphics: 17 }));
    graphics('slot 15 of 16', h.sprite('8x8'), 0, [h.solid(8, 8, ink)], WEB, slots({ graphics: 16 }));
    graphics('no frames', h.sprite('8x8'), 0, [], WEB, T);
    graphics('no frames, animation 0, 1', h.anim('8x8', '0, 1', 3), 0, [], WEB, T);
    graphics('8x8 solid', h.sprite('8x8'), 0, [h.solid(8, 8, ink)], WEB, T);
    graphics('8x8 two colours', h.sprite('8x8'), 0, [h.frame(8, 8, (x) => (x < 4 ? ink : other))], WEB, T);
    graphics('8x8 empty', h.sprite('8x8'), 0, [h.solid(8, 8, clear)], WEB, T);
    graphics('8x8 alpha 15 and 16', h.sprite('8x8'), 0, [h.frame(8, 8, (x) => [1, 2, 3, x < 4 ? 15 : 16])], WEB, T);
    graphics('3x3', h.sprite('3x3'), 0, [h.frame(3, 3, (x, y) => (x === y ? ink : clear))], WEB, T);
    graphics('12x4', h.sprite('12x4'), 0, [h.frame(12, 4, (x) => (x < 6 ? ink : other))], WEB, T);
    graphics('64x64', h.sprite('64x64'), 0, [h.frame(64, 64, (x) => (x < 32 ? ink : clear))], WEB, T);
    graphics('65x8', h.sprite('65x8'), 0, [h.frame(65, 8, (x) => (x < 32 ? ink : other))], WEB, T);
    graphics('15 colours', h.sprite('16x16'), 0, [reds(15)], WEB, T);
    graphics('16 colours', h.sprite('16x16'), 0, [reds(16)], WEB, T);
    graphics('animation, two steps', h.anim('8x8', '0, 1', 3), 0, [h.solid(8, 8, ink), h.frame(8, 8, (x) => (x < 4 ? ink : clear))], WEB, T);
    graphics('animation, index past the frames', h.anim('8x8', '0, 4', 2), 0, [h.solid(8, 8, ink)], WEB, T);
    graphics('animation without frames', 'sprite s { source "s.png" size 8x8 animation a { every 6 } }', 0, [h.solid(8, 8, ink)], WEB, T);
    graphics('three 64x64 frames', h.anim('64x64', '0, 1, 2', 2), 0, Array.from({ length: 3 }, () => h.solid(64, 64, ink)), WEB, T);
    graphics('two 16x16 frames, small window', h.anim('16x16', '0, 1', 2), 0, [h.solid(16, 16, ink), h.solid(16, 16, other)], { ...WEB, 'video.spriteWidth': 8, 'video.spriteHeight': 8 }, T);
    graphics('two 16x16 frames, pool short', h.anim('16x16', '0, 1', 2), 0, [h.solid(16, 16, ink), h.solid(16, 16, other)], WEB, slots({ webSpriteBytes: 16184 }));
    graphics('one 16x16 frame, pool full', h.sprite('16x16'), 0, [h.solid(16, 16, ink)], WEB, slots({ webSpriteBytes: 16384 }));
    graphics('one 8x8 frame, pool overrun', h.sprite('8x8'), 0, [h.solid(8, 8, ink)], WEB, slots({ webSpriteBytes: 20000 }));
    graphics('one 8x8 frame, offset 300', h.sprite('8x8'), 0, [h.solid(8, 8, ink)], WEB, slots({ webSpriteBytes: 300 }));
    graphics('one 8x8 frame, no pool', h.sprite('8x8'), 0, [h.solid(8, 8, ink)], { ...WEB, 'video.spriteKib': 0 }, T);
    graphics('second sprite', `${h.sprite('8x8')}\n${h.anim('8x8', '0', 9)}`, 1, [h.solid(8, 8, ink)], WEB, slots({ graphics: 2 }));
    graphics('non-ascii name', 'sprite é { source "s.png" size 8x8 }', 0, [h.solid(8, 8, ink)], WEB, T);
    graphics('cx16 facts, pool short', h.anim('16x16', '0, 1', 2), 0, [h.solid(16, 16, ink), h.solid(16, 16, other)], CX16, slots({ webSpriteBytes: 32568 }));

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
