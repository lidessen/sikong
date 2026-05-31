# agent-loop

A unified **executor** over multiple agent backends. One call = one complete
agent loop. Bring your own backend — Claude Agent SDK, Codex app-server, Cursor
Agent SDK, or Vercel AI SDK — and drive all of them through one standard
interface: the same event stream, the same skills / MCP / tools inputs, and the
same cross-backend lifecycle hooks (including mid-run steering).

> Status: core + executor + mock backend are implemented and tested. The four
> real backend adapters are being ported from the `agent-worker` reference.

## Why

Every agent SDK has its own loop, its own event shape, its own way of wiring
tools / MCP / hooks. `agent-loop` extracts the *executor* — the generic layer —
so your application code is written once against a stable contract, and the
backend becomes a swappable detail.

## Quick start

```ts
import { createExecutor } from "agent-loop";

const exec = createExecutor("mock", { response: "hi" });

const run = exec.run({
  prompt: "Refactor the auth module",
  system: "You are a senior engineer.",
  hooks: {
    onToolUse: (call) =>
      call.name === "rm" ? { action: "deny", reason: "no destructive ops" } : { action: "continue" },
    onMessage: (m) => console.log("assistant:", m.text),
  },
});

for await (const ev of run) {
  // normalized LoopEvent: text | thinking | tool_call_start | tool_call_end
  //                       | usage | step | steer | hook | error | unknown
}

await run.steer("run the tests before continuing"); // injected mid-loop
const result = await run.result; // { text, usage, durationMs, status, events }
```

With a real backend you pass an adapter instance:

```ts
import { createExecutor } from "agent-loop";
import { ClaudeAdapter } from "agent-loop/adapters/claude";

const exec = createExecutor(new ClaudeAdapter({ model: "sonnet" }));
```

## Design

Three concentric layers:

- **core** — normalized `LoopEvent` stream, `TokenUsage`, capabilities, hooks,
  errors, the public `RunInput` / `RunResult` / `RunHandle` contract.
- **adapter** — the small `BackendAdapter` interface each backend implements.
  Adapters translate a native protocol into the normalized event stream and
  expose native interception points via a hook bridge.
- **executor** — the generic spine: compiles skills, gates capabilities, drives
  the unified hook bus off the event stream, routes steer to each backend's
  native mechanism, and aggregates the result.

### Capabilities, honestly

Adapters declare what they can do (`tools`, `mcp`, `hooks`, `steer.live`,
`steer.deferred`, `thinking`, `usage`, `sessionResume`, `interrupt`). The
executor checks before using a feature and either degrades transparently or
throws `CapabilityNotSupportedError`. Steering maps to the backend's native
mechanism (Codex `turn/steer`, Claude streaming input, AI SDK `prepareStep`,
Cursor follow-up); where mid-turn isn't possible it's applied at the next step
boundary and reported as `deferred`.

### Backend ⇄ capability matrix (target)

| Backend  | tools | mcp | hooks | steer        |
| -------- | ----- | --- | ----- | ------------ |
| claude   | ✓     | ✓   | ✓     | deferred     |
| codex    | (cli) | ✓   | —     | **live**     |
| cursor   | ✓     | ✓   | —     | deferred     |
| ai-sdk   | ✓     | ✓   | ✓     | deferred     |
| mock     | ✓     | ✓   | ✓     | deferred     |

## Development

```sh
bun install
bun run test       # vitest
bun run typecheck  # tsc --noEmit
```

## License

MIT
