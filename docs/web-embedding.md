---
title: Putting a program in a web page
nav_order: 20
---

# Putting a program in a web page

`8bs build --target web` writes a directory you can host anywhere, and the
program in it will run inside somebody else's page as readily as it runs in
its own tab. This page is what you need to know to do that.

## What the build writes

```
dist/web/
  index.html      the program, filling the whole tab
  embed.html      the same program inside an article — a worked example
  8bitscript.js   the loader: mount() and <eightbit-screen>
  worker.js       the machine, as a file (the loader also carries a copy)
  coi.js          opt-in cross-origin isolation, for hosts that cannot send headers
  program.wasm    your compiled program
  _headers        COOP/COEP, in the form Cloudflare Pages and Netlify read
```

`index.html` is not special. It calls the same `EightBitScript.mount()` any
page calls — it is a shell of about forty lines around the loader. If
embedding breaks, the page we look at every day breaks with it.

## The short version

Copy `8bitscript.js` and `program.wasm` next to your page:

```html
<script src="8bitscript.js"></script>
<eightbit-screen src="program.wasm"></eightbit-screen>
```

That is the whole integration. The element sizes itself to the space you give
it, takes swipes and taps on touch, takes the arrow keys when it has focus,
and picks its own border (see [Borders](#borders)).

If you would rather hold a handle:

```html
<div id="game" style="height: 60vh"></div>
<script src="8bitscript.js"></script>
<script>
  var screen = EightBitScript.mount('#game', { src: 'program.wasm' });
  // screen.destroy() when you tear the page down
</script>
```

## Cross-origin isolation

This is the one requirement, and it is not optional.

The program runs in a Web Worker, and the page paints the program's screen
memory while the program is still running — that memory is a
`SharedArrayBuffer` shared between the two. Browsers only let a
`SharedArrayBuffer` cross between a page and its worker when the page is
**cross-origin isolated**, which means two response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Measured in Chromium 153 on a page without them: creating shared memory is
fine and the module instantiates fine, but `postMessage` throws
`DataCloneError: SharedArrayBuffer transfer requires self.crossOriginIsolated`
— for the buffer and for a `WebAssembly.Memory` alike. There is no worker
arrangement that avoids it, either: a worker sitting inside a blocking
`waitFrame()` never returns to its event loop, so it cannot be sent input by
message while a program is running. Shared memory is the only channel.

Without the headers the loader does not fail silently — it says so on the
screen, and tells you which two headers are missing.

### Setting the headers

`_headers` in the bundle already covers **Cloudflare Pages** and **Netlify**.
For everyone else:

**nginx**

```nginx
location / {
  add_header Cross-Origin-Opener-Policy same-origin;
  add_header Cross-Origin-Embedder-Policy require-corp;
}
```

**Apache** (`.htaccess`)

```apache
Header set Cross-Origin-Opener-Policy "same-origin"
Header set Cross-Origin-Embedder-Policy "require-corp"
```

**Vercel** (`vercel.json`)

```json
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
      { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
    ]
  }]
}
```

**Express**

```js
app.use((req, res, next) => {
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
```

### When you cannot set headers

GitHub Pages, a shared CMS, somebody else's blog. Load `coi.js` **before** the
loader:

```html
<script src="coi.js"></script>
<script src="8bitscript.js"></script>
<eightbit-screen src="program.wasm"></eightbit-screen>
```

It registers a service worker that adds the headers to this origin's own
responses and reloads the page once. Verified end to end against a static
file server sending no headers at all: the page comes back isolated and the
program runs at its configured frame rate.

**Read this before you use it.** `COEP: require-corp` then applies to your
*entire page*, not just the game. Any third-party image, script, font or
iframe you load must itself send `Cross-Origin-Resource-Policy` (or proper
CORS) or it will stop loading. It also needs HTTPS (or localhost), because
service workers do. If that trade is wrong for your page, put the game in an
`<iframe>` and load `coi.js` inside the iframe only — the isolation then
stops at the frame boundary.

This is why it is never loaded for you.

## Borders

The border is the frame around the picture — overscan on a real VIC-20, and on
a desktop it reads as the machine's own edge. It is also 48 of every 368
horizontal pixels and 48 of every 248 vertical ones: a fifth of the height
spent on decoration.

On a phone that trade is wrong in either orientation, so the loader drops it:

| Space the picture has | Border |
|---|---|
| under 2× (a phone, upright or sideways; a narrow column) | none |
| 2×–3×, or any touch screen | 8 px hairline |
| 3× and up with a mouse | the full 24 px |

It is measured from the **container**, not the window, so a screen in a narrow
article column gets the same treatment a phone does. Override it with
`border="0"`, `border="24"`, or `border: 24` to `mount()`; `auto` is the
default.

A headless `--screenshot` always renders the full 24-pixel border. There is no
viewport to measure there, so it has no business guessing at a smaller one.

## Options

Attributes on `<eightbit-screen>`, or keys passed to `mount()`:

| Attribute | Option | Default | What it does |
|---|---|---|---|
| `src` | `src` | — | URL of the `.wasm`. Required. |
| `border` | `border` | `auto` | `auto`, or a fixed number of pixels. |
| `frame-rate` | `frameRate` | build's `frameRate` | Logical frames per second. |
| `hud` | `hud` | off | A small FPS readout in the corner. |
| `hint` | `hint` | none | A line of text that fades after three seconds. |
| `fullscreen="off"` | `fullscreen` | on | Double-click, or `F`, to fill the screen. |
| `worker` | `worker` | inlined | URL of `worker.js`, for a CSP that forbids `blob:` workers. |
| — | `keyboard` | `focus` | `focus` (only when the element has focus) or `window`. |
| — | `fullPage` | `false` | Size to the visual viewport instead of the container. |
| — | `autoStart` | `true` | Call `start()` yourself when `false`. |
| — | `onSample`, `onDone`, `onError` | — | Callbacks. |

`mount()` returns `{ canvas, root, start, destroy, isRunning, border, say }`.

## Notes on hosting

- **Serving the loader from another origin** (a CDN, say) works: the loader
  carries the worker inside itself and starts it from a `blob:` URL, because
  `new Worker()` is blocked across origins and a blob is not. Pages under a
  CSP without `worker-src blob:` should pass `worker="worker.js"` and serve
  that file from their own origin instead.
- **Serving `program.wasm` from another origin** needs CORS on that response,
  plus `Cross-Origin-Resource-Policy: cross-origin` — under `require-corp`,
  a cross-origin subresource without it is blocked.
- **`.wasm` must be served as `application/wasm`.** Most hosts do; a few old
  Apache configs do not, and `WebAssembly.compile` will complain if yours
  doesn't.
- **Keyboard, embedded.** The arrow keys only go to the screen while it has
  focus, so the page around it still scrolls. A tap or click gives it focus.
