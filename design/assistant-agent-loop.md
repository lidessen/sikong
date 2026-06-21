# Assistant Agent Loop

This document defines the Rust assistant agent loop for the new Sikong
mainline. Memory/KB is intentionally out of scope until its protocol is stable.

## Goal

The assistant is the user-facing coordinator. It should be able to process user
messages, decide whether to answer directly, and use optional packs such as the
task board when the host injects them.

The assistant does not execute recursive engine node work directly. It chooses
assistant-level tools and finishes the turn with a terminal tool result.

## Ownership Boundary

Rust owns business context:

- assistant context packet construction;
- prompt sections;
- available assistant tools;
- assistant pack injection;
- terminal tool decoding;
- applying assistant tool calls to Sikong state.

Bun owns only the runtime bridge:

- receive a generic `AgentRunRequest`;
- register the supplied tool schemas;
- run the configured `agent-loop` backend;
- stop when the backend observes a tool in `terminalToolSet`;
- return the observed tool calls and terminal call.

Bun must not inspect assistant/task/engine business semantics. It may perform
mechanical protocol formatting, but it must not decide which business tools are
available or add domain prompt policy.

## Assistant Pack Injection

Assistant prompt and tools are dynamic. The agent does not decide whether a
capability is available; the Rust harness decides which packs to mount before
building the run request.

The target shape is:

```rust
trait AssistantPack {
    fn id(&self) -> &'static str;
    fn context_fragment(&self, context: &AssistantContext) -> Option<(String, JsonValue)>;
    fn prompt_sections(&self) -> Vec<AgentPromptSection>;
    fn tool_specs(&self) -> Vec<AgentToolSpec>;
    fn apply_tool_call(&mut self, call: &AgentToolCall) -> AssistantApplyResult;
}
```

The current implementation keeps the first version deliberately static:
`AssistantPackSet` selects from a small enum of built-in packs. That gives the
same runtime behavior as a plugin registry without introducing dynamic loading
before there is more than one real external pack.

The core assistant pack always provides:

- `query_messages`;
- `finish_turn`.

The core pack also carries conversation access in two layers:

- `Latest Message` is added as an explicit prompt section for the current turn;
- `Recent Conversation` is added as a small prompt section when prior messages
  exist;
- `current_message` is included in the structured input packet;
- `query_messages` is declared as a schema-defined tool for inspecting older
  session messages when the prompt window is insufficient.

This is session-local operational context, not long-term memory or KB. Previous
conversation is a UI/coordination record; task and workspace stores remain
authoritative for project facts.

The task-board pack optionally provides:

- a `task_board` context packet fragment;
- a task-board prompt section;
- `list_tasks`;
- `inspect_task`;
- `create_task`;
- `cancel_task`;
- post-turn application of those calls to `TaskBoard`.

When the task board is disabled, task tools are omitted from the run request.
The assistant may still answer directly, but it cannot call task tools because
they do not exist in the run.

Prompt construction follows the same model. The harness concatenates prompt
sections from mounted packs, then appends the generic completion section. Bun
does not add business instructions; it only renders the supplied sections into a
backend-compatible message.

## Real Agent Loop

The real assistant path uses:

```text
AssistantContext
  -> AssistantHarness builds AgentRunRequest
  -> ProcessAgentRunScheduler starts @sikong/agent-host
  -> agent-host runs agent-loop with provider kimi
  -> agent-loop returns tool calls + terminal call
  -> Rust decodes finish_turn
  -> Rust applies non-terminal assistant tool calls
```

`terminalToolSet` is a generic `agent-loop` run field. It is not a business
feature. A backend may stop after a terminal tool's normal executor returns.

Tool execution in `agent-host` is intentionally generic. The host registers each
tool from its JSON schema, records the observed call, and returns a mechanical
acknowledgement to the model. It must not branch on tool names or encode
assistant/task-board behavior. Tools that need real data, such as
`query_messages`, should be backed by Rust-owned tool callbacks in a future
transport slice rather than host-side name matching.

## Agent-To-Agent Evaluation

The evaluation method should mirror skill testing:

1. A scripted driver sends a sequence of user messages to the assistant under
   test.
2. The assistant produces a transcript: user messages, assistant replies,
   injected tools, observed tool calls, terminal calls, and state deltas.
3. A separate judge agent receives the transcript plus a rubric and returns a
   strict JSON evaluation.

Example scenario:

```yaml
name: direct-no-task-board
capabilities: [core]
steps:
  - user: "Explain your role in one sentence."
expect:
  no_task_created: true
  required_text:
    - "assistant"
  forbidden_tool_calls:
    - create_task
judge:
  rubric:
    - Did the assistant answer the user directly?
    - Did it avoid claiming task-board actions?
    - Did it finish with the terminal assistant tool?
```

Judge output:

```json
{
  "passed": true,
  "findings": [],
  "evidence": ["finish_turn called", "no task tools injected"]
}
```

The deterministic test layer checks protocol facts such as injected tools and
state deltas. The agent judge checks interaction quality. A live Kimi smoke test
is opt-in because it depends on credentials, network, and model behavior.

## Test Tiers

1. Deterministic harness tests:
   - task-board disabled means only core tools are injected;
   - task-board enabled injects task tools;
   - latest message, Recent Conversation, and conversation tools are available
     to later turns;
   - malformed terminal results fail closed.

2. Host-backed mock tests:
   - Rust talks to `@sikong/agent-host` over Unix socket;
   - mock loop returns deterministic terminal calls.

3. Live Kimi smoke tests:
   - opt-in with `SIKONG_RUN_LIVE_AGENT_TESTS=1`;
   - uses `KIMI_CODE_API_KEY`;
   - verifies the real loop can finish an assistant turn without task board.

4. Agent-to-agent quality evaluations:
   - scripted user-message sequences;
   - transcript capture;
   - separate judge agent with strict JSON result;
   - used for regression signal, not as the only correctness gate.
