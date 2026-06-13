# agent-loop Design

`agent-loop` is a backend-neutral agent runtime facade. It presents one
`AgentLoop` interface over several runtimes while keeping model provider
credentials and endpoint configuration separate from the runtime that executes a
loop.

This document describes the implementation in `src/` as it exists today. The
README is the user-facing API guide; this file is the maintainer-facing design
map.

## Design Goals

- Expose the same run contract for Claude Code, Codex, Cursor, the Vercel AI
  SDK, and tests.
- Keep runtime selection orthogonal to provider selection where the provider can
  actually drive that runtime.
- Keep credentials as per-run or per-adapter data. Provider injection reads
  `process.env` only during provider construction when auto-discovery is
  enabled; it does not mutate `process.env`.
- Normalize backend protocols into a shared `LoopEvent` stream.
- Fail honestly when a runtime/provider or runtime/capability combination is not
  supported.
- Load heavy runtime SDKs lazily so importing one factory does not require every
  backend dependency.

## Non-Goals

- The package does not hide backend-specific escape hatches. Each adapter keeps a
  typed `runtimeOptions` shape for native options that do not belong in the
  common contract.
- The package does not fabricate model metadata. Unknown context windows and
  unknown pricing remain unknown.
- The executor does not implement runtime protocols. Adapters translate native
  SDKs, CLIs, JSON-RPC, MCP, and usage reports into the common interface.

## Public Surface

The root export in `src/index.ts` groups the package into five surfaces:

- Backend factories: `aiSdkLoop`, `claudeCodeLoop`, `codexLoop`, `cursorLoop`,
  and `mockLoop`.
- Providers: `deepseek`, `anthropic`, `openai`, `openaiCompatible`,
  `anthropicCompatible`, `gateway`, and provider/credential helpers.
- Core loop types: `AgentLoop`, `RunInput`, `RunHandle`, `RunResult`,
  `LoopEvent`, `TokenUsage`, `Hooks`, capabilities, tools, MCP, and errors.
- Task layer: `AgentLoop.runTask`, standalone `runTask`, and terminal task
  tools.
- Optional AI SDK tools: workspace-scoped bash/read/write/search/fetch tools and
  sandbox escalation helpers for AI SDK loops.

The root export also exposes advanced authoring contracts:
`BackendAdapter`, `BackendRun`, `ResolvedRequest`, and `makeLoop`.

## Single-Run Architecture

The core path for one run is:

```text
factory options + optional provider
  -> makeLoop(id, capabilities, lazy adapter loader)
  -> AgentLoop.run(input)
  -> startRun(lazy backend, RunInput)
  -> compileRequest(skills + run input)
  -> capability gates
  -> adapter.start(ResolvedRequest)
  -> normalized LoopEvent replay stream
  -> RunResult aggregation
```

The executor in `src/executor/run-handle.ts` owns backend-neutral behavior:

- Compiles skills into `system`, `tools`, and `mcp`.
- Checks capabilities before loading the adapter.
- Creates a replayable broadcast stream for events and text deltas.
- Drives observational hooks from normalized events.
- Bridges `onToolUse` decisions into adapters that support native pre-tool
  interception.
- Routes `steer`, `cancel`, and `cleanup`.
- Aggregates final text, usage, duration, status, events, and error.

Adapters return a `BackendRun`. The executor wraps that native run as a
`RunHandle`. `RunHandle` views are intentionally independent and replayable:
iterating events does not drain `textStream`, and subscribers can attach after
completion. Iteration never throws; failures are represented as an `error` event
and `result.status === "error"`.

## Core Contracts

`AgentLoop` in `src/loop.ts` is the stable runtime facade:

- `id` and `capabilities` describe the runtime.
- `supports(cap)` checks a declared capability without loading the adapter.
- `run(input)` starts one loop and returns immediately with a `RunHandle`.
- `preflight()` asks the adapter to check local dependencies or credentials.
- `dispose()` releases adapter-owned resources.

`RunInput` in `src/core/types.ts` contains everything for one invocation:
prompt, optional system prompt, skills, tools, MCP servers, hooks, max step cap,
abort signal, effort level, runtime-native options, and metadata.

