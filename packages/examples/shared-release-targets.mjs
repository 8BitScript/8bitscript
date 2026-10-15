// Five machines this release builds for. Examples use PET 4032 (32K) because
// four-pillar media does not fit a stock 4K PET 2001.
//
// Plain JavaScript, not TypeScript: an installed example (and Studio) loads
// this from inside node_modules, where Node refuses to strip types.
export const releaseTargets = {
  pet: { hardware: { model: '4032', ram: '32' } },
  c64: {},
  vic20: { hardware: { ram: '8k' } },
  cx16: {},
  web: {},
};
