# 0038 - ACP (Agent Client Protocol) integration

Status: Proposed

Date: 2026-06-13

Relates: 0001 (stage-scoped subtasks), 0021 (configurable effort level)

## Context

The project already wraps four agent backends (claude-code, codex, cursor, ai-sdk)
behind a unified `BackendAdapter` interface. This gives us runtime ⊥ provider
orthogonality and a common event stream.

As of the Go CLI/daemon migration, `cmd/sikong` and `internal/*` own external
process surfaces, including long-running services. ACP therefore belongs at the
Go process boundary, while prompt execution may still be delegated to a Bun
worker subprocess that imports `agent-loop`.

We want to extend this architecture in two directions:

1. **ACP Server** — expose our agent backends via the Agent Client Protocol
   (JSON-RPC 2.0 over stdio), so external ACP clients (vscode-acp, Zed, Obsidian,
   custom tools) can connect to them. This lets us leverage existing subscriptions
   (codex, cursor, claude-code) from any ACP-compatible editor or orchestrator.

2. **ACP Client** — consume external ACP agents (codex-acp, claude-agent-acp,
   gemini-cli, opencode, etc.) from within sikong. This would let our lead
   dispatch work to external agents as workers. (Recorded as concept only — not
   implemented in this decision.)

ACP (Agent Client Protocol) is a JSON-RPC 2.0 over stdio protocol for coding
agents. Its session lifecycle (initialize → session/new → session/prompt →
session/cancel) maps naturally onto a task-execution model but is orthogonal to
the conversational-chat model that `AgentLoop.run()` implements.

### Design constraints

- **ACP Server must not leak sikong internals.** The server exposes the agent-loop
  layer only. Sikong concepts (workflows, timelines, guards, persistence, wake
  engine) have no ACP counterpart — mapping them would create a non-standard
  protocol extension.
- **Slash commands must align with existing conventions.** Claude Code and Codex
  CLI both use single-word commands where possible and kebab-case (not camelCase
  or snake_case) for multi-word commands.
- **ACP Client is not a loop backend.** An ACP agent is autonomous — it has its
  own loop, its own tools, its own context window. Wrapping it behind
  `BackendAdapter` would produce a capability-honest but nearly empty capability
  list. The correct abstraction is a worker type that sikong dispatches tasks to.

## Decision

### ACP Server — `sikong acp-server`

Build an ACP server that implements the `AgentSideConnection` contract from
`@agentclientprotocol/sdk`. The server is a long-running process that listens on
a configurable port for stdio or TCP connections.

#### Session model

An ACP session maps to **one run/execute** — analogous to a crabbro task or a
sikong workflow task. It is NOT a chat continuation.

- `session/new` — create a run context, select a backend (default or specified
  via `/backend`).
- `session/prompt` — execute one round of work via `loop.run({ prompt })`.
  Each prompt is an independent `run()` call. The previous prompt's result is
  NOT fed back into the next prompt.
- `messages[]` — stored per-session event history for **client display only**.
  Messages are second-class context: they are not injected into `loop.run()`.
  The client uses them to show the user what happened. The user reads them to
  decide what to do next, just as a crabbro user reads the event log before
  sending a steer.
- The session lives as long as the client holds the connection. No persistence
  across server restarts.

#### Backend selection

Each session has exactly one backend at a time. Backends are configured at
startup via a config file / CLI flags:

```sh
sikong acp-server --config backends.yaml

# backends.yaml
backends:
  codex:
    runtime: codex
    provider: openai
    model: gpt-5.1
  claude:
    runtime: claude-code
    provider: deepseek
    model: deepseek-chat
  cursor:
    runtime: cursor
  ai-sdk:
    runtime: ai-sdk
    provider: openai
    model: o4-mini
default: codex
```

- The backend is selected per-session (each session can independently choose).
- **Switching backend while a prompt is running is forbidden.** The server
  rejects `/backend` and `/model` with an error message when `running === true`.
- Switching disposes the current loop and lazily creates the new one on the next
  `session/prompt`.
- Only the backend configuration changes — the session's message history is
  preserved for client display.

#### Slash commands

| Command | Description | When allowed |
|:--------|:------------|:-------------|
| `/backend <name>` | Switch to a named backend | Only when idle (no prompt running) |
| `/model <id>` | Override the model for the current backend | Only when idle |
| `/status` | Show current backend + model + usage | Always |
| `/help` | List available commands and backends | Always |

Commands follow the kebab-case convention used by Claude Code and Codex CLI.
Single-word commands are preferred (`/backend`, `/model`, `/status`, `/help`).

Commands are parsed from the prompt text on each `session/prompt`:
- If the entire prompt is a command (e.g. `/status`), the server handles it
  inline and returns a text response — no `loop.run()` is created.
- If the prompt starts with a command and has additional text (e.g. `/backend
  codex`), the command is handled first, then the remaining text is sent to
  `loop.run()`.
