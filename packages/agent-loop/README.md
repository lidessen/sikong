# agent-loop

A unified **agent loop** over multiple backends, with **runtime ⊥ provider**:

- **Runtime** = the loop engine: Claude Agent SDK, Codex app-server, Cursor Agent
  SDK, or the Vercel AI SDK.
- **Provider** = the LLM + credentials: DeepSeek, Anthropic, OpenAI, any
  OpenAI-/Anthropic-compatible endpoint, or the Vercel AI Gateway.

They're orthogonal. One credential drives every runtime it's compatible with —
the provider knows how to inject itself into each runtime (env vars, CLI config,
or an in-process model), and credentials travel **as data per run** (never via
`process.env`), so workers with different keys run concurrently without clobber.

```ts
import { deepseek, claudeCodeLoop, aiSdkLoop } from "agent-loop";

const provider = deepseek({ apiKey }); // one credential…
claudeCodeLoop({ provider }); // …Claude Code engine, on DeepSeek (Anthropic wire)
aiSdkLoop({ provider }); // …and the AI SDK runtime (in-process)
```

> Status: implemented + verified — typecheck clean, unit tests green. Live-smoked:
> `ai-sdk × deepseek` and `claude-code × deepseek` both return real output;
> `codex × deepseek` is rejected by design (see matrix).

## Quick start

```ts
import { aiSdkLoop, deepseek } from "agent-loop";

const loop = aiSdkLoop({ provider: deepseek({ apiKey: process.env.DEEPSEEK_API_KEY! }) });

const run = loop.run({
  prompt: "Refactor the auth module",
  system: "You are a senior engineer.",
});

// Just want the text? Stream the deltas:
for await (const chunk of run.textStream) process.stdout.write(chunk);

// …or the whole reply when done:
const text = await run.text; // string
```

Every loop — whatever runtime/provider — exposes the same interface:
`loop.run(input)`, `loop.supports(cap)`, `loop.capabilities`, `loop.preflight()`,
`loop.runTask(input)`, and `loop.dispose()`.

## Consuming a run

`run` (a `RunHandle`) gives you several independent, replayable views — pick
whichever fits; consuming one never drains the others, and you can subscribe even
after the run finishes:

```ts
const run = loop.run("explain this repo");

for await (const ev of run) {
  /* every LoopEvent */
} // full event stream
for await (const t of run.textStream) {
  /* string deltas */
} // assistant text only
const text = await run.text; // Promise<string>
const usage = await run.usage; // Promise<TokenUsage>
const result = await run.result; // { text, usage, durationMs, status, events, error? }

await run.steer("run the tests first"); // inject mid-loop -> { mode: live|deferred|rejected }
run.cancel(); // stop the run
```

`LoopEvent` is the normalized union every runtime emits:
`text | thinking | tool_call_start | tool_call_end | usage | step | steer | hook | error | unknown`.

**Iteration never throws.** A failure surfaces as an `error` event _and_
`result.status === "error"` with `result.error` set — so `await run.result` is
always safe to await without a try/catch.

### Hooks vs. events

Two ways to observe a run — use whichever suits:

- **Events / `textStream`** — pull-based, for rendering and consuming output.
- **`hooks`** — push-based callbacks for _control_. Only `onToolUse` can change
  behavior (`deny` / `replaceArgs` a tool call before it runs, or `steer` / `stop`),
  and only on runtimes with the `hooks` capability; the rest (`onMessage`,
  `onToolResult`, `onUsage`, `onStep`, `onEnd`, …) are observational and fire on
  every runtime. Reach for hooks when you need to _intervene_; iterate events when
  you just need to _watch_.

```ts
loop.run({
  prompt,
  hooks: {
    onToolUse: (c) =>
      c.name === "rm" ? { action: "deny", reason: "no destructive ops" } : { action: "continue" },
  },
});
```

## Providers

```ts
import { deepseek, anthropic, openai, openaiCompatible, anthropicCompatible, gateway } from "agent-loop";

deepseek({ apiKey? })                                  // claude-code + ai-sdk
anthropic({ apiKey?, model? })                         // claude-code + ai-sdk
openai({ apiKey?, model? })                            // codex + ai-sdk
openaiCompatible({ id, apiKey?, baseURL, model })      // codex + ai-sdk  (any OpenAI-wire endpoint)
anthropicCompatible({ id, apiKey?, baseURL, model })   // claude-code + ai-sdk
gateway({ apiKey?, model: "deepseek/deepseek-chat" })  // ai-sdk only (Vercel AI Gateway)
```

A provider declares `supportedRuntimes`; pairing it with a runtime it can't drive
throws **`ProviderRuntimeError`** at the factory call — agent-loop never pretends.
For the AI SDK runtime you can also skip providers and pass a constructed
`LanguageModel` directly: `aiSdkLoop({ model })`.

### API keys: auto-discovery + explicit

`apiKey` is **optional**. Resolution is explicit-first, then auto-discovery from
the provider's conventional env var:

```ts
deepseek(); // auto-discovers DEEPSEEK_API_KEY
deepseek({ apiKey }); // explicit wins
// conventional vars: DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY,
// CURSOR_API_KEY, AI_GATEWAY_API_KEY; custom providers use <ID>_API_KEY
// (override with apiKeyEnvVar). A provider with no key throws MissingCredentialError.
```

