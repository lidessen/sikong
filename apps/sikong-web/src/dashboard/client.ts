/**
 * src/dashboard/client.ts — Browser hydration entry point for the monitor dashboard
 *
 * Loaded by the served HTML page. Creates reactive signals for overview/usage
 * data, builds the DashboardPage VNode tree via computed signals, hydrates
 * into the live DOM, and connects to the /events SSE endpoint for live
 * incremental updates (no full-page reload).
 *
 * Bundled to dist/client.js by scripts/build-dashboard.ts.
 *
 * @module
 */

import { hydrate } from "semajsx/dom"
import { signal, computed } from "semajsx/signal"
import { DashboardPage } from "./components"
import type { OverviewData, UsageData } from "./components"
import type { JSXNode } from "semajsx/html"

// ── Reactive state ────────────────────────────────────────────────────────────

/** Live overview data, updated by SSE. */
const overview = signal<OverviewData | null>(null)

/** Live usage data, updated by SSE. */
const usage = signal<UsageData | null>(null)

/** Whether the SSE connection is established. */
const connected = signal(false)

// ── Computed page tree ────────────────────────────────────────────────────────

/**
 * Reactive page VNode — re-renders the full DashboardPage whenever the
 * underlying overview or usage signal changes (SSE push).
 */
const pageVNode = computed([overview, usage], (): JSXNode => {
  if (!overview.value || !usage.value) {
    // No data yet — the SSR HTML is still visible; replace with an empty
    // container that will fill in once the first SSE frame arrives.
    return null
  }
  return DashboardPage(overview.value, usage.value, new Date())
})

// ── Root VNode ────────────────────────────────────────────────────────────────

/** Root app — a VSignal that embeds the computed page tree. */
const app = { type: "signal" as const, signal: pageVNode }

// ── Hydrate ───────────────────────────────────────────────────────────────────

const dispose = hydrate(app, document.body)

// ── SSE connection ────────────────────────────────────────────────────────────

let es: EventSource | null = null

function connectSSE(): void {
  es = new EventSource("/events")

  es.onmessage = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as {
        overview?: OverviewData
        usage?: UsageData
      }
      if (data.overview) overview.value = data.overview
      if (data.usage) usage.value = data.usage
      if (!connected.value) connected.value = true
    } catch {
      // Ignore malformed SSE frames — wait for the next push
    }
  }

  es.onerror = () => {
    connected.value = false
    // EventSource auto-reconnects after a backoff — no manual reconnect needed
  }
}

connectSSE()

// ── Cleanup ───────────────────────────────────────────────────────────────────

window.addEventListener("beforeunload", () => {
  dispose()
  if (es) es.close()
})
