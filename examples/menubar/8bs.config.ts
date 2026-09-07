// One main.8bs for every target: the menu bar is drawn through
// @8bitscript/ui/menubar, which draws through @8bitscript/text, so nothing
// here knows which machine it is on. See README.md for what each machine
// makes of the same bar — a VIC-20's 22 columns cannot hold all four items.
export default {
  entry: 'src/main.8bs',
  targets: ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'],
};