`ResolvedRequest` in `src/core/adapter.ts` is what adapters receive after skill
compilation. Adapters do not see `skills`; they see already-merged `system`,
`tools`, and `mcp`, plus per-run fields such as `maxSteps`, `signal`,
`effort`, `runtimeOptions`, and `metadata`.

## Skills, Tools, and MCP

Skills are prompt/tool/MCP bundles. `compileRequest` appends skill instructions
to the system prompt and merges skill tools/MCP before base run tools/MCP. The
base run wins on key collisions.

Tools use the backend-neutral `ToolDefinition` shape:

- `description`
- `inputSchema` as unknown, so adapters can accept Zod, Standard Schema, or JSON
  Schema where their runtime supports it
- optional `execute(args, ctx)`

`defineTool` keeps runtime shape plain while inferring `execute` argument types
from Standard Schema-compatible inputs.

MCP servers use the normalized `McpServerConfig` shape. Adapters translate it to
their runtime:

- Claude converts MCP configs to Claude Agent SDK `mcpServers`.
- Codex converts MCP configs to `-c mcp_servers.*` CLI overrides and rejects SSE,
  which Codex does not support.
- Cursor converts MCP configs to Cursor SDK MCP settings.
- AI SDK currently consumes custom tools directly, not MCP.

## Capabilities

Capabilities are declared in `src/caps.ts` and mirrored by adapters. They are the
single source used by factories for synchronous gating and by consumers through
`loop.capabilities`.

Important capabilities:

- `tools`: accepts `RunInput.tools`.
- `mcp`: accepts `RunInput.mcp`.
- `hooks`: supports native pre-tool interception, so `onToolUse` can deny or
  replace arguments before execution.
- `steer.live`: can inject a steer message mid-turn.
- `steer.deferred`: can apply steer at the next step boundary.
- `thinking`: emits reasoning/thinking events.
- `usage`: emits usage events during the run.
- `sessionResume`: can resume a previous runtime session.
- `interrupt`: supports mid-run cancellation.

The executor throws `CapabilityNotSupportedError` when tools or MCP are passed
to a runtime that does not declare support. Unsupported provider/runtime pairs
throw `ProviderRuntimeError` at factory-call time.

## Runtime and Provider Separation

Provider code in `src/providers/index.ts` is pure data. It imports no runtime SDKs
and constructs no clients. A `ModelProvider` declares:

- unique `id`
- supported runtimes
- `configureFor(runtime)`, returning a runtime-specific launch config
- optional model pricing lookup

Factory functions resolve providers into adapter options:

- `claudeCodeLoop({ provider })` resolves a `ClaudeRuntimeConfig` and injects
  child-process env plus the provider model.
- `codexLoop({ provider })` resolves a `CodexRuntimeConfig` and injects Codex
  `-c` overrides plus child-process env.
- `aiSdkLoop({ provider })` resolves an `AiSdkRuntimeConfig` and gives the AI SDK
  adapter a lazy model spec.
- Cursor is native-only and takes Cursor credentials directly.

Credential resolution is explicit-first. If auto-discovery is enabled, provider
factories then read conventional environment variables once and bake the value
into provider data. `configureProviders({ autoDiscover: false })` disables that
ambient env lookup for multi-tenant or stateless hosts.

## Adapter Responsibilities

Adapters are intentionally small bridges from native runtime behavior to
`BackendAdapter`.

