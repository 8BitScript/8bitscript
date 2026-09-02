export default {
  // vic20 and c64 share main.8bs: main.8bs imports its colour registers from
  // @8bitscript/machine, whose target-conditional entry resolves to
  // @8bitscript/vic20 or @8bitscript/c64 for the machine being built. web
  // gets its own entry file, main.web.8bs, because the difference there
  // isn't which register applyColors() writes to — it's that a browser tab
  // calls the program once per frame instead of handing it the machine
  // forever, and no target-conditional import can paper over a different
  // program shape. See main.web.8bs's header for what that means in
  // practice. NTSC vs PAL is a --pal flag on `8bs build`/`8bs run` for vic20
  // and c64 (both regions build identically today); it is ignored for web,
  // which has no fixed refresh rate to pick between in the first place.
  entry: { default: 'src/main.8bs', web: 'src/main.web.8bs' },
  targets: ['vic20', 'c64', 'web'],
};
