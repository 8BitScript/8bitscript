// Tap shim for media/index.mjs (see ../register.mjs). The linker imports both
// functions from here; elaborateMedia lives in elaborate.mjs and is re-exported.
import { elaborateMedia as realElaborate, parseMediaModule as realParse } from '../../../../packages/compiler/src/media/index.mjs';
import { tapped } from '../tap.mjs';

export * from '../../../../packages/compiler/src/media/index.mjs';
// `after` is the diagnostics array the call appended to.
export const parseMediaModule = tapped('parseMediaModule', realParse, { after: ([, , diagnostics]) => diagnostics });
// `after` is what the call changed: the module, the diagnostics and the shared media slots.
export const elaborateMedia = tapped('elaborateMedia', realElaborate, {
  after: ([module, diagnostics, options]) => ({ module, diagnostics, mediaSlots: options?.mediaSlots }),
});