| Adapter       | Native mechanism                       | Notable behavior                                                                                                                                                                                                   |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mock`        | in-process event channel               | Deterministic test backend for replay, hooks, steer, usage, cancellation, tools, and context pressure.                                                                                                             |
| `ai-sdk`      | `ToolLoopAgent` from `ai` v6           | Builds a `LanguageModel` lazily from provider specs, wraps tools for pre-tool hooks, reports per-step usage, maps deferred steer through `prepareStep`.                                                            |
| `claude-code` | `@anthropic-ai/claude-agent-sdk`       | Exposes tools through an in-process SDK MCP server, maps MCP configs, implements `PreToolUse` hook decisions, streams deferred steer as follow-up user messages, resolves a usable Claude CLI for compiled builds. |
| `codex`       | `codex app-server` over JSON-RPC/stdio | Starts/resumes threads, maps notifications to events, handles approval callbacks and dynamic tool calls, injects live steer with `turn/steer`, manages app-server clients.                                         |
| `cursor`      | `@cursor/sdk`                          | Sends a prompt to a Cursor agent, passes MCP through Cursor config, exposes custom tools through a temporary local HTTP MCP server, estimates usage because Cursor does not report native tokens.                  |

Adapters may expose context-window size when known. The executor uses that to add
`contextWindow` and `usedRatio` to usage events when the adapter did not already
include them.

## Hooks, Steering, Cancellation, and Cleanup

There are two hook classes:

- Observational hooks (`onStart`, `onMessage`, `onThinking`, `onToolResult`,
  `onStep`, `onUsage`, `onEnd`) are driven by the executor from normalized
  events.
- `onToolUse` requires a runtime with the `hooks` capability because it must run
  before the native tool executes.

`onMessage` and `onStep` may return `steer` or `stop` decisions. `onToolUse` may
also return `deny`, `replaceArgs`, or `approve` where the adapter can map those
decisions to the runtime.

Cancellation is cooperative. `cancel()` asks the adapter to stop the native run.
`cleanup()` either delegates to adapter-native cleanup or cancels and waits up to
the requested grace period. A cleanup result may be `settled`,
`cancelled_settled`, or `unsettled`.

## Usage, Context, and Pricing

Usage is normalized as uncached input tokens, output tokens, total tokens, and
optional cache-read/cache-creation fields.

Backends that report usage mark events with `source: "runtime"`. Backends that
do not report usage estimate from text with `source: "estimate"`.

Context windows are resolved in `src/core/context-window.ts`: an explicit
adapter override wins; otherwise known model substrings map to approximate
windows. Unknown models return `undefined` rather than guessed values.

Pricing is provider-owned. `modelPricing` reads the generated LiteLLM snapshot
and uses exact match first, then longest shared prefix. Unknown pricing returns
`undefined`, meaning cost is unavailable rather than zero.

## Task Layer

`src/task/run-task.ts` implements a thin multi-round extension over
`AgentLoop.run`. The primary entrypoint is `loop.runTask({ goal, ... })`; the
standalone `runTask({ goal, loop: () => ... })` helper remains available when a
caller wants to provide a fresh loop factory. The task layer keeps transient
continuation state between rounds, but no task state survives after `runTask`
returns.

Work rounds:

- starts a fresh `loop.run` round from `TaskInput.loop()` or the receiver of
  `loop.runTask`
- inject namespaced task tools
- pass through normal `loop.run` inputs: `system`, `skills`, `tools`, `mcp`,
  `maxSteps`, `signal`, `effort`, `runtimeOptions`, run hooks, and `metadata`
- include the transient task timeline in the prompt
- streams all normalized events through task hooks
- accumulates usage
- disposes factory-created loops after the round when using standalone
  `runTask`; `loop.runTask` keeps the receiver alive

The worker must end each work round by calling one task exit tool:

- `agent_loop_task_continue({ report })` appends `report` to the transient
  timeline and starts the next fresh work loop.
- `agent_loop_task_complete({ report, result? })` claims the task is complete.
- `agent_loop_task_fail({ report })` claims the task failed.

Complete/fail are claims, not final results. They must be reviewed by a gate
loop before `runTask` returns `status: "completed"` or `status: "failed"`.

Gate loops:

- are created with `gateLoop` when supplied, otherwise `loop`
- do not consume work-round budget
- use `gateMaxSteps` only as a safety cap; the default is 50
- can receive tools through `gateTools`, defaulting to the worker `tools`
- inherit the worker MCP servers and run hooks, so the same external tool access
  and permission policy can apply without a second gate-specific configuration
  surface
- are prompted to evaluate only, not to solve, implement, or continue the
  worker's task
- must call `agent_loop_gate_accept({ report })` or
  `agent_loop_gate_reject({ report })`

Gate accept turns the worker's complete/fail claim into the final task result.
The accepted gate report is preserved as `TaskResult.gateReport`. Gate reject
appends a report to the transient timeline and lets the next work round
continue. If the work budget is already exhausted, a rejected finish-only
complete/fail claim returns `status: "budget_exceeded"`.

When the work-round budget is exhausted after `continue` or gate reject,
`runTask` starts one finish-only round. Finish-only mode has no
`agent_loop_task_continue`; it can only call:

- `agent_loop_task_complete({ report, result? })`
- `agent_loop_task_fail({ report })`
- `agent_loop_task_budget_exceeded({ report })`

`report` is required for every task or gate exit tool. There is no public
handoff store, resume protocol, stuck state, or voluntary/forced handoff
distinction. If a worker, finish, or gate loop ends without the required
namespaced exit tool, the task returns `status: "failed"` with a protocol
violation report. Gate startup or runtime failures are also converted into a
failed `TaskResult` instead of rejecting `runTask`.

Durable task persistence is intentionally outside this layer. A higher-level
supervisor can persist task descriptions, prior reports, or timelines and feed
them into a later `runTask` call, but `agent-loop` does not provide a task store
or cross-call resume protocol.

Terminal task and gate tools are absorbing inside a round. The first terminal
tool outcome wins; later terminal calls are acknowledged but ignored. Caller
supplied in-process tools are wrapped so calls after a terminal tool return a
skip result instead of executing side effects. External/native tools that were
already scheduled by the backend cannot be unscheduled by this wrapper, so the
task layer also cancels the active run immediately after the terminal tool:

| Runtime       | Stop mechanism after terminal tool                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `ai-sdk`      | aborts the adapter `AbortController`, which is passed as the AI SDK stream abort signal            |
| `claude-code` | aborts the controller, closes streaming input, and calls SDK query `interrupt` / `close` when live |
| `codex`       | sends `turn/interrupt` to the app-server turn and resolves the local wait                          |
| `cursor`      | aborts the local controller, calls Cursor run `cancel`, and closes the temporary local MCP server  |
| `mock`        | marks the in-process run cancelled                                                                 |

This makes the terminal tool the last meaningful task-layer action. It cannot
guarantee that a backend with parallel native tool calls never starts another
external tool in the same model step; callers that need strict side-effect
isolation should enforce it with backend sandbox or permission policy.

## AI SDK Tools and Sandbox Escalation

`src/tools/ai-sdk.ts` builds an optional `ToolSet` for AI SDK loops:

- sandboxed bash, read, and write tools from `bash-tool` and `just-bash`
- line-window file viewing
- guarded exact replacement and insertion
- ripgrep-backed search
- `web_fetch` with private/local target checks
- `web_search` through Brave when configured

This tool bundle is not the preferred abstraction for every backend. Claude
Code, Codex, and Cursor should keep using their native tool surfaces where
possible; their sandbox, approval, and permission posture belongs in the
adapter layer, mapped to each SDK or CLI's native mechanism. Use
`createAiSdkTools` when the AI SDK runtime needs a comparable local workspace
tool surface, or when a caller explicitly wants this constrained tool bundle.

Sandbox escalation in `src/tools/escalation.ts` is an optional wrapper around the
bash tool. It detects sandbox-constrained toolchain failures, classifies the
command, and retries allowed commands on the real host. Classification is
conservative: build/test/read toolchains are allow-listed, destructive or
outward-facing commands are denied or blocked, and callers may provide a custom
classifier.

## Extension Points

To add a runtime:

1. Implement `BackendAdapter`.
2. Translate native events into `LoopEvent`.
3. Declare capabilities accurately.
4. Add a lazy factory through `makeLoop`.
5. Add tests against the mock/executor contract plus adapter-specific mapping.

To add a provider:

1. Implement `ModelProvider`.
2. Declare only the runtimes it can actually drive.
3. Return plain runtime configs from `configureFor`.
4. Resolve credentials at provider construction time, not during adapter runs.
5. Add compatibility and credential tests.

## Test Coverage

The current test suite covers:

- run handle ergonomics and replay behavior
- executor hooks, steering, cancellation, cleanup, and capability gates
- credential resolution and provider auto-discovery controls
- context-window resolution
- Claude tool schema conversion and DeepSeek cancel-path output estimation
- task continue timeline, gate accept/reject review, task
  completion/failure/budget-exceeded outcomes, finish-only budget closure, and
  protocol-violation failures
- AI SDK tools and sandbox escalation classification

Run package checks with:

```sh
bun --filter agent-loop test
bun --filter agent-loop typecheck
```

The repository aggregate check is:

```sh
bun run check
```
