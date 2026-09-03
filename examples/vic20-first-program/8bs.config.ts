export default {
  entry: 'src/main.8bs',
  // Screen memory's default address is a fact about the unexpanded VIC-20,
  // not about C64 or the web, so this targets VIC-20 only.
  targets: ['vic20'],
};
