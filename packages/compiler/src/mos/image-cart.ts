// A 6502 cartridge ROM: no BASIC stub, reset vector at the top of the image.
// Used by the 2600, 7800, 5200, Lynx, PC Engine and Supervision.
import type { MachineImage } from './image.ts';

function write16(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

export function cartImage(romSize: number): MachineImage {
  return {
    prelude(loadAddress) {
      return { bytes: new Uint8Array(0), codeStart: loadAddress };
    },
    file(loadAddress, body, codeStart) {
      const size = romSize > 0 ? romSize : 4096;
      const out = new Uint8Array(size);
      out.fill(0xff);
      const copy = Math.min(body.length, size - 7);
      out.set(body.subarray(0, copy), 0);
      const rti = size - 7;
      out[rti] = 0x40; // RTI
      write16(out, size - 6, loadAddress + rti); // NMI
      write16(out, size - 4, codeStart); // RESET
      write16(out, size - 2, loadAddress + rti); // IRQ
      return out;
    },
    entryIsVectored: true,
    writableImage: false,
    endsByHalting: true,
  };
}

export const CART_4K = cartImage(4096);
export const CART_32K = cartImage(32768);
