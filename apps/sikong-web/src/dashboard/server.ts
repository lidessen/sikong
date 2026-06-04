/**
 * src/dashboard/server.ts — Local monitor dashboard HTTP server
 *
 * Bun.serve with <meta http-equiv="refresh" content="10"> auto-refresh.
 * Shells out to `sikong overview --json` and `sikong usage --json` for data.
 * Graceful fallback when CLI is unavailable.
 *
 * Run:  bun src/dashboard/server.ts
 *
 * @module
 */

import { renderToStringWithCSS } from "semajsx/html"
import {
  DashboardPage,
  NotAvailable,
  GLOBAL_CSS,
} from "./components"
import type { OverviewData, UsageData } from "./components"

const PORT = Number(process.env.SIKONG_WEB_PORT ?? 4317)
// The sikong CLI to shell out to. Defaults to `sikong` on PATH; override with
// SIKONG_BIN to point at a built binary (e.g. packages/sikong/dist/sikong) when
// sikong isn't installed globally.
const SIKONG_BIN = process.env.SIKONG_BIN ?? "sikong"

// ── Shell helpers ───────────────────────────────────────────────────────────

/**
 * Run a command and return its stdout as a parsed JSON object.
 * Returns undefined if the command fails (exit code, spawn error, or JSON parse error).
 */
async function runJson<T>(cmd: string, args: string[]): Promise<T | undefined> {
  try {
    const proc = Bun.spawnSync([cmd, ...args], {
      env: { ...process.env },
    })
    if (!proc.success || proc.exitCode !== 0) return undefined
    if (!proc.stdout || proc.stdout.length === 0) return undefined
    return JSON.parse(proc.stdout.toString()) as T
  } catch {
    return undefined
  }
}

// ── Data fetching ───────────────────────────────────────────────────────────

interface FetchResult {
  overview: OverviewData | undefined
  usage: UsageData | undefined
  available: boolean
}

async function fetchData(): Promise<FetchResult> {
  // Probe by actually fetching overview — there is no `--version` flag, and a
  // successful overview is the real signal that the CLI is usable.
  const [overview, usage] = await Promise.all([
    runJson<OverviewData>(SIKONG_BIN, ["overview", "--json"]),
    runJson<UsageData>(SIKONG_BIN, ["usage", "--json"]),
  ])

  return { overview, usage, available: overview !== undefined }
}

// ── HTML page builder ───────────────────────────────────────────────────────

function renderDashboardPage(
  data: { overview: OverviewData; usage: UsageData },
): string {
  const lastUpdated = new Date()
  const vnode = DashboardPage(data.overview, data.usage, lastUpdated)
  const { html, css: styleTags } = renderToStringWithCSS(vnode)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="10" />
  <title>Sikong Dashboard</title>
  <style>${GLOBAL_CSS}</style>
  ${styleTags}
</head>
<body style="display:flex;min-height:100vh;">${html}</body>
</html>
`
}

function renderErrorPage(): string {
  const vnode = NotAvailable()
  const { html, css: styleTags } = renderToStringWithCSS(vnode)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="30" />
  <title>Sikong Dashboard — CLI Not Available</title>
  <style>${GLOBAL_CSS}</style>
  ${styleTags}
</head>
<body>${html}</body>
</html>
`
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 })
    }

    if (url.pathname === "/") {
      const result = await fetchData()

      if (!result.available || !result.overview || !result.usage) {
        const html = renderErrorPage()
        return new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
      }

      const html = renderDashboardPage({
        overview: result.overview,
        usage: result.usage,
      })
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    // 404 for anything else
    return new Response("Not Found", { status: 404 })
  },
})

console.log(`Sikong Dashboard running at http://localhost:${PORT}`)
console.log(`Health check: http://localhost:${PORT}/health`)
