/**
 * src/dashboard/server.ts — Local monitor dashboard HTTP server
 *
 * SSR first paint (semajsx renderToStringWithCSS) for no-JS fallback,
 * plus an /events SSE endpoint for live incremental updates and a
 * /client.js route serving the browser hydration bundle. The client
 * hydrates the SSR DOM into a live reactive semajsx app.
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
import { join } from "path"

const PORT = Number(process.env.SIKONG_WEB_PORT ?? 4317)
// The sikong CLI to shell out to. Defaults to `sikong` on PATH; override with
// SIKONG_BIN to point at a built binary (e.g. packages/sikong/dist/sikong) when
// sikong isn't installed globally.
const SIKONG_BIN = process.env.SIKONG_BIN ?? "sikong"

// Path to the built client bundle (produced by `bun run build:dashboard`)
const CLIENT_BUNDLE_PATH = join(import.meta.dir, "..", "..", "dist", "client.js")

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
  const [overview, usage] = await Promise.all([
    runJson<OverviewData>(SIKONG_BIN, ["overview", "--json"]),
    runJson<UsageData>(SIKONG_BIN, ["usage", "--json"]),
  ])

  return { overview, usage, available: overview !== undefined }
}

// ── HTML page builders ──────────────────────────────────────────────────────

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
  <title>Sikong Dashboard</title>
  <style>${GLOBAL_CSS}</style>
  ${styleTags}
  <script src="/client.js" defer></script>
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
  <title>Sikong Dashboard — CLI Not Available</title>
  <style>${GLOBAL_CSS}</style>
  ${styleTags}
</head>
<body>${html}</body>
</html>
`
}

// ── SSE helpers ─────────────────────────────────────────────────────────────

const SSE_POLL_MS = 10_000

/**
 * Create an SSE response that pushes overview+usage data every SSE_POLL_MS.
 * The initial frame is sent immediately on connect.
 */
function createSSEResponse(signal: AbortSignal): Response {
  let interval: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream({
    async start(controller) {
      const push = async () => {
        try {
          const data = await fetchData()
          const payload = JSON.stringify({
            overview: data.overview ?? null,
            usage: data.usage ?? null,
          })
          controller.enqueue(`data: ${payload}\n\n`)
        } catch {
          // Silently skip a failed fetch — the client keeps its last-known state
        }
      }

      // Push initial data immediately
      await push()

      // Then poll on an interval
      interval = setInterval(push, SSE_POLL_MS)

      // Clean up on abort (client disconnect)
      signal.addEventListener("abort", () => {
        if (interval !== null) clearInterval(interval)
        controller.close()
      })
    },

    cancel() {
      if (interval !== null) clearInterval(interval)
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}

// ── Static file serving ─────────────────────────────────────────────────────

/** Serve the client bundle from dist/. Returns 404 if the file doesn't exist. */
function serveClientBundle(): Response {
  const file = Bun.file(CLIENT_BUNDLE_PATH)
  // Bun.file is lazy — checking .size throws if the file doesn't exist
  try {
    // Use a synchronous check via stat-like behavior
    return new Response(file, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    })
  } catch {
    return new Response("client.js not found — run `bun run build:dashboard`", {
      status: 404,
    })
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 })
    }

    // SSE endpoint — live incremental data stream
    if (url.pathname === "/events") {
      return createSSEResponse(req.signal)
    }

    // Client JS bundle — browser hydration entry point
    if (url.pathname === "/client.js") {
      return serveClientBundle()
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
console.log(`SSE events:   http://localhost:${PORT}/events`)
