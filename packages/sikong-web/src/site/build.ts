/**
 * src/site/build.ts — SSG build script for the sikong.dev static site.
 *
 * Renders the Page component tree to an HTML document using
 * renderToStringWithCSS for scoped CSS extraction, then writes
 * the result to dist/index.html.
 *
 * Global/reset styles are inlined as a raw <style> block since
 * they are not scoped to a single component class.
 *
 * Run:  bun src/site/build.ts
 *
 * @module
 */

import { renderToStringWithCSS } from "semajsx/html"
import { Page, GLOBAL_CSS } from "./components"

const OUT_DIR = "dist"

// Render the Page to an HTML document with extracted scoped CSS.
// renderToStringWithCSS returns both html and css (<style> tags) —
// the scoped styles are extracted from the component tree and returned as
// rendered <style> elements. Global/reset styles come from the GLOBAL_CSS export.
const vnode = Page()
const { html, css: styleTags } = renderToStringWithCSS(vnode)

// Assemble the complete HTML document
const doc = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sikong (司空) — Durable Agent Workspaces</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔭</text></svg>">
  <meta name="description" content="Sikong is a universal coordination layer for multi-agent, multi-runtime development. One config, four backends, full observability." />
  <meta name="og:title" content="Sikong (司空) — Durable Agent Workspaces" />
  <meta name="og:description" content="Build with agent workflows across any runtime. Unified orchestration for Claude Code, Codex, Cursor, and AI SDK." />
  <meta name="og:type" content="website" />
  <meta name="og:url" content="https://sikong.dev" />
  <style>${GLOBAL_CSS}</style>
  ${styleTags}
</head>
<body>${html}</body>
</html>
`

// Write the output file
await Bun.write(`${OUT_DIR}/index.html`, doc)
console.log(`✓ ${OUT_DIR}/index.html`)

// Copy the curl installer into the site output so sikong.dev/install.sh serves it
// (matches the hero's `curl -fsSL https://sikong.dev/install.sh | sh`). The repo
// root is four levels up from this file (src/site/build.ts).
const installer = Bun.file(new URL("../../../../install.sh", import.meta.url))
if (await installer.exists()) {
  await Bun.write(`${OUT_DIR}/install.sh`, installer)
  console.log(`✓ ${OUT_DIR}/install.sh`)
} else {
  console.warn("⚠ install.sh not found at repo root — sikong.dev/install.sh will 404")
}
