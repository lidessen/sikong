# Runtime Loop Design

`agent-loop` is the backend-neutral execution layer. One call to
`loop.run(input)` starts one bounded runtime loop and returns a streaming
`RunHandle`.

It does not own workflow state, multi-agent coordination, durable task
acceptance, or long-term memory. Higher layers may use its events and results,
but the loop itself only executes the requested run.

## Main Contracts

### `AgentLoop`

The public runtime handle:

- `id` names the runtime;
- `capabilities` declares what the runtime can support without loading the
  adapter SDK;
- `supports(cap)` gates features synchronously;
- `run(input)` starts one run;
- `preflight()` checks availability;
- `dispose()` releases adapter resources.

Factories such as `aiSdkLoop`, `claudeCodeLoop`, `codexLoop`, `cursorLoop`, and
`mockLoop` all return this same interface.

### `BackendAdapter`

The adapter boundary is intentionally small:

```text
start(ResolvedRequest) -> BackendRun
```

Adapters translate between a native runtime protocol and the normalized
`LoopEvent` stream. They should not own skills, capability policy, result
aggregation, provider selection, or workspace state.

### `RunHandle`

`RunHandle` exposes independent replayable views:

- event iteration for full telemetry;
- `textStream` for assistant text;
- `text`, `usage`, and `result` promises for aggregate views;
- `steer(message)` for live or deferred steering when supported;
- `cancel(reason)` for cooperative cancellation.
- `cleanup(options)` for cooperative, bounded cleanup and settlement facts.

Failures are reported as an `error` event and `result.status === "error"`.
`result` should not reject.

`cleanup` is not a default hard-kill path. The executor requests cancellation,
waits up to the caller's `graceMs`, and returns `settled`,
`cancelled_settled`, or `unsettled`. `hardKill` defaults to `false`; adapters
may implement native cleanup only when they can report real runtime/process
facts. SDK runtimes that do not expose a process id should report a
`pidUnavailableReason`, not fabricate a PID.

### `ModelProvider`

A provider is a credential/endpoint bundle that knows how to configure one or
more runtime types. The provider/runtime compatibility check happens at factory
call time. Unsupported pairs fail explicitly.

Provider data may become child-process environment values, runtime config
overrides, or an in-process AI SDK model spec. It should not mutate
`process.env`.

## Run Lifecycle

```text
RunInput
  -> compile skills into system/tools/MCP
  -> capability gate requested features
  -> lazy-load adapter
  -> adapter.start(ResolvedRequest)
  -> pump BackendRun events
  -> fill hooks, text, usage, context ratio
  -> publish replayable events
  -> resolve RunResult
```

The executor is the common spine. Adapter code should remain runtime-specific
translation code.

## Capability Model

Capabilities are the feature contract between caller and runtime:

- `tools`
- `mcp`
- `hooks`
- `steer.live`
- `steer.deferred`
- `thinking`
- `usage`
- `sessionResume`
- `interrupt`

Factories use static capability lists so callers can gate before heavy SDKs are
loaded. Adapter capability declarations must stay in sync with those static
lists.

## Hooks and Control

Most hooks are observational. `onToolUse` is the control hook: runtimes with the
`hooks` capability call it at their native pre-tool interception point so the
caller can continue, deny, replace arguments, steer, or stop.

Hooks are not a replacement for durable workflow rules. If a rule affects
lasting task state, put it in the workflow reducer/guard layer.

## Task Supervisor

`runTask` is an outer supervisor over multiple fresh `AgentLoop` runs. It uses
tool-based exit commands (`task_complete`, `task_handoff`) and structured
handoffs between rounds.

This is useful for single-agent continuation over context pressure, but it is
not the same as the `sikong` task model. `runTask` owns one transient
goal execution; `sikong` owns durable workflow instances.

## Non-goals

- Owning task lifecycle or workflow state.
- Providing a second durable memory layer.
- Hiding runtime capability differences.
- Mutating runtime tools mid-run unless the native runtime exposes a supported
  steering/control mechanism.
- Treating estimated usage as equivalent to runtime-reported usage.

## Risks to Watch

- Static factory capabilities and adapter capabilities can drift.
- Replayable event collection currently retains all run events in memory.
- Long tool results should become resource references before this layer is used
  for long-running production workloads.
- Runtime/provider libraries can change protocol behavior; live smoke coverage
  should track the supported matrix.
