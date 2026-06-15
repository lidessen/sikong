# Client Agent

## Purpose

Sikong may be used from a UI that runs a custom `Client Agent`.

The `Client Agent` is not the same thing as Sikong's internal `Task Lead`. It is
the agent embedded in the client experience. It understands the user's daily
multi-project work context and calls typed Sikong tools.

```text
Human
  -> Client UI
    -> Client Agent
      -> Sikong tools
        -> command handlers
          -> Sikong engine
            -> Task Lead / Planner / Worker / Reviewer
```

The CLI is for external agents. The UI-embedded `Client Agent` should use typed
tools instead of shelling out to the CLI.

The client UI exposes Settings as a secondary context view for data-dir-level
runtime defaults:

- Client Agent backend/provider/model;
- Task Lead backend/provider/model;
- Worker backend/provider/model.

These settings are operator defaults, not chat memory and not workspace
preferences. Updating them writes `config.yaml` under the Sikong data dir.
The settings entry stays out of the main chat surface and out of the Context
inspector. On desktop, expose it as a low-priority sidebar footer action that
opens a dedicated settings dialog. Context remains for workspace/task/log
inspection only, so the continuous conversation remains the primary UI.

## Role Names

Use these names consistently:

| Name             | Meaning                                                      |
| ---------------- | ------------------------------------------------------------ |
| `External Agent` | An agent outside Sikong that calls the CLI.                  |
| `Client Agent`   | The UI-embedded agent that calls typed Sikong tools.         |
| `Task Lead`      | Sikong's internal per-task decision owner.                   |
| `Planner`        | Sikong's internal planning worker.                           |
| `Worker`         | Sikong's internal stage execution worker.                    |
| `Reviewer`       | Sikong's internal stage or final review worker.              |
| `Human Operator` | A person supervising, debugging, or steering through the UI. |

## Task Naming

Use `Work Item` in user-facing client UI for the durable coordination object
created inside a workspace. It is the thing the user asks Sikong to complete.

Use `Worker Run` for one concrete execution by a worker through
`agent-loop.runTask`.

The TypeScript command/model layer may keep established names such as
`createTask`, `TaskProjection`, `TaskCompactView`, and `taskId` until a broader
API migration is intentional. Do not introduce a second low-level model name
only for presentation copy.

## Client Interaction Model

The UI should be conversation-shaped as a product surface, but the `Client
Agent` is not a traditional chat-session agent.

Each `Client Agent` turn is a fresh loop over an explicit context packet. The
packet is built from the client work log plus the current workspace/task focus.
The full UI transcript is deliberately not loaded as model context.

There are three separate records:

### UI Transcript

The transcript is presentation state: user messages, client-agent responses,
visible tool calls, task cards, and local UI continuity.

It is not loaded wholesale as model context and is not the source of truth for
task state. The client may persist it for scrollback, but it has no semantic
role in the agent loop.

Transcript rendering should be based on typed message parts, not on free-form
assistant text plus ad-hoc markdown parsing.

```ts
type ClientMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  parts: MessagePart[];
};

type MessagePart =
  | { type: "text"; text: string }
  | { type: "progress-card"; progress: ClientTurnProgress }
  | { type: "task-card"; taskId: string } // rendered as a Work Item card
  | { type: "work-log-summary"; entries: ClientWorkLogEntry[] }
  | { type: "ui"; spec: SikongUISpec };
```

### Turn Stream

Long-running client-agent turns should expose progress through an SSE stream,
not by appending execution logs to the transcript. The stream is a live UI
projection for one turn segment. It is not durable memory by itself.

Initial stream events:

```ts
type TurnStreamEvent =
  | {
      type: "turn.started";
      turnId: string;
      segmentId: string;
      startedAt: string;
      phaseId: "prepare" | "context" | "agent" | "workspace" | "refresh";
      detail?: string;
    }
  | {
      type: "turn.progress";
      turnId: string;
      segmentId: string;
      phaseId: "prepare" | "context" | "agent" | "workspace" | "refresh";
      detail?: string;
      at: string;
    }
  | {
      type: "turn.completed";
      turnId: string;
      segmentId: string;
      response: TurnResponse;
      at: string;
    }
  | {
      type: "turn.error";
      turnId: string;
      segmentId: string;
      message: string;
      at: string;
    };
```

