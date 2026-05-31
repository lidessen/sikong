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

const provider = deepseek({ apiKey });   // one credential…
claudeCodeLoop({ provider });            // …Claude Code engine, on DeepSeek (Anthropic wire)
aiSdkLoop({ provider });                 // …and the AI SDK runtime (in-process)
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
  hooks: {
    onToolUse: (call) =>
      call.name === "rm" ? { action: "deny", reason: "no destructive ops" } : { action: "continue" },
    onMessage: (m) => process.stdout.write(m.text),
  },
});

for await (const ev of run) {
  // normalized LoopEvent: text | thinking | tool_call_start | tool_call_end
  //                       | usage | step | steer | hook | error | unknown
}

await run.steer("run the tests before continuing"); // injected mid-loop
const result = await run.result; // { text, usage, durationMs, status, events }
```

Every loop — whatever runtime/provider — exposes the same interface:
`loop.run(input)`, `loop.capabilities`, `loop.preflight()`, `loop.dispose()`.
`run` returns a `RunHandle`: `AsyncIterable<LoopEvent>` plus `.result`,
`.steer(msg)`, `.cancel()`.

## Providers

```ts
import { deepseek, anthropic, openai, openaiCompatible, anthropicCompatible, gateway } from "agent-loop";

deepseek({ apiKey })                                   // claude-code + ai-sdk
anthropic({ apiKey, model? })                          // claude-code + ai-sdk
openai({ apiKey, model? })                             // codex + ai-sdk
openaiCompatible({ id, apiKey, baseURL, model })       // codex + ai-sdk  (any OpenAI-wire endpoint)
anthropicCompatible({ id, apiKey, baseURL, model })    // claude-code + ai-sdk
gateway({ apiKey?, model: "deepseek/deepseek-chat" })  // ai-sdk only (Vercel AI Gateway)
```

A provider declares `supportedRuntimes`; pairing it with a runtime it can't drive
throws **`ProviderRuntimeError`** at the factory call — agent-loop never pretends.
For the AI SDK runtime you can also skip providers and pass a constructed
`LanguageModel` directly: `aiSdkLoop({ model })`.

### Runtime ⇄ provider compatibility

| Provider \ Runtime | claude-code | codex | ai-sdk | cursor |
| ------------------ | ----------- | ----- | ------ | ------ |
| deepseek           | ✓ (Anthropic wire) | ✗¹ | ✓ | — |
| anthropic          | ✓ | — | ✓ | — |
| openai             | — | ✓ (Responses) | ✓ | — |
| openai-compatible  | — | ✓ | ✓ | — |
| anthropic-compatible | ✓ | — | ✓ | — |
| gateway            | — | — | ✓ | — |
| (cursor native)    | — | — | — | ✓² |

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
loop.run({
  prompt,
  skills: [{ name: "reviewer", instructions: "Be terse.", tools: { /* ... */ } }],
  tools: { grep: { description: "...", inputSchema: z.object({ q: z.string() }), execute } },
  mcp: { github: { type: "http", url: "https://...", bearerTokenEnvVar: "GH_TOKEN" } },
});
```

Skills compile into the system prompt + merged tools/MCP.

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
