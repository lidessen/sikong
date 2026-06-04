# 0019 — Release/deploy workflow (ship a project: select stable → gate → tag → publish → confirm)

Status: Accepted
Date: 2026-06-04

## Context

sikong builds projects (chiling, shilu, semajsx, agent-loop/sikong itself,
agent-service-design) but has no standard way to **ship** one. Each project
releases differently — npm publish, a GitHub Release with prebuilt binaries
(sikong's curl-install path), a Vercel deploy (sikong.dev), a Go binary (shilu).
The owner's framing: a workflow that supports "项目构建发布上线" for various
projects, where the simplest dev flow is just **"tag a release" and a stable
version ships** — the team picks a stable point and publishes it.

ADR 0016 already defined a *self*-promote (sikong releasing the next sikong) with
a mandatory approval gate. This ADR **generalizes that to any project**: one
`release` workflow, target-agnostic, with the same safety boundary.

## Principle (consistent with ADR 0007)

Releasing is **coordination + a safety gate**, which is sikong's job; the actual
release *commands* (`npm publish`, `git push <tag>`, `vercel deploy`, `gh release`)
are the agent's job. The workflow never hardcodes a publish mechanism — the agent
inspects the project (its `package.json` scripts, `.github/workflows`,
`vercel.json`, release scripts) and executes the project's own way to ship.
sikong owns: *which* version, *is it stable*, *explicit approval*, *did it land*.

## Decision

A new built-in **`release`** workflow — **multi-stage, with each stage staffed
independently** (owner steer: "多阶段，未必是一个 worker"). sikong already selects
a worker per wake, so different stages naturally draw the right worker — e.g. the
**gate** stage a verify-capable worker, the **publish** stage a release-capable
one — and `publish` MAY fan out (create_subtask) when a release ships multiple
artifacts together (e.g. npm-publish semajsx AND deploy its docs). It is not a
single linear worker, and not a full lead either: linear by default, fan-out only
where a release genuinely spans parallel artifacts. Stages:

1. **assess** — decide WHAT to ship: the candidate ref/version (default: current
   `main` HEAD that's green; or a ref the lead names), the changelog since the
   last release, and the target(s) inferred from the repo (npm? GitHub Release +
   binaries? Vercel? Go binary?). Record `release_plan` (version, targets,
   changelog, the exact publish commands it intends to run). Block if the project
   has no discernible release mechanism.
2. **gate** — prove the candidate is **stable** before anything outward: run the
   project's full verification (build + test + any `release:check`) on that exact
   ref, plus a real-user smoke where it applies (ADR 0015). Record `gate` with the
   exact commands + results. Block if it isn't green — you do not ship red.
3. **prepare** — make the release locally, nothing outward yet: bump version,
   update CHANGELOG, create the tag (unpushed), build artifacts. Record `prepared`.
4. **approve** — **HALT for explicit lead approval** (outward-facing = the safety
   boundary, cf. ADR 0004, ADR 0016). The agent presents version + changelog +
   gate evidence + precisely what will be published where, then stops. Only an
   **external lead transition** (`sikong submit <id> transition approve`) advances
   to publish. No approval → no publish.
5. **publish** — on approval, execute the project's release: e.g. `git push origin
   <tag>` (→ the repo's release CI builds + uploads, as sikong's `release.yml`
   does), `npm publish`, `vercel deploy --prod`. Record `published` (what ran).
6. **confirm** — verify it actually landed: the GitHub Release/assets exist, the
   npm version resolves, the deploy URL is live, the install one-liner works.
   Record `verification` + a one-line `summary`. Block if it didn't land.

### Why the approval gate is between prepare and publish

Everything up to `prepare` is local and reversible (delete a tag, discard a
branch). `publish` is outward-facing and effectively irreversible (a published
npm version can't be unpublished cleanly; a deploy is live; a pushed tag triggers
CI). So the human/AI lead approves with the full candidate + evidence in front of
them — identical safety posture to ADR 0016's promote gate. This is the one place
the workflow deliberately stops itself.

### Relationship to ADR 0016 (self-iteration)

ADR 0016's "release + approve + promote" is the **special case** of this workflow
applied to `agent-loop/packages/sikong` (where "publish" = swap `dist/sikong` ←
candidate + keep `.prev`). After this ADR, the self-iterate loop's release stage
can *delegate to the `release` workflow* instead of carrying its own bespoke
release stage — one release mechanism, reused.

## Resolved choices (owner-steered 2026-06-04)

1. **v0 target scope — tag + npm + Vercel.** v0 supports all three: push-tag
   (→ release CI builds/uploads, e.g. sikong's binaries), `npm publish`, and
   `vercel deploy --prod`. The agent runs whichever the project needs.
2. **Version selection — lead-named ref.** The release targets a ref/version the
   lead names (passed in the request / a `target_ref` field). The gate still
   proves it green; no auto "latest-green" magic in v0. (Auto-selection can come
   later behind the same gate.)
3. **Per-project release config — hybrid (my design).** Default: the agent
   **infers** the mechanism from the repo (package.json scripts, .github/workflows,
   vercel.json, release scripts) — zero-config, task-agnostic (ADR 0007). Optional
   override: if a project has an explicit release descriptor, the agent reads it
   and follows it verbatim. The descriptor lives where sikong already keeps durable
   per-project intent — the project's design doc / `release` section (or a
   `.sikong/release.json`), a small `{ targets: [...], commands: {...},
   confirm: [...] }`. So unconfigured projects "just work" by inference, and
   projects that want determinism/audit pin it explicitly. The descriptor is data
   the agent consumes — the engine stays release-agnostic.
4. **Structure — multi-stage, per-stage staffing, publish may fan out.** Resolved
   into the Decision above: not one linear worker; each stage gets the right worker
   per wake, and `publish` fans out only when artifacts ship in parallel.

## Consequences
- sikong can ship any project through one auditable, gated path.
- Outward-facing publishing always passes an explicit human/AI approval.
- ADR 0016 self-promotion becomes a thin specialization, not a parallel mechanism.

## Build order (when accepted)
1. The `release` workflow def (assess → gate → prepare → approve → publish →
   confirm) + register it.
2. Wire the approval gate to the existing lead-approval primitive (ADR 0004).
3. Dogfood: cut sikong v0.1.7 through it (tag → `release.yml` → GitHub Release +
   curl-install assets), as the first real run.
4. Refactor ADR 0016's release stage to delegate here.
