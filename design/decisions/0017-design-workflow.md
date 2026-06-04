# 0017 — Design workflow (sikong-orchestrated UI design → real semajsx)

Status: Accepted
Date: 2026-06-04

## Context

The "design system" the owner wants is **not a separate product** — it is a
**sikong workflow** (like `development-lead`), with **semajsx as the expression
substrate**. The goal: a design experience better than Claude's design feature,
because the output is **real, runnable semajsx code** (web + TUI), produced with
sikong's engineering rigor — no mockup→implementation gap, JS-native and mixable,
open and local (JS + git), under explicit lead approval.

## Decision

Add a built-in **`design`** workflow to sikong. It runs on a target project (the
app being designed; semajsx is a dependency there) and produces real semajsx
components/pages. Stages — reusing existing mechanism (dialectic ADR 0012,
multi-agent diverge, approval ADR 0016), no new engine primitive:

1. **brief** — capture what to design (page/component/screen) + constraints
   (`semajsx/ui` + style tokens, targets: web and/or TUI). Record decisions.
2. **diverge** — generate **N candidate designs as real semajsx code** (multi-
   agent, genuinely different approaches — the judge-panel pattern). Each
   candidate is a real, runnable bundle of files.
3. **preview** — emit each candidate as a **live preview**, not a flattened
   screenshot: a runnable semajsx bundle the owner opens and interacts with —
   served live (SSR/dev server) or built static (SSG) — plus optionally a design
   doc + the code. This is exactly the Claude-design output shape (a set of real
   files / a live preview), but the files ARE the deliverable. This live loop is
   what makes it a design tool, not codegen.
4. **critique** — adversarial critique across candidates (hierarchy, a11y,
   consistency, token usage); each candidate judged by distinct lenses.
5. **converge** — synthesize/pick the best (graft the runners-up's good ideas);
   **lead approval gate** here.
6. **refine** — iterate on owner feedback (re-preview).
7. **deliver** — write the chosen design as real `semajsx/ui`-based components/
   pages into the target project; **lead approval gate** before it lands.

### The preview bridge (the one new capability)

A **live-preview** tool, not a screenshotter. It emits each candidate as a
runnable artifact the owner can open and interact with:
- **web**: a live preview — either a small SSR/dev server (semajsx/dom +
  semajsx/html) the owner opens in a browser, or a static SSG build (`build.ts`)
  written to a preview directory. Real files, real interactivity.
- **TUI**: a live terminal render (semajsx/terminal).
- alongside the runnable bundle, optionally a **design doc + the code** — the
  same multi-output shape Claude design emits (files / live preview / doc).

The files ARE the deliverable, so "preview" and "deliver" share one artifact —
preview is just the candidate served before approval. This is the only net-new
piece; the rest is workflow + existing sikong mechanism. It belongs at the worker
boundary (a worker tool), keeping the engine task-agnostic (ADR 0007).

## Why it beats Claude design
- **Output is real runnable code**, not a black-box mockup — ships directly.
- **JS-native, mixable, agent-friendly** (semajsx: no build invasion, separable
  component/style/app concerns).
- **Engineering rigor**: divergent candidates, multi-lens critique, render-as-
  verify, explicit approval gates, observable (worklog/usage).
- **Web *and* TUI** from one model; **open + local** (JS + git).

## Alternatives considered
- **A standalone design app/repo.** Rejected by the owner: it's a sikong
  workflow, not a separate project — keeps it in the orchestration layer where
  the engineering capability already lives.
- **Mockup-first (generate images, implement later).** Rejected: re-introduces
  the design→implementation gap; semajsx lets design *be* code.

## v0 scope
1. The **`design` workflow** in `packages/sikong/src/workflow/builtin.ts`
   (brief → diverge → preview → critique → converge → refine → deliver, with
   approval gates).
2. The **live-preview bridge** (semajsx SSR dev-server / SSG build → runnable
   files the owner opens; optional doc + code) as a worker tool.
3. Dogfood: **design sikong's own UI** (the monitor / sikong.dev homepage) as the
   first real run.

## Consequences
- sikong gains a design capability without a new product; semajsx is its substrate.
- Depends on semajsx phase 2 (done: `semajsx/ui` + utilities). The preview bridge
  reuses semajsx's existing render targets (SSR/dev-server + SSG `build.ts`) — no
  screenshot/headless-browser dependency needed; the live files are the preview.