**Stateless / multi-tenant workers** must not read ambient env (one worker could
inherit another's key). Disable discovery once at startup — then every credential
must be passed explicitly:

```ts
import { configureProviders } from "agent-loop";
configureProviders({ autoDiscover: false }); // deepseek() now throws; deepseek({ apiKey }) still works
```

This switch also gates the native-auth adapters (cursor's `CURSOR_API_KEY`
fallback). Resolution happens once at factory-call time and is baked into the
provider as data, so the rest of the pipeline still injects credentials per-run
and never touches `process.env` again.

### Model precedence

The model id is resolved highest-wins:

1. **per-run** — `loop.run({ runtimeOptions: { model } })` (one call only)
2. **per-loop** — the factory's `model` option (e.g. `claudeCodeLoop({ model })`)
3. **provider default** — e.g. `deepseek({ model })`, else the provider's built-in default

```ts
const loop = claudeCodeLoop({ provider: anthropic({ apiKey }), model: "sonnet" });
loop.run({ prompt, runtimeOptions: { model: "opus" } }); // this run uses opus
```

### Runtime ⇄ provider compatibility

| Provider \ Runtime   | claude-code        | codex         | ai-sdk | cursor |
| -------------------- | ------------------ | ------------- | ------ | ------ |
| deepseek             | ✓ (Anthropic wire) | ✗¹            | ✓      | —      |
| anthropic            | ✓                  | —             | ✓      | —      |
| openai               | —                  | ✓ (Responses) | ✓      | —      |
| openai-compatible    | —                  | ✓             | ✓      | —      |
| anthropic-compatible | ✓                  | —             | ✓      | —      |
| gateway              | —                  | —             | ✓      | —      |
| (cursor native)      | —                  | —             | —      | ✓²     |

¹ codex (≥ 0.135) requires the OpenAI **Responses** wire; DeepSeek serves only
Chat Completions, so a direct codex→DeepSeek link is impossible. Use
`openaiCompatible({ wireApi: "responses", baseURL: <responses-proxy> })`.
² Cursor is native-only: the credential is the Cursor cloud key (`cursorLoop({ apiKey })`),
not an external provider.

## Capabilities, hooks, steering

Adapters declare what they can do (`tools`, `mcp`, `hooks`, `steer.live`,
`steer.deferred`, `thinking`, `usage`, `sessionResume`, `interrupt`); passing a
feature a runtime can't do throws `CapabilityNotSupportedError`. Steering maps to
the runtime's native mechanism — Codex `turn/steer` is **live**; Claude
streaming-input and AI SDK `prepareStep` are **deferred** (applied at the next
step) — and the outcome (`live` / `deferred` / `rejected`) is reported back.

## Skills, MCP, tools

```ts
import { defineTool } from "agent-loop";

const grep = defineTool({
  description: "Search files",
  inputSchema: z.object({ q: z.string() }), // execute args are inferred from this
  execute: ({ q }) => search(q), // ({ q }: { q: string }) — typed, no casts
});

loop.run({
  prompt,
  skills: [
    {
      name: "reviewer",
      instructions: "Be terse.",
      tools: {
        /* ... */
      },
    },
  ],
  tools: { grep },
  mcp: { github: { type: "http", url: "https://...", bearerTokenEnvVar: "GH_TOKEN" } },
});
```

`defineTool` infers `execute`'s argument type from `inputSchema` (any Zod /
Standard Schema). Skills compile into the system prompt + merged tools/MCP. Tools
and MCP require the runtime's `tools` / `mcp` capability (else
`CapabilityNotSupportedError`).

## Interactive REPL

```sh
bun scripts/repl.ts claude --provider deepseek   # Claude Code engine on DeepSeek
bun scripts/repl.ts ai-sdk --provider deepseek
bun scripts/repl.ts ai-sdk --gateway             # DeepSeek via Vercel AI Gateway
bun scripts/repl.ts codex                        # native codex login
bun scripts/repl.ts cursor                       # CURSOR_API_KEY
```

Type a prompt to run it (streamed live). In-REPL: `/runtime`, `/provider`,
`/model`, `/caps`, `/preflight`, `/tool`, `/steer <msg>`, `/cancel`, `/deny`,
`/help`, `/quit`. While a run streams, a bare line is sent as a steer.

## Design

- **core** — normalized `LoopEvent` stream, `TokenUsage`, capabilities, hooks,
  errors, the `RunInput` / `RunResult` / `RunHandle` contract, and the
  `ModelProvider` ⊥ runtime abstraction (`core/provider.ts`).
- **providers** — built-in providers; pure data + per-runtime launch config.
- **adapter** — the small `BackendAdapter` interface each runtime implements.
- **executor** — the generic spine: compiles skills, gates capabilities, drives
  the unified hook bus off the event stream, routes steer, aggregates the result.
- **task** — a thin multi-round extension over `AgentLoop.run`: fresh loops share
  a transient timeline through `agent_loop_task_continue`; `loop.runTask({ goal
})` gates complete/fail claims before final `completed` / `failed`, while
  finish-only mode can end as `budget_exceeded`.
- **AI SDK tools** — optional `createAiSdkTools({ cwd })` helper for AI SDK loops
  that need workspace-scoped bash/read/write/search/fetch tools. Other runtimes
  should prefer their native tool, sandbox, and permission mechanisms through
  their adapters.
- **factories** (`aiSdkLoop`, …) wrap a lazily-loaded adapter as an `AgentLoop`
  and inject the provider's launch config.

Custom runtime: implement `BackendAdapter`, wrap with `makeLoop(id, caps, load)`.
Custom provider: implement `ModelProvider` (declare `supportedRuntimes` +
`configureFor`).

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run test        # vitest
bun scripts/smoke-provider.ts   # live: one DeepSeek key across runtimes
```

## License

MIT
