// Project configuration. `8bs build` and `8bs run` read this file from the
// directory they are run in.
//
//   entry    the file the program starts from. `8bs build` links this file
//            and everything it imports into one program.
//   targets  the machines this project is allowed to build for. Asking for a
//            machine not listed here is an error, so a typo in a script can't
//            quietly build the wrong thing.
//
// NTSC vs PAL is not a target — it is a `--pal` flag on `8bs build`/`8bs run`.
export default {
  entry: 'src/main.8bs',
  targets: ['vic20', 'c64'],
};
