// Inputs for pet's lowerGraphics and lowerAudio diagnostics and branches.
export default {
  corpusFacts: [{}, { 'audio.voices': 0 }, { 'audio.voices': 1 }],
  cases({ graphics, audio, h }) {
    const white = [255, 255, 255, 255];
    const dark = [20, 20, 20, 255];
    const clear = [0, 0, 0, 0];
    const quad = (x, y) => (x < 4 && y < 4 ? dark : clear);
    const half = (x) => (x < 8 ? dark : clear);
    const slots = (petShapes) => ({ graphics: 0, audio: 0, audioBytes: 0, ...(petShapes === undefined ? {} : { petShapes }) });
    graphics('no frames', h.sprite('16x16'), 0, [], {}, slots());
    graphics('no frames, no slots', h.sprite('16x16'), 0, []);
    graphics('no frames, animation every', h.anim('16x16', '0', 3), 0, [], {}, slots(2));
    graphics('half picture', h.sprite('16x16'), 0, [h.frame(16, 16, half)], {}, slots());
    graphics('half picture, no slots', h.sprite('16x16'), 0, [h.frame(16, 16, half)]);
    graphics('half picture, spent shapes', h.sprite('16x16'), 0, [h.frame(16, 16, half)], {}, slots(3));
    graphics('opaque dark', h.sprite('16x16'), 0, [h.solid(16, 16, dark)], {}, slots());
    graphics('opaque white is paper', h.sprite('16x16'), 0, [h.solid(16, 16, white)], {}, slots());
    graphics('white on clear', h.sprite('16x16'), 0, [h.frame(16, 16, (x) => (x < 8 ? white : clear))], {}, slots());
    graphics('one quadrant', h.sprite('16x16'), 0, [h.frame(16, 16, quad)], {}, slots());
    graphics('one quadrant, no slots', h.sprite('16x16'), 0, [h.frame(16, 16, quad)]);
    graphics('one quadrant, spent shapes', h.sprite('16x16'), 0, [h.frame(16, 16, quad)], {}, slots(6));
    graphics('all transparent', h.sprite('16x16'), 0, [h.solid(16, 16, clear)], {}, slots());
    graphics('two quadrants', h.sprite('16x16'), 0, [h.frame(16, 16, (x, y) => (y < 4 && x < 8 ? dark : clear))], {}, slots());
    graphics('shapes all taken', h.sprite('16x16'), 0, [h.solid(16, 16, dark)], {}, slots(7));
    graphics('shapes over taken', h.anim('16x16', '0, 1', 5), 0, [h.solid(16, 16, dark), h.solid(16, 16, dark)], {}, slots(9));
    graphics('animation, three frames', h.anim('16x16', '0, 1, 2', 3), 0, [h.solid(16, 16, dark), h.frame(16, 16, half), h.frame(16, 16, (x, y) => (y < 8 ? dark : clear))], {}, slots());
    graphics('animation, frames dropped', h.anim('16x16', '0, 1, 2, 3', 3), 0, Array.from({ length: 4 }, () => h.solid(16, 16, dark)), {}, slots(5));
    graphics('animation, one frame dropped', h.anim('16x16', '0, 1, 2', 3), 0, Array.from({ length: 3 }, () => h.solid(16, 16, dark)), {}, slots(5));
    graphics('animation, seven frames', h.anim('16x16', '0, 1, 2, 3, 4, 5, 6', 2), 0, Array.from({ length: 7 }, () => h.solid(16, 16, dark)), {}, slots());
    graphics('animation, eight frames', h.anim('16x16', '0, 1, 2, 3, 4, 5, 6, 7', 2), 0, Array.from({ length: 8 }, () => h.solid(16, 16, dark)), {}, slots());
    graphics('animation, index past the frames', h.anim('16x16', '0, 9', 2), 0, [h.solid(16, 16, dark)], {}, slots());
    graphics('animation, mixed alpha', h.anim('16x16', '0, 1', 2), 0, [h.solid(16, 16, dark), h.frame(16, 16, half)], {}, slots());
    graphics('animation without frames', 'sprite s { source "s.png" size 16x16 animation a { every 6 } }', 0, [h.solid(16, 16, dark)], {}, slots());
    graphics('8x8 frame', h.sprite('8x8'), 0, [h.solid(8, 8, dark)], {}, slots());
    graphics('3x3 frame', h.sprite('3x3'), 0, [h.frame(3, 3, (x, y) => (x === 1 && y === 1 ? dark : clear))], {}, slots());
    graphics('2x2 frame', h.sprite('2x2'), 0, [h.solid(2, 2, dark)], {}, slots());
    graphics('shapes accumulate across sprites', `${h.sprite('16x16')}\n${h.sprite('16x16')}`, 1, [h.solid(16, 16, dark)], {}, slots(4));
    graphics('non-ascii name', 'sprite é { source "s.png" size 16x16 }', 0, [h.solid(16, 16, dark)], {}, slots());

    const inst = 'instrument lead { waveform pulse }';
    const song = 'song s { tempo 120 speed 6 order { a } pattern a length 8 { track t { row 0 { note C4 instrument lead } row 4 { note E4; length 2 } } } }';
    const noise = 'sample boom { source "boom.wav" fallback { synth noise } }';
    const pulse = 'sample beep { source "beep.wav" fallback { synth pulse } }';
    const tri = 'sample tri { source "tri.wav" fallback { synth triangle } }';
    const bare = 'sample none { source "none.wav" }';
    const on = { 'audio.voices': 1 };
    audio('empty', '', on);
    audio('empty, no voices', '');
    audio('samples, no voices', `${noise}\n${pulse}`, {});
    audio('samples, voices zero', `${noise}\n${pulse}`, { 'audio.voices': 0 });
    audio('samples, voices', `${noise}\n${pulse}\n${tri}\n${bare}`, on);
    audio('samples, voices as a string', `${noise}\n${pulse}`, { 'audio.voices': '2' });
    audio('samples, voices not a number', `${noise}`, { 'audio.voices': 'x' });
    audio('samples, voices null', `${noise}`, { 'audio.voices': null });
    audio('samples, voices true', `${noise}`, { 'audio.voices': true });
    audio('song, no voices', `${inst}\n${song}`, {});
    audio('song, voices', `${inst}\n${song}`, on);
    audio('song, many voices', `${inst}\n${song}`, { 'audio.voices': 3 });
    audio('songs and samples, no voices', `${inst}\n${song}\n${noise}`, {});
    audio('songs and samples, voices', `${inst}\n${song}\nsong t { }\n${noise}\n${pulse}`, on);
    audio('empty song, voices', 'song s { }', on);
    audio('non-ascii names', 'sample é { source "a.wav" fallback { synth noise } }\nsong ü { }', on);
  },
};
