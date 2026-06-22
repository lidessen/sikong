# Assistant Agent Protocol (ACP)

**Status:** Current (✓) — 2026-06-22
**Governs:** `src/assistant/acp.rs`, external agent integrations
**Layer:** L1 — Command & Interface

---

## Overview

ACP is a JSON-RPC 2.0 protocol over stdio. It is the primary surface for
external agents (Claude Code, Codex, Cursor, custom agents) to invoke
Sikong's assistant layer.

The assistant layer is the only external-facing interface. All capabilities
(task creation, inspection, cancellation, engine execution) are accessed
through natural conversation with the assistant agent.

## Transport

- **Protocol:** JSON-RPC 2.0
- **Transport:** stdin/stdout (one JSON object per line, terminated by `\n`)
- **Startup:** `siko assistant --acp`
- **Stderr:** reserved for logging; external agents should not parse stderr

## Methods

### `initialize`

Initialize the server and get capabilities.

**Request:**
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
```

**Response:**
```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion": 1,
  "agent": {"name": "siko"},
  "capabilities": {
    "sessions": true,
    "prompt": true,
    "cancel": true
  }
}}
```

### `session/new`

Create a new conversation session.

**Request:**
```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}
```

**Response:**
```json
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"session_1"}}
```

### `session/prompt`

Send a user message to the assistant and get a response. The assistant
may create tasks, inspect existing ones, or reply directly.

**Request:**
```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{
  "sessionId": "session_1",
  "prompt": "analyze this project and find bugs"
}}
```

**Response:**
```json
{"jsonrpc":"2.0","id":3,"result":{
  "stopReason": "end_turn",
  "content": [{"type": "text", "text": "Creating task."}],
  "metadata": {"taskId": "019eecc3-..."}
}}
```

The `taskId` in metadata can be used with CLI commands:
- `siko assistant logs <taskId>` — view task lifecycle events (text)
- `siko assistant events <taskId>` — view structured agent-run events
- `siko assistant events <taskId> --json` — raw JSON events

### `session/cancel`

Cancel the currently running task.

**Request:**
```json
{"jsonrpc":"2.0","id":4,"method":"session/cancel","params":{
  "sessionId": "session_1"
}}
```

**Response:**
```json
{"jsonrpc":"2.0","id":4,"result":{
  "cancelled": true,
  "content": [{"type": "text", "text": "Cancelled task ..."}]
}}
```

## CLI Commands

For interactive use or scripting, the CLI provides equivalent access:

```bash
# One-shot prompt (waits for completion)
siko assistant prompt "analyze this project"

# Structured output
siko assistant prompt --json "analyze this project"

# With custom wait time (default 300s)
siko assistant prompt --wait-ms 60000 "analyze this project"

# Inspect task results
siko assistant logs <taskId>
siko assistant events <taskId>
siko assistant events <taskId> --json --operation Execute --event tool_call_start
```

## Integration Example

External agent spawning Sikong as a subprocess (pseudo-code):

```python
import subprocess, json

proc = subprocess.Popen(
    ["siko", "assistant", "--acp"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    text=True
)

def rpc(method, params=None):
    req = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params or {}})
    proc.stdin.write(req + "\n")
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())

# Initialize
rpc("initialize")
rpc("session/new")

# Send task
result = rpc("session/prompt", {"sessionId":"session_1","prompt":"analyze this repo"})
task_id = result["metadata"]["taskId"]

# Read task events
events = subprocess.check_output(["siko","assistant","events",task_id,"--json"])
```

## Architecture

```text
External Agent (Claude Code / Codex / custom)
  │
  ├── spawns: siko assistant --acp
  │         (JSON-RPC over stdio)
  │
  ▼
┌──────────────────────────────────────────┐
│           ACP Server (acp.rs)             │
│  initialize → session/new → session/prompt│
└──────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│        Assistant Session (session.rs)     │
│  • builds context from conversation       │
│  • runs assistant agent with tools:       │
│    - query_messages, create_task          │
│    - inspect_task, cancel_task            │
│    - list_tasks, finish_turn              │
│  • returns reply to caller                │
└──────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│           Task Board (board.rs)           │
│  • queues tasks, manages concurrency      │
│  • spawns engine runs                     │
└──────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│     Recursive Engine (engine.rs)          │
│  Specify → Plan → Execute → Verify → Commit│
└──────────────────────────────────────────┘
```
