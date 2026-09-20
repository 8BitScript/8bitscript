---
"@8bitscript/cli": minor
"@8bitscript/web": minor
---

`input.keyboard()` on the web: whether the host has anything to press arrows on. The page writes a second bit into the `HOST_OFFSET` byte, `NO_KEYBOARD`, set on a touch host whose pointer cannot hover (`(hover: none)` — a phone, or a tablet in the hands) and cleared for good by the first trusted key it sees from outside a form field (an iPad on a keyboard folio gets its keyboard back at its first arrow). Zero stays a desktop with a mouse and a keyboard, so `--screenshot` PNGs keep the desktop layout. A program that names its controls reads `keyboard()` when it prints, next to `touch()`: SWIPE on a phone, SWIPE OR ARROWS on a touchscreen laptop, ARROWS on a desktop. `hostHasKeyboard()` and `hostStatusByte()` in `web-layout.mjs` are the tested rule; `Input.KEYBOARD` from `@8bitscript/system` is still the build's fact.
