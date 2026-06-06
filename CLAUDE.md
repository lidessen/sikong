# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **bun-workspaces monorepo** (`sikong-monorepo`, private). Two packages:

- **`packages/agent-loop`** — the unified agent-loop library over four backends —
  Claude Agent SDK, Codex app-server, Cursor Agent SDK, Vercel AI SDK — with
  **runtime ⊥ provider**: the loop engine (runtime) and the LLM+credentials
  (provider) are orthogonal, so one credential can drive any runtime it's
  compatible with. One `loop.run(input)` = one full loop; `runTask` is the outer
  multi-run supervisor on top. This is where ~all the code is.
- **`packages/sikong`** — the coordination layer over `agent-loop`
  for CLI use: workflow tasks, wake engine, JSONL-backed durable stores,
  project/worktree isolation, worker permission modes, CLI, and live smokes.

`agent-loop` ships `.ts` source (`package.json` `module`/`exports` point
straight at `src/`). `sikong` is CLI-only for publishing: `npm` gets the Bun
single-file executable at `dist/sikong`, with `agent-loop` bundled into that
binary. Paths in the Architecture section below are relative to
`packages/agent-loop/src/` unless noted.

## Commands

```sh
bun install                         # at root — links workspaces
bun run build                       # compile packages/sikong/dist/sikong

# root fan-out (the CI gate) — runs the script in every package
bun run typecheck                   # = bun run --filter '*' typecheck
bun run test                        # = bun run --filter '*' test
bun run --filter agent-loop test    # one package

# inside packages/agent-loop (its own scripts):
bun run typecheck                   # tsc -p tsconfig.json --noEmit
bun run test                        # vitest run
bunx vitest run src/test/dx.test.ts                       # single file
bunx vitest run -t "textStream yields assistant text only" # single test

# live smokes — run from packages/agent-loop (creds via the *interactive* shell, see Credentials)
bun scripts/smoke-provider.ts        # one DeepSeek key across runtimes
bun scripts/smoke-run.ts [all|claude|codex|cursor|ai-sdk]
bun scripts/repl.ts [runtime] [--provider deepseek|...] [--model ...]   # manual REPL

# sikong CLI executable
bun run --filter sikong build:cli
packages/sikong/dist/sikong help
```

## Design docs

`design/` is the architectural source of truth for this repository. Read
`design/README.md` for the system shape, then the relevant area document under
`design/areas/` before changing behavior or package boundaries.

Durable shape changes require a design decision in `design/decisions/` before
implementation: module boundaries, state model, protocol/schema semantics,
persistence behavior, scheduling mechanics, runtime contracts, or user-visible
workflow behavior. Keep design docs in English.

There is no lint step and no bundler. `bun run typecheck` + `bun run test` are the
full CI gate. **Verify before committing (hard rule):** a `git commit` must be its
OWN tool batch, sent only after reading a green typecheck/test from a PRIOR batch —
never batch the verify with the commit (they run independently; the commit fires
even if the verify fails). String edits here also fail *silently* (no-op on
mismatch), so after multi-file edits `grep -c` that each change actually landed
before trusting it.

## Agent posture

The agent working from this file is a Sikong project steward, not a general
owner of every repository touched during dogfood. Its attention belongs on:

- the current user goal and the smallest Sikong change that advances it;
- the `design/` source of truth, ADR drift, and whether a behavior change needs a
  new decision record;
- workflow reliability, evidence quality, acceptance boundaries, verification,
  costs, and release readiness;
- dogfood findings that reveal a Sikong mechanism gap.

Its attention does not belong on:

- taking over product direction for a target project unless the task explicitly
  asks for that;
- turning one-off dogfood friction into a new Sikong subsystem;
- hiding unfinished work behind task completion, green summaries, or unreviewed
  worker claims;
- promoting unpublished worktree builds into the local stable or published
  release path.

When dogfood touches other projects, keep the target project's product decisions,
implementation notes, and release notes in that project's own durable docs.
Record only Sikong-relevant findings in this repository: orchestration failures,
worker/tooling friction, verification gaps, cost issues, acceptance decisions, and
release/version lessons.

## Work logs

Human-readable work continuity lives in `development-log/YYYY-MM.md`. The
chronicle and `.sikong/` state are useful evidence, but they are not a substitute
for a durable project work log.

Update the log after meaningful Sikong work, especially after dogfood runs,
behavior changes, release preparation, or repeated failures. Keep entries compact
and append-only. Prefer this shape:

- Target: what was being improved or validated.
- Implementation: what changed.
- Verification: exact checks or dogfood evidence.
- Verifier: who/what judged the result.
- Drift: closer, neutral, or farther from the design target.
- Method feedback: what the run taught about the process.
- Next adjustment: the next bounded follow-up, if any.

For cross-project dogfood, write the detailed work log in the target project when
that project has one, or create `development-log/YYYY-MM.md` there if the work is
substantial and the user has not provided another durable log location. In
Sikong's log, add only the summary needed to preserve Sikong's own continuity and
link it to the dogfood task id, target project, commit, or release candidate.

## Dogfood strategy