The client renders `turn.started` and `turn.progress` into a temporary
`progress-card`. `turn.completed` replaces that card with the final assistant
message. `turn.error` replaces it with a system error message.

Steer should split a turn into multiple segments instead of mutating one long
progress card forever. The durable control boundary is:

1. `steer.submitted`: a user steer message is queued under the running segment.
2. `turn.checkpoint_reached`: the current segment reaches a safe boundary.
3. `steer.applied`: the steer is folded into the next segment's prompt/context.

Those control events belong to the transcript/control ledger and turn stream.
They do not automatically become client work-log entries.

The `ui` part is optional dynamic content. It is inspired by catalog-based
renderers such as `json-render`, but Sikong should not become a general-purpose
UI generation platform. The client owns a small renderer and maps allowed element
types to native React/shadcn components.

```ts
type SikongUISpec = {
  root: string;
  elements: Record<string, SikongUIElement>;
};

type SikongUIElement = {
  type: string;
  props?: unknown;
  children?: string[];
};
```

The initial catalog should stay deliberately small:

- content: `Text`, `Heading`, `Badge`, `Alert`, `CodeBlock`, `KeyValueList`,
  `Timeline`;
- containers: `Stack`, `Inline`, `Section`, `Card`, `Collapsible`;
- Sikong domain views: `WorkspaceSummary`, `TaskSummary`, `TaskList`,
  `PlanStageList`, `ReviewResult`, `RuntimeProcessList`, `WorkLogList`.

Avoid exposing CSS as protocol. Layout props should be semantic and finite, for
example `direction: "vertical" | "horizontal"`, `gap: "xs" | "sm" | "md"`, and
`density: "compact" | "normal"`. The renderer, not the agent, decides exact
responsive layout and mobile behavior.

Dynamic UI actions must be client intents only:

```ts
type SikongUIAction =
  | { type: "focusWorkspace"; workspaceId: string }
  | { type: "focusTask"; taskId: string }
  | { type: "sendMessage"; text: string }
  | { type: "copyText"; text: string };
```

Do not expose command actions such as `createWorkspace`, `createTask`, event
append, or stage advancement through the dynamic UI spec. Those operations must
continue to go through the `Client Agent` tool surface and Sikong command
handlers.

### Client Work Log

The client work log is the durable cross-workspace context for the `Client
Agent`.

It may contain:

- task summaries;
- cross-project decisions;
- user working preferences;
- active project status;

It should be bounded and curated. Raw task event logs should not be copied into
the client work log.

The work log should record semantic facts that should influence later turns:

- `task_summary`: terminal or action-required task outcomes, compact enough to
  read without replaying task events;
- `decision`: user or lead decisions that change direction, scope, acceptance,
  priority, or constraints;
- `user_preference`: durable operator preferences, including steer messages
  that should apply beyond the current turn;
- `project_status`: current workspace status, next recommended action, or an
  unresolved thread that the user expects Sikong to remember.

The work log should not record:

- SSE progress ticks such as `turn.progress`;
- model token deltas, raw tool stdout/stderr, or full task traces;
- every UI transcript message;
- transient steer lifecycle events unless they resulted in a durable decision
  or preference;
- implementation detail that can be recomputed from task inspection.

For steer, the default rule is: keep the steer message and
`steer.submitted/checkpoint_reached/steer.applied` in the transcript/control
projection; write a work-log entry only when the steer creates a durable
preference or decision. Example: "do not use React for this workspace" is a
`user_preference`; "actually make the button smaller in this run" usually stays
inside the current turn unless the user asks Sikong to remember it.

Candidate entry shape:

```ts
type ClientWorkLogEntry = {
  id: string;
  kind: "task_summary" | "decision" | "user_preference" | "project_status";
  summary: string;
  workspaceId?: string;
  relatedTaskIds?: string[];
  createdAt: string;
};
```

The client work log is outside `WorkspaceDef`. It belongs to the client layer or
local service layer that runs the `Client Agent`.

The default context packet is:

```ts
type ClientAgentContextPacket = {
  policy: {
    transcript: "presentation_only";
    memory: "client_work_log";
    taskEvents: "detail_only";
  };
  focus: { workspaceId?: string; taskId?: string };
  workLog: ClientWorkLogEntry[];
  workspaces: WorkspaceDef[];
  focusedWorkspace?: {
    workspace: WorkspaceDef;
    preferences: WorkspacePreference[];
    taskCards: TaskCompactView[];
  };
  focusedTask?: {
    summary: TaskSummary;
    compact: TaskCompactView;
  };
};
```

