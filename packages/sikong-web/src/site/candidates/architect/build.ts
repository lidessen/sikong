/**
 * Candidate A: build script
 * Renders the Architect candidate to HTML.
 *
 * Run:  bun src/site/candidates/architect/build.ts
 */

import { renderToStringWithCSS } from "semajsx/html"
import { Page, GLOBAL_CSS } from "./components"

const OUT = "dist/candidates/architect"

const vnode = Page()
const { html, css: styleTags } = renderToStringWithCSS(vnode)

const doc = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sikong — Durable Agent Workspaces</title>
  <style>${GLOBAL_CSS}</style>
  ${styleTags}
</head>
<body>${html}</body>
</html>`

await Bun.write(`${OUT}/index.html`, doc)
console.log(`✓ ${OUT}/index.html`)
