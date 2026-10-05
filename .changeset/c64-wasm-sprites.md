---
"@8bitscript/c64": minor
"@8bitscript/cli": minor
---

The C64's wasm build draws sprites. `8bs build --target c64 --web` now builds `fancy`, `joystick`, `media-walk`, `swarm` and Studio (they stopped at the sprite multiplexer's machine code): the page paints the eight VIC-II hardware sprites (hires and multicolour, X/Y expansion, priority, the ninth X bit, shape blocks read from the VIC bank) and applies the address-form raster list (`@8bitscript/c64/raster`) line by line, so a sprite is reused down the frame by the multiplexer's own list entries. `raster.c64.web.8bs` keeps the native list layout byte for byte and `multiplex.c64.web.8bs` is the multiplexer's routine in plain 8BitScript; `web-vic.mjs` is the one source both the screenshot renderer and the generated browser loader run. Not modelled, and listed in the C64's `wasm.limits`: sprite collision registers, the handler's cycle timing, a register an entry changed staying changed into the next frame, and an opened border.