The default context scope is global client work log plus the focused workspace
and task summaries. This preserves multi-project continuity without turning the
transcript into memory.

### Task Event Log

The task event log is detailed Sikong work-item telemetry. It is used for
inspect views, work-item cards, reviews, summaries, and debugging.

It does not automatically become `Client Agent` context. Summaries may be
written to the client work log after terminal or action-required task states.

## Visual Direction

The client UI should feel like an operating surface for agent work, closer to a
modern editor shell than a marketing product or a generic chat app.

Use the refreshed VS Code default themes as a reference point: neutral light and
dark foundations, low visual noise, subtle panels, crisp dividers, restrained
selection states, and enough contrast to keep long-running work readable. The
intent is not to clone VS Code, but to borrow the editor-like discipline: dense
when useful, calm by default, and predictable under repeated use.

Practical implications:

- the chat/activity surface stays primary on mobile and desktop;
- sidebars and inspectors should be quiet secondary surfaces, not competing
  dashboards;
- hierarchy should come from spacing, typography, and subtle contrast rather
  than saturated color;
- use cards only for real grouped artifacts, repeated task items, details, or
  generated UI parts;
- avoid decorative gradients, oversized hero treatments, and marketing-style
  composition.

## Workspace Preferences

Workspace preferences are different from the client work log.

They are workspace-scoped project preferences and constraints, such as standard
verification commands, architectural boundaries, generated-file rules, or
operator preferences.

They should be read or maintained deliberately through Sikong tools. They are
not a general-purpose memory stream.

## Tool Surface

The `Client Agent` should call typed tools, not CLI commands.

Initial tools:

```ts
createWorkspace({ id, name })
listWorkspaces()
getWorkspace({ workspaceId })

listWorkspacePreferences({ workspaceId })
addWorkspacePreference({ workspaceId, text, note? })
removeWorkspacePreference({ workspaceId, preferenceId })

createTask({ workspaceId, request, repoPath?, cwd? })
getTask({ workspaceId?, taskId })
listTasks({ workspaceId? })

inspectTaskSummary({ workspaceId?, taskId })
inspectTaskCompact({ workspaceId?, taskId })
inspectTaskTrace({ workspaceId?, taskId })
inspectTaskEvents({ workspaceId?, taskId })
inspectTaskProjection({ workspaceId?, taskId })
waitTask({ workspaceId?, taskId, timeoutMs?, intervalMs? })
```

The tool schemas should be narrow and typed. Tool results should be structured
objects that the UI can render into cards, details, or work-log candidates.
The initial tool adapter is `createClientAgentTools` in
`packages/workspace/src/tools`. It is intentionally a thin wrapper over command
handlers, not a second command implementation.

The local client turn facade is in `packages/workspace/src/client-agent`. It
builds the context packet and runs one `agent-loop.run` turn with the client
tool surface. It does not accept transcript history as input.

Task protocol tools such as plan submission, lead plan acceptance, worker
terminal result submission, and review decisions are role-specific tools for
the Task Lead, planner, worker, and reviewer adapters. They should not be mixed
into the default `Client Agent` surface unless the client agent is explicitly
running one of those roles.

## Wait And Monitor

The client needs two task-following modes:

### Wait

The `Client Agent` waits for a task condition and resumes the current loop with
a compact terminal or action-required summary.

Use this when the user's current request depends on the task result.

`waitTask` is part of the initial client-agent tool surface. It returns at a
caller-visible boundary: terminal, waiting for lead, awaiting worker results, or
blocked.

`steerTask` remains deferred until the runtime process steer command surface is
implemented. Process-level cancel exists in the CLI/daemon path, but task-level
cancel semantics should stay separate from final task acceptance/rejection.

### Monitor

The current client-agent loop ends or moves on. The UI keeps work-item cards
updated, and terminal summaries may be proposed for the client work log.

Use this when the task can continue in the background.

## Boundaries

The `Client Agent` may create and steer Sikong work items, but it should not
mutate low-level task events, manually advance stages, or write worker-run
terminal records.

Sikong owns the internal `Task Lead`, planner, worker, reviewer, event reducer,
and runtime execution.

The client owns transcript rendering, client work-log curation, workspace
switching UX, and mapping tool results into visible work-item cards.
