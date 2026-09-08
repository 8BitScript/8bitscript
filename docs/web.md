---
title: Hosting the web target
nav_order: 13
---

# Hosting the web target

`8bs build --target web` writes two things: `dist/<stem>.wasm`, and a
hostable directory `dist/web/` containing the canvas page, the worker, the
wasm module, and a Cloudflare `_headers` file.

```
dist/web/
  index.html
  worker.js
  program.wasm
  _headers
```

The `_headers` file sets `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. A `waitFrame()` program uses
`SharedArrayBuffer`; without those headers the worker cannot block on the
page's frame clock. Any static host that honours `_headers` (Cloudflare
Workers static assets does) is enough. A host that does not must send the
same two headers on every response.

## Cloudflare Workers

A program's `wrangler.jsonc` can be this short:

```jsonc
{
  "name": "my-8bs-game",
  "compatibility_date": "2026-09-07",
  "assets": { "directory": "./dist/web" },
  "routes": [{ "pattern": "game.example.com", "custom_domain": true }]
}
```

Build, then deploy:

```bash
pnpm exec 8bs build --target web
npx wrangler deploy
```

The first deploy against a custom domain needs that hostname's zone already
in the same Cloudflare account. `2048` ships this shape at
`2048.8bitscript.com`.

## Touch

The web page maps swipe gestures onto the same input bits as the arrow keys,
and a tap onto confirm. A portable program that already calls
`input.left()` / `input.right()` / `input.up()` / `input.down()` /
`input.confirm()` is playable on a phone without extra game code.
