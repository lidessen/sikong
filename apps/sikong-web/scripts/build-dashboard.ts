/**
 * scripts/build-dashboard.ts — Bundle the dashboard client for the browser
 *
 * Uses Bun.build to compile src/dashboard/client.ts → dist/client.js
 * (browser target, single-file output). Run via `bun run build:dashboard`.
 *
 * @module
 */

import { join } from "path"

const root = join(import.meta.dir, "..")
const entrypoint = join(root, "src", "dashboard", "client.ts")
const outdir = join(root, "dist")

console.log(`Building dashboard client bundle...`)
console.log(`  entry: ${entrypoint}`)
console.log(`  out:   ${join(outdir, "client.js")}`)

const result = await Bun.build({
  entrypoints: [entrypoint],
  outdir,
  target: "browser",
  naming: { entry: "client.js" },
})

if (!result.success) {
  console.error("Build failed:")
  for (const log of result.logs) {
    console.error(`  ${log.message}`)
  }
  process.exit(1)
}

console.log(`Done — ${result.outputs.length} output(s)`)

// Build resources are released automatically when the process exits
