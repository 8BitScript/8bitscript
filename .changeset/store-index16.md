---
"@8bitscript/compiler": minor
---

The native backend writes a 2-byte array element: `hitAt[i] = cell` on an `array<usmallint, N>` lowers as the mirror of its read — the value into a 16-bit temp, Y = index × 2, low byte, INY, high byte. The store the menu bar's hit-testing needed, which had kept Studio and every `@8bitscript/ui/menubar` program off the native backend since it landed.
