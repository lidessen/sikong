# agent-loop

A unified **agent loop** over multiple backends. One call = one complete agent
loop. Pick a backend — Claude Agent SDK, Codex app-server, Cursor Agent SDK, or
the Vercel AI SDK — and drive all of them through one identical interface: the
same event stream, the same skills / MCP / tools inputs, and the same
cross-backend lifecycle hooks (including mid-run steering).

```ts
import { aiSdkLoop, claudeCodeLoop, codexLoop, cursorLoop } from "agent-loop";
```

Every factory returns the **same** `AgentLoop` interface — the backend is the
only thing that differs. Adapters (and their heavy SDKs) load lazily on first
use, so importing one factory never requires the others' dependencies.

> Status: all backends implemented; typecheck + unit tests green. Live-smoked:
> **ai-sdk (DeepSeek), codex, cursor pass**; claude passes once Anthropic/Claude
> credentials are present.

## Quick start

```ts
import { aiSdkLoop } from "agent-loop";
import { deepseek } from "@ai-sdk/deepseek";

const loop = aiSdkLoop({ model: deepseek("deepseek-chat") });

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

### Other backends — same interface

```ts
import { claudeCodeLoop, codexLoop, cursorLoop, mockLoop } from "agent-loop";

const claude = claudeCodeLoop({ model: "sonnet", permissionMode: "bypassPermissions" });
const codex  = codexLoop({ fullAuto: true, sandbox: "workspace-write" });
const cursor = cursorLoop({});            // CURSOR_API_KEY
const mock   = mockLoop({ response: "hi" }); // in-process, no SDK/network

for await (const ev of codex.run("list the files")) { /* ... */ }
await codex.steer("focus on *.ts only");   // codex steers LIVE mid-turn
```

Every loop exposes: `loop.run(input)`, `loop.capabilities`, `loop.preflight()`,
`loop.dispose()`. `run` returns a `RunHandle`: `AsyncIterable<LoopEvent>` plus
`.result`, `.steer(msg)`, `.cancel()`.

## Skills, MCP, tools

```ts
loop.run({
  prompt,
  skills: [{ name: "reviewer", instructions: "Be terse.", tools: { /* ... */ } }],
  tools: { grep: { description: "...", inputSchema: z.object({ q: z.string() }), execute } },
  mcp: { github: { type: "http", url: "https://...", bearerTokenEnvVar: "GH_TOKEN" } },
});
```

Skills are compiled into the system prompt + merged tools/MCP. Passing a feature
a backend can't do throws `CapabilityNotSupportedError` — agent-loop never
pretends.

## Backend ⇄ capability matrix (as wired & smoke-verified)

| Backend | tools | mcp | hooks (pre-tool) | steer | usage |
| ------- | ----- | --- | ---------------- | -------- | ------- |
| ai-sdk  | ✓     | —   | ✓                | deferred | runtime |
| claude  | ✓     | ✓   | ✓                | deferred | runtime |
| codex   | —     | ✓   | —                | **live** | runtime |
| cursor  | —     | ✓   | —                | —        | estimate |
| mock    | ✓     | ✓   | ✓                | deferred | estimate |

Steering maps to each backend's native mechanism (Codex `turn/steer` = live;
Claude streaming-input, AI SDK `prepareStep` = deferred). Where mid-turn isn't
possible the steer is applied at the next step boundary and reported `deferred`;
if a backend can't steer at all it's reported `rejected`.

## Interactive REPL

A manual test harness for any backend:

```sh
bun scripts/repl.ts ai-sdk            # default; DeepSeek via DEEPSEEK_API_KEY
bun scripts/repl.ts ai-sdk --gateway  # route DeepSeek via Vercel AI Gateway
bun scripts/repl.ts codex
bun scripts/repl.ts claude --model sonnet
```

Type a prompt to run it; stream is printed live. In-REPL commands: `/backend`,
`/model`, `/caps`, `/preflight`, `/tool`, `/steer <msg>`, `/cancel`, `/deny`,
`/help`, `/quit`. While a run streams, a bare line is sent as a steer.

## Design

- **core** — normalized `LoopEvent` stream, `TokenUsage`, capabilities, hooks,
  errors, the public `RunInput` / `RunResult` / `RunHandle` contract.
- **adapter** — the small `BackendAdapter` interface each backend implements;
  translates a native protocol into the normalized stream and exposes a pre-tool
  hook bridge.
- **executor** — the generic spine: compiles skills, gates capabilities, drives
  the unified hook bus off the event stream, routes steer, aggregates the result.
- **factories** (`aiSdkLoop`, …) wrap a lazily-loaded adapter as an `AgentLoop`.

Write a custom backend by implementing `BackendAdapter` and wrapping it with
`makeLoop(id, capabilities, () => Promise<BackendAdapter>)`.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run test        # vitest
bun scripts/smoke-run.ts all   # live smoke (needs creds per backend)
```

## License

MIT
