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

import { renderToString, renderToStringWithCSS } from "semajsx/html"
import { Page } from "./components"

const OUT_DIR = "dist"
const YEAR = new Date().getFullYear()

// Global styles — not scoped via css() since they target raw elements
const GLOBAL_CSS = `
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC",
    Helvetica, Arial, sans-serif;
  background: #0f172a;
  color: #e2e8f0;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
a { color: #60a5fa; text-decoration: none; transition: color 0.15s ease; }
a:hover { color: #93c5fd; }
::selection { background: rgba(59, 130, 246, 0.3); }
code {
  font-family: "SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", monospace;
  font-size: 0.875em;
}

/* Hover interactions for fixed class names used in components */
.sk-card:hover { border-color: #3b82f6; }
.sk-btn-primary:hover { background: #2563eb; }
.sk-btn-secondary:hover { border-color: #475569; background: #1e293b; }
.sk-foot-link:hover { color: #94a3b8; }

/* Responsive tweaks */
@media (max-width: 640px) {
  .sk-card { padding: 24px; }
}
`

// Render the Page to an HTML document with extracted scoped CSS.
// renderToStringWithCSS returns both html and css (<style> tags).
const vnode = Page()
const { html, css: styleTags } = renderToStringWithCSS(vnode)

// renderToString is available for plain SSR (no CSS extraction).
// Using renderToStringWithCSS below for combined HTML + scoped CSS output.

// Assemble the complete HTML document
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
</html>
`

// Write the output file
await Bun.write(`${OUT_DIR}/index.html`, doc)
console.log(`✓ ${OUT_DIR}/index.html (${YEAR})`)

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
