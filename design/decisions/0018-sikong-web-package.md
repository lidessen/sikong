# ADR 0018: sikong-web — new package for sikong.dev website + local monitor dashboard

Status: Accepted

Date: 2026-06-04

## Context

Sikong needs two user-facing UI surfaces:
1. **sikong.dev** — a public homepage (static site) for documentation, install instructions, and a project feature showcase.
2. **Local monitor dashboard** — a read-only web UI a developer runs locally to see workspace state (projects, tasks, usage/cost) without the terminal output.

Both should be built with **semajsx** (the signal-based reactive JSX runtime) as the UI substrate. This is the first dogfood of ADR 0017's preview/deliver pipeline.

The constraint: the new package must not touch `packages/sikong` or `packages/agent-loop` (another build edits those concurrently), and root `package.json` workspaces is `packages/*` so the package auto-joins.

## Decision

Add a new `packages/sikong-web` package with the architecture documented in the `design` field of task_cafc41f6.

Key architectural choices:

- **Component authoring**: plain VNode factory functions (like the semajsx examples), not JSX — simpler for v0, no transform complexity.
- **SSG build**: pure Bun script following `examples/static/build.ts` — single page site doesn't need the full SSG framework.
- **Dashboard server**: pure `Bun.serve` — zero deps, single-route, refresh via `<meta http-equiv="refresh">`.
- **Data sourcing**: shell out to `sikong overview --json` / `sikong usage --json` — decoupled from packages/sikong internals.
- **CSS**: `css()` from `semajsx/style` collected via `renderToStringWithCSS` — no external CSS file.

## Consequences

- **New workspace member**: root `bun run --filter '*' typecheck` and `bun run --filter '*' test` now cover sikong-web (typecheck wired, test is `true` placeholder).
- **semajsx build prerequisite**: the `file:` dependency on `../semajsx-next/packages/semajsx` means semajsx must be built before sikong-web can resolve imports.
- **Decoupled data contract**: dashboard depends on the CLI JSON surface of `sikong overview` and `sikong usage`, not on internal store formats.
- **No runtime build step**: dashboard runs .ts directly via Bun; site build is a Bun script.
- **Vercel deploy**: static output only, semajsx not needed at runtime.

## Implementation Notes

1. Create `packages/sikong-web/` with package.json, tsconfig.json, vercel.json.
2. Build semajsx dist first (`cd ../semajsx-next && bun run build`).
3. Test `bun install` resolves the `file:` dep.
4. Verify site build produces `dist/index.html` with expected content.
5. Verify dashboard starts and returns HTML from real sikong data.

## Open Questions

- Should future versions use JSX for complex dashboard layouts? Deferred.
- Should future versions serve dashboard as a client-side SPA? Deferred.
- Should the site have more pages (docs, changelog)? Deferred — v0 is single-page.
