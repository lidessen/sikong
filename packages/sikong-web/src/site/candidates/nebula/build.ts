/**
 * Candidate B: build script
 */

import { renderToStringWithCSS } from "semajsx/html"
import { Page, GLOBAL_CSS } from "./components"

const OUT = "dist/candidates/nebula"

const vnode = Page()
const { html, css: styleTags } = renderToStringWithCSS(vnode)

const doc = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sikong — Agent-Driven Development Platform</title>
  <style>${GLOBAL_CSS}</style>
  ${styleTags}
</head>
<body>${html}</body>
</html>`

await Bun.write(`${OUT}/index.html`, doc)
console.log(`✓ ${OUT}/index.html`)
