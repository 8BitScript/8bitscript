// A bare load: the linked bytes and nothing else. Apple II, Oric and BBC
// boot from a host loader or firmware, not a Commodore BASIC stub.
import type { MachineImage } from './image.ts';

export const RAW: MachineImage = {
  prelude(loadAddress) {
    return { bytes: new Uint8Array(0), codeStart: loadAddress };
  },
  file(_loadAddress, body) {
    return body;
  },
  entryIsVectored: false,
};