- If the prompt is plain text, it goes straight to `loop.run()`.

#### Event mapping

ACP protocol events → agent-loop `LoopEvent[]`:

| ACP event | agent-loop mapping |
|:----------|:-------------------|
| `session/update` (`agent_message_chunk`) | `text` delta from `run.textStream` |
| `session/update` (`tool_call`) | `tool_use` event |
| `session/update` (`tool_call_update`) | `tool_result` event |
| `session/update` (`usage_update`) | `usage` event |
| `session/update` (`available_commands_update`) | Static list at session start, refreshed on `/backend` |
| `session/prompt` response (`stopReason`) | `result.status` |

The server does not implement `fs/*` or `terminal/*` client methods — those are
the ACP client's responsibility. If the backend agent needs file access, the ACP
client provides it via its own `fs/read_text_file` etc. implementation.

#### What is NOT exposed

- Sikong workflows, task timelines, guards, or persistence
- Sikong's wake engine or state projections
- Sikong's worker/permission modes
- Multi-agent orchestration — the server exposes one backend per session

### ACP Client — recorded concept (not implemented)

The ACP client would be a **sikong worker type**, not a tool and not a loop
backend.

The shape of this idea:

```
sikong lead
  └── create_task(instruction, worker: "acp", config: { command: "npx @zed-industries/codex-acp@latest" })
      └── ACP worker
          └── spawn ACP agent subprocess
          └── send instruction via session/prompt
          └── stream results back as task events
          └── terminate on completion / cancel / timeout
```

Why it is not a loop backend:
- An ACP agent manages its own loop, tools, context window. A loop backend
  implies the executor drives the loop — ACP inverts this.
- The capability list would be nearly empty (no tools/hooks/mcp/steer), creating
  capability-honesty problems.
- The model is "dispatch and collect", not "drive and stream".

Why it is not a tool:
- Tools are agent-invoked — the lead or a worker agent picks them. ACP worker
  dispatch is a lead-level scheduling decision, not an agent-level tool choice.
- The lifecycle (spawn → connect → execute → collect → terminate) fits the
  existing `TaskRunner` abstraction in crabbro's worker pattern.

This concept is recorded for future design. No implementation work.

## Consequences

- **ACP Server is a separate binary surface.** It brings new operational
  concerns: port management, connection lifecycle, auth (if needed), and
  long-running process supervision.
- **No sikong concepts leak.** Protocol boundaries are clean — ACP clients see
  only agent-loop capabilities. Sikong evolves independently.
- **Subscription utilization improves.** Existing codex/cursor/claude-code
  subscriptions become available to any ACP-compatible client (VS Code, Zed,
  Obsidian, etc.).
- **Session model is simple and robust.** No context-window management across
  prompts, no history summarization, no loop reuse. Each prompt is a clean
  run.
- **ACP Client is deferred.** The concept is recorded but the implementation
  decision, API surface, and worker lifecycle design are left for future ADRs.
- **Slash command parsing adds a small inspection step** on each
  `session/prompt` before forwarding to `loop.run()`.

## Implementation Notes

1. **`packages/agent-loop` stays clean.** Add the ACP server in Go under
   `internal/acp/` and expose it through `cmd/sikong acp-server`. The Go server
   owns transport, session lifecycle, and JSON-RPC framing. It delegates actual
   `AgentLoop.run()` execution to a Bun worker subprocess when needed; it does
   not add new adapters or types to `packages/agent-loop`.

2. **Dependency on `@agentclientprotocol/sdk`** goes into `packages/sikong`
   only.

3. **Key files to create:**

   ```
   cmd/sikong/
   └── main.go                ← adds "acp-server" subcommand
   internal/acp/
   ├── server.go              ← transport + JSON-RPC framing
   ├── session.go             ← Session type, lifecycle, backend mgmt
   └── types.go               ← ACP wire types
   packages/sikong/src/
   └── acp-worker.ts          ← Bun worker that runs agent-loop
   ```

4. **Test strategy:**
   - Unit tests for slash command parsing and backend switching logic
   - Integration test: spawn server, connect via `ClientSideConnection`,
     send prompts, verify events
   - Smoke: manual test against vscode-acp or Zed

5. **Config format** uses the same backend-definition shape as existing
   `backends.ts` factories. Each backend entry specifies runtime, provider, and
   model — the server calls the appropriate factory (`codexLoop()`,
   `claudeCodeLoop()`, etc.).

## Open Questions

1. **Transport:** stdio only, or also TCP? The ACP spec supports both. TCP is
   more useful (vscode-acp connects via TCP), but stdio is simpler for
   process-managed scenarios. Likely both: TCP by default, stdio via `--stdio`.
2. **Authentication:** ACP has an `authenticate` method. Optional at first, add
   when needed.
3. **Session persistence:** For now, sessions die with the server. Future ADR
   may add resume via `session/load`.
