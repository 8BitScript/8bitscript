// Studio is an ordinary 8BitScript program: this is the same manifest every
// project has, and `8bs run <target>` in this directory starts it.
//
// One entry for every machine: `src/main.8bs` compares #system() with the
// names @8bitscript/system exports and picks the tier there. See AGENTS.md for the tiers
// and what each one is meant to hold.
export default {
  entry: 'src/main.8bs',
  targets: ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'],
};
