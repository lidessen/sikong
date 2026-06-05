# 0029 — Interactive monitor dashboard (semajsx hydration + live SSE)

Status: Accepted
Date: 2026-06-06
Extends: 0018 (sikong-web dashboard)

## Context

The local monitor (`bun run dashboard`, ADR 0018) is SSR-only: `renderToStringWithCSS`
→ pure HTML+CSS with a `<meta http-equiv="refresh" content="10">` whole-page reload
and **zero client JS**. So it can't be interacted with — no filter, no sort, no
drill-down, no incremental updates; every 10s the page fully reloads (flash, scroll
jump). semajsx is a *signal-based reactive runtime with a client `dom` story*, so the
monitor can become a live reactive app without leaving the stack.

## Decision — hydrate + stream

- **Hydration.** Keep SSR for first paint (fast, and a no-JS fallback still renders),
  then hydrate the rendered tree with `semajsx/dom`. The vendored semajsx gains a
  `./dom` export (re-vendor) for the client.
- **Live data via SSE.** `server.ts` adds an `/events` endpoint that streams
  `overview`/`usage` JSON on an interval; the client feeds it into signals so the DOM
  updates **in place** (no full reload). The `<meta refresh>` is removed.
- **Client interactions.** Filter by status/project, sort, drill-down into a task
  (detail view), collapsible sections — all client-side off the hydrated signals.
- **Client build.** A `build:dashboard` step bundles the hydration entry (importing
  `semajsx/dom`) to `dist/`; the served HTML links it.

## Why

- One reactive stack end-to-end (SSR → hydrate → signals), dogfooding semajsx's
  client story — the same runtime that renders sikong.dev.
- Progressive enhancement: SSR first paint + no-JS fallback preserved; interactivity
  and live updates layer on top.

## Consequences

- `server.ts` gains an SSE endpoint + serves a client bundle; a `build:dashboard`
  script appears; the vendored semajsx exports `./dom`.
- The monitor becomes a live, filterable, drill-down app instead of a reloading
  snapshot. Still local-only (not deployed).
- Acceptance (grounded): the client bundle builds, the served page references it, and
  `/events` streams — verified by lead-authored checks since apps/sikong-web is
  outside the root workspace gate.
