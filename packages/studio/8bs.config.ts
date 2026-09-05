// Studio is an ordinary 8BitScript program: this is the same manifest every
// project has, and `8bs run <target>` in this directory starts it.
//
// The tier a machine gets is chosen by the entry's filename rule: a build for
// the VIC-20, the PET, or the NES starts from `src/main.<target>.8bs` beside
// this file's `src/main.8bs`; every other target starts from `main.8bs`.
// See AGENTS.md for the tiers and what each one is meant to hold.
export default {
  entry: 'src/main.8bs',
  targets: ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'],
};
