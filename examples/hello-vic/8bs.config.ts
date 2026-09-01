// Project configuration for hello-vic.
//
// The shape of this file is not designed yet — the CLI that would read it does
// not exist. It is here because it is part of the project layout an 8BitScript
// program is meant to have, and because its presence keeps the example honest
// about what a real project contains.
export default {
  entry: 'src/main.8bs',
  targets: ['vic20-ntsc', 'vic20-pal', 'web'],
};
