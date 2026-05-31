# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`agent-loop` is a unified agent-loop library over four backends — Claude Agent
SDK, Codex app-server, Cursor Agent SDK, and the Vercel AI SDK — with **runtime ⊥
provider**: the loop engine (runtime) and the LLM+credentials (provider) are
orthogonal, so one credential can drive any runtime it's compatible with. One
`loop.run(input)` call = one full agent loop. Source is shipped as `.ts` (no build
step; `package.json` points `module`/`exports` straight at `src/`).

## Commands

```sh
bun install
bun run typecheck            # tsc -p tsconfig.json --noEmit  (the real gate)
bun run test                 # vitest run  (runs under bun)
bun run test:watch           # vitest

# single test file / name
bunx vitest run src/test/dx.test.ts
bunx vitest run -t "textStream yields assistant text only"

# live smokes (need creds in the *interactive* shell — see "Credentials")
bun scripts/smoke-provider.ts        # one DeepSeek key across runtimes
bun scripts/smoke-run.ts [all|claude|codex|cursor|ai-sdk]
bun scripts/repl.ts [runtime] [--provider deepseek|...] [--model ...]   # manual REPL
```

There is no lint step and no bundler. `bun run typecheck` + `bun run test` are the
full CI gate. **Verify before committing**: run typecheck/test in a *separate*
step from `git commit` and read the result first — do not batch the verify and the
commit into one parallel tool call (they run independently; the commit will fire
even if the verify fails).

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

## Reference

The original implementation this was extracted from lives at `../agent-worker`
(`internals/loop`, `internals/agent`) — useful when porting adapter behavior.
