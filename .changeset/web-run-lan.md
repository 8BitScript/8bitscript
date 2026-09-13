---
"@8bitscript/cli": patch
"8bitscript-lang": patch
---

`8bs run web` serves on port 8008 (HTTPS 8009) and on the LAN by default so a phone on the same Wi-Fi can reopen the same URL (`--local` is loopback only, `--port` picks another). The editor setting `8bitscript.webLan` turns LAN off.