Sikong is developed by using Sikong, but dogfood is a gate for behavior changes,
not a ritual for every edit.

Dogfood before treating changes as stable when they affect workflow behavior,
worker selection, verification, release, monitoring, task state, acceptance,
project tooling, or model/cost policy. Documentation-only edits, focused tests,
and small internal cleanups may skip dogfood; state that explicitly.

Default to models individual builders can afford, especially cost-effective paid
open models when suitable. Escalate to frontier models only when evidence shows
the cheaper path is insufficient: repeated failed wakes, repeated blocks, lead
rejection, inability to submit useful evidence, high-risk design review, or final
promotion/release review.

A dogfood run must leave recoverable evidence: task id, chronicle events, command
outputs, changed files, usage/cost when available, and the lead accept/reject
decision. Important findings go to `development-log/YYYY-MM.md`. Repeated
findings or durable behavior changes become tests or ADRs.

Treat failures as signal, not automatic feature requests. One-off failures stay
in the log; repeated or high-risk failures should become a bounded engineering
mechanism, test, or design decision. Do not turn every dogfood failure into a new
subsystem.

### Dogfood version policy

Keep three versions separate:

- **Worktree canary**: the current checkout built as `packages/sikong/dist/sikong`.
  Use it to verify the change under development. Do not make it the default local
  dogfood command until the change is committed, verified, dogfooded, and accepted
  by the lead.
- **Local stable**: the default local dogfood command used for routine Sikong
  project management. It must come from a committed revision with a green full
  gate and at least one accepted real dogfood task.
- **Published release**: the npm/package version. Publish only after the candidate
  has served as local stable on real work without unresolved blocking failures,
  then passed the release gate, build, and package dry run.

Replace local stable only from an accepted commit. Record the source version, git
sha, build time, verification commands, dogfood task id, and lead decision. Prefer
an atomic replacement, such as a versioned binary plus symlink, instead of
overwriting the command in place.

If local stable exposes a serious regression, do not promote a dirty worktree as
the fix. Repair it, commit it, run the full gate, dogfood the fix, get lead
acceptance, then replace local stable.

## Architecture

Three concentric layers; data flows **factory → executor → adapter → backend**,
events flow back up normalized.

