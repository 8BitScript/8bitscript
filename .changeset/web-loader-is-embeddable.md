---
"@8bitscript/cli": minor
---

A web build is now something you can put in someone else's page, and it stops spending a fifth of a phone's screen on a border.

`8bs build --target web` writes `8bitscript.js` — a loader with `mount()` and an `<eightbit-screen>` custom element — next to `program.wasm`, so embedding a program is two lines:

```html
<script src="8bitscript.js"></script>
<eightbit-screen src="program.wasm"></eightbit-screen>
```

`index.html` is now a forty-line shell that calls that same loader, so the page we ship takes the path an embedder takes and cannot quietly drift away from it. The bundle also gains `embed.html` (the worked example of a screen inside an article), `worker.js` as a real file for pages whose CSP forbids `blob:` workers, and `coi.js`.

**The border is measured, not assumed.** It was 24 px on every side always — 48 of every 368 horizontal pixels and a fifth of the height, which is a fine frame on a desktop and plainly wrong on a phone, where the picture renders at barely 1–2×. `borderFor()` now reads the box the picture is going into and returns 24 px at 3× and up with a mouse, an 8 px hairline between 2× and 3× or on any touch screen, and nothing at all below 2×. Measured in Chromium: a 1920×1080 desktop keeps its 24; an iPhone gets 0 in **both** orientations (portrait 393×852 and landscape 852×393); a 42rem article column gets the hairline. It reads the *container*, so a narrow column is treated like the small screen it is. `border="24"` pins it, and the headless `--screenshot` still always renders 24 — there is no viewport there to measure.

**Cross-origin isolation is now explained rather than assumed.** The gate turns out to be on *sharing* memory, not on having it: without COOP/COEP, `new WebAssembly.Memory({shared: true})` succeeds and a shared-memory module instantiates fine, but `postMessage` of the buffer throws `DataCloneError: SharedArrayBuffer transfer requires self.crossOriginIsolated`. So the loader detects it and says which two headers are missing instead of failing blankly, `docs/web-embedding.md` gives the Cloudflare/Netlify/nginx/Apache/Vercel/Express forms, and `coi.js` installs a service worker that supplies them on a host that cannot — verified end to end against a static server sending none. It is opt-in, because `require-corp` then applies to the embedder's whole page.

Embedded, a screen stays a guest: it sizes from a `ResizeObserver` on its container rather than the viewport, takes the arrow keys only while focused so the page still scrolls, goes fullscreen into its own element, and never posts to `/status`. The loader carries the worker inside itself and starts it from a `blob:` URL, so serving `8bitscript.js` from a different origin than the page works.
