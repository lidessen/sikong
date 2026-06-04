/**
 * Build all three design candidate previews for design/preview/
 *
 * Run:  bun src/site/build-previews.ts
 *   (from packages/sikong-web/)
 */

import { renderToStringWithCSS } from "semajsx/html"

const CANDIDATES = [
  { dir: "architect", title: "Sikong — Durable Agent Workspaces", import: () => import("./candidates/architect/components") },
  { dir: "nebula",    title: "Sikong — Agent-Driven Development Platform",   import: () => import("./candidates/nebula/components") },
  { dir: "flow",      title: "Sikong — Orchestrate Agent Workflows",         import: () => import("./candidates/flow/components") },
]

const OUT = "../../design/preview"

for (const c of CANDIDATES) {
  const { Page, GLOBAL_CSS } = await c.import()
  const { html, css: styleTags } = renderToStringWithCSS(Page())
  const doc = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${c.title}</title>
<style>${GLOBAL_CSS}</style>${styleTags}</head>
<body>${html}</body>
</html>`
  const outPath = `${OUT}/${c.dir}/index.html`
  await Bun.write(outPath, doc)
  console.log(`✓ ${outPath}`)
}
