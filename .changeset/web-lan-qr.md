---
"@8bitscript/cli": patch
"8bitscript-lang": patch
---

`8bs run web` binds an ephemeral port by default so two runs can coexist (`--port n` still pins one). The launcher shows a QR of the LAN HTTPS URL on a web run so a phone on the same Wi-Fi can open it without typing the address.
