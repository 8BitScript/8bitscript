// The Commodore .prg file format: a two-byte little-endian load address
// followed by the bytes that land there. Nothing else — VICE and real
// hardware both just DMA the rest of the file to that address and, on
// autostart, jump into BASIC to run whatever's there.

/** `loadAddress`, little-endian, followed by `body`. */
export function prgBytes(loadAddress: number, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(2 + body.length);
  bytes[0] = loadAddress & 0xff;
  bytes[1] = (loadAddress >> 8) & 0xff;
  bytes.set(body, 2);
  return bytes;
}
