// Studio is an ordinary 8BitScript program: this is the same manifest every
// project has, and `8bs run <target>` in this directory starts it.
//
// One entry for every machine: `src/main.8bs` reads the build's facts from
// @8bitscript/system and picks the tier there — never from the machine's
// name, so a VIC-20 with a RAM expansion gets a different answer from a
// stock one. See AGENTS.md for the tiers and what each one is meant to
// hold; `8bs run vic20 --profile 8k` is the expanded machine.
export default {
  entry: 'src/main.8bs',
  targets: ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'],
};