- **core/** — backend-agnostic contracts. `events.ts` (`LoopEvent` union — the
  one shape every backend emits), `types.ts` (`RunInput`/`RunResult`/`RunHandle`,
  `ToolDefinition`, `defineTool`), `hooks.ts` (cross-runtime lifecycle hooks),
  `capabilities.ts` (`Capability` union), `provider.ts` (the `ModelProvider` ⊥
  runtime abstraction), `credentials.ts` (`resolveApiKey` + `configureProviders`),
  `channel.ts` (async event channel), `errors.ts`.
- **core/adapter.ts** — the small `BackendAdapter` interface each backend
  implements: `start(req: ResolvedRequest): BackendRun`, plus optional
  `preflight`/`dispose`. `AdapterHookBridge` is how an adapter consults the
  caller's `onToolUse` at its *native* pre-tool interception point.
- **adapters/** — one file per backend (`claude`, `codex`, `cursor`, `ai-sdk`,
  `mock`). Each translates a native protocol ↔ the normalized `LoopEvent` stream.
- **executor/run-handle.ts** — `startRun()`, the generic spine. Compiles skills,
  gates capabilities synchronously, drives the hook bus off the event stream,
  routes steer, aggregates the `RunResult`, and exposes the `RunHandle`. **This is
  the heart of the library** — most behavior that isn't backend-specific lives here.
- **loop.ts** — `AgentLoop` interface + `makeLoop(id, capabilities, load)`: wraps
  a *lazily-loaded* adapter. **backends.ts** — the public factories (`aiSdkLoop`,
  `claudeCodeLoop`, `codexLoop`, `cursorLoop`, `mockLoop`).
- **providers/index.ts** — built-in providers (`deepseek`, `anthropic`, `openai`,
  `openaiCompatible`, `anthropicCompatible`, `gateway`).
- **task/** — the OUTER "ralph" loop over many runs. `run-task.ts` (`runTask()`
  supervisor: fresh run per round, bridged by handoffs; threshold-steer on
  `usedRatio`; terminates completed/exhausted/stuck/cancelled), `exit-tools.ts`
  (`task_complete`/`task_handoff` injected as real tools — the model's choice is
  the round's outcome), `handoff.ts` (`Handoff` + `memoryStore`/`fileStore` for
  resume). Only consumes `AgentLoop`, so rounds can switch runtime/provider;
  needs the `tools` capability (claude-code / ai-sdk), rejects codex/cursor.
- **index.ts** — the public barrel. **caps.ts** — per-runtime capability lists.

### Non-obvious invariants (read before changing core/adapters)

1. **Adapters are configured entirely through `ResolvedRequest` in `start()`.**
   There are NO setter methods (no `setTools`/`setHooks`/...). The constructor
   takes only *construction* options (model, cwd, sandbox); everything about a
   single run (system, prompt, tools, mcp, hooks, `runtimeOptions`) arrives via
   `req`. `runtimeOptions` is the typed per-run escape hatch each adapter casts to
   its own `*RuntimeOptions`.

2. **Capability honesty.** An adapter declares `capabilities`, and the *same* list
   is duplicated in `caps.ts` (so the factory can gate synchronously before the
   SDK loads — keep the two in sync). The executor checks capabilities and throws
   `CapabilityNotSupportedError` rather than silently degrading. Only declare a
   capability you actually wire. `hooks` means *pre-tool interception* specifically
   (`onToolUse` deny/replaceArgs); observational hooks fire on every runtime.

3. **Lazy backend loading.** `makeLoop` imports the adapter module (and its heavy
   SDK) only on first `run`/`preflight`. So `import { aiSdkLoop }` must NOT pull in
   the Claude/Codex/Cursor SDKs. Never add a top-level `import` of a backend SDK
   outside its own `adapters/*.ts`; the ai-sdk adapter even lazy-imports the
   `@ai-sdk/*` provider packages inside `resolveAiSdkModel`.

4. **`RunHandle` is a replay-broadcast.** `run` (events), `run.textStream`,
   `run.text`, `run.usage`, `run.result` are all independent, replayable views —
   consuming one does not drain the others, and you can subscribe after the run
   ends. Iteration NEVER throws: failures surface as an `error` event AND
   `result.status === "error"` (`result.error` set). `result` never rejects.

5. **Provider injection = data, never `process.env`.** A provider's
   `configureFor(runtime)` returns launch config; the factory copies it onto the
   adapter as `providerEnv` / `providerModel` / `providerOverrides` +
   `hasInjectedProvider`. Adapters build a per-spawn child env (spread
   `process.env`, then overlay injected values) and never mutate the parent env —
   so concurrent runs with different keys stay isolated. `claude`: child-env
   `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` (the SDK's
   `Options.env` *replaces* the child env, hence the spread). `codex`: `-c
   model_provider/model/model_providers.*` overrides + key under its `env_key`.
   `ai-sdk`: an in-process `LanguageModel` built from an `AiSdkProviderSpec`.

6. **Model precedence** (highest wins): per-run `runtimeOptions.model` → per-loop
   `model` option → provider default.

7. **`usage` events must set `source: "runtime" | "estimate"`.** Cursor has no
   native token counts → `estimate`; the rest report `runtime`.

### Runtime ⇄ provider compatibility (enforced, not cosmetic)

`deepseek` drives `claude-code` (Anthropic wire) + `ai-sdk`, but **not** `codex`:
codex ≥0.135 requires the OpenAI *Responses* wire and DeepSeek is Chat-only, so
`codexLoop({ provider: deepseek })` throws `ProviderRuntimeError`. Use
`openaiCompatible({ wireApi: "responses", baseURL: <responses-proxy> })` for codex
against a chat-only model. Cursor is native-only (credential is the Cursor cloud
key; no external provider).

### Adding things

- **New runtime**: add `adapters/<rt>.ts` implementing `BackendAdapter`, a caps
  list in `caps.ts`, a factory in `backends.ts` via `makeLoop`, and a `RuntimeType`
  in `core/provider.ts`. Map every native event faithfully to `LoopEvent`.
- **New provider**: add a factory in `providers/index.ts` returning a
  `ModelProvider` — declare `supportedRuntimes` honestly and implement
  `configureFor` for each. Do not touch runtimes.

## Credentials

Keys live in the user's `~/.zshrc`, which is **only loaded by interactive
shells**. Non-interactive tool shells (and CI) won't see them — to exercise live
paths run via `zsh -ic '...'` or expect preflight to report missing creds. Codex
authenticates via `codex login` (`~/.codex/auth.json`), no API key needed. Claude
needs `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` exported for headless use (a
macOS Keychain-only login is NOT readable by the spawned SDK).

Provider `apiKey` is optional: explicit wins, else auto-discovered from the
conventional `<PROVIDER>_API_KEY` env var. Stateless multi-tenant workers call
`configureProviders({ autoDiscover: false })` once to forbid ambient-env reads
and force explicit keys (also gates native-adapter fallbacks, e.g. cursor).

## TypeScript

Strict, `verbatimModuleSyntax` (use `import type` for types),
`noUncheckedIndexedAccess`, `moduleResolution: bundler`, ESM, `noEmit`. Relative
imports are extensionless. Two adapter-authoring escape hatches stay typed-as-data:
`runtimeOptions` and provider specs are cast at the boundary.

## Context-window signal

`usage` events carry optional `contextWindow`/`usedRatio` — the signal the task
supervisor uses to decide when to hand off. `core/context-window.ts`
`resolveContextWindow(modelId, override)` looks up a known-model table by
substring (explicit override wins; unknown → undefined, never guessed); each
adapter exposes it on `BackendRun.contextWindow` and the executor fills the
fields centrally. ai-sdk can only infer it from a provider spec's model id (a raw
`LanguageModel` has no id) — pass `contextWindow` explicitly there. Note
claude/codex self-compact, so `usedRatio` is a hint, not a guarantee.

## Reference

The original implementation this was extracted from lives at `../agent-worker`
(`internals/loop`, `internals/agent`) — useful when porting adapter behavior.
