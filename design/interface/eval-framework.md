# Eval Framework

**Status:** Current (✓) — 2026-06-22

**Governs:** `src/cli.rs` eval commands, `evals/task-run/*.yaml`, `design/recursive-agent-engine.md` §Live Eval Mode

**Layer:** L1 — Command & Interface

---

## Purpose

The eval framework is the live evaluation system for Sikong's recursive task-run engine.
It runs real agent-loop scenarios against the current engine, captures transcripts,
and independently judges whether the engine chose an appropriate execution shape.

Eval scenarios are the primary mechanism for:

- **Live regression testing** — do engine changes break realistic task execution?
- **Dogfood self-development** — run real Sikong work through the engine and inspect
  the outcome before deciding the next improvement.
- **Operation-level isolation** — test one operation harness (`Specify`, `Plan`,
  `Execute`, `Combine`, `Verify`) in isolation before running a full task.

Eval is not a Rust unit test. It is an explicit live mode that spends model tokens,
depends on credentials (`KIMI_CODE_API_KEY`, `DEEPSEEK_API_KEY`, etc.), and is
judged probabilistically rather than by deterministic assertion.

---

## Architecture

```text
                         ┌─────────────────────────┐
                         │    YAML Scenario File    │
                         │  (id, task, expectation, │
                         │   workspace)             │
                         └───────────┬─────────────┘
                                     │ loaded by
                                     ▼
                         ┌─────────────────────────┐
                         │   Eval CLI (cli.rs)      │
                         │  select_scenarios()      │
                         │  resolve_agent_loop()    │
                         └───────────┬─────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
              ▼                      ▼                      ▼
   ┌──────────────────┐  ┌────────────────────┐  ┌──────────────────┐
   │  TaskRunSplitEval │  │TaskRunOperationEval│  │   DogfoodRun     │
   │  (full task run)  │  │(single operation)  │  │(full + dev-log)  │
   └────────┬─────────┘  └────────┬───────────┘  └────────┬─────────┘
            │                     │                        │
            ▼                     ▼                        ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                    Engine (root task)                        │
   │  Engine::new(Workspaces, ProcessAgentRunScheduler)           │
   │  insert_root(NodeTemplate) → engine.run(root) → Report       │
   └─────────────────────────┬───────────────────────────────────┘
                             │
                             ▼
   ┌─────────────────────────────────────────────────────────────┐
   │              Transcript Builder                               │
   │  TaskRunSplitTranscript::from_engine(scenario, root,          │
   │     &engine, &report)                                         │
   │  → scenario metadata, root children, agent runs, events      │
   └─────────────────────────┬───────────────────────────────────┘
                             │
                             ▼
   ┌─────────────────────────────────────────────────────────────┐
   │              Independent Judge Agent                          │
   │  ProcessAgentRunScheduler::run(judge_request(transcript))    │
   │  → must call finish_eval(passed, findings, evidence)         │
   └─────────────────────────┬───────────────────────────────────┘
                             │
                             ▼
   ┌─────────────────────────────────────────────────────────────┐
   │              Eval Result                                      │
   │  TaskRunSplitJudgement { passed, findings, evidence }        │
   │  → stdout report or JSON output                              │
   └─────────────────────────────────────────────────────────────┘
```

---

## YAML Scenario Format

Scenarios are defined either as **built-in Rust structs** in `src/cli.rs` or as
**external YAML files** in `evals/task-run/`. The YAML format is:

```yaml
# evals/task-run/dogfood-doc-review.yaml
id: dogfood-doc-review
task: |
  Review design/dogfood.md in the current Sikong repository.
  Compare it against design/recursive-agent-engine.md,
  design/prompt-guidance.md, design/assistant-agent-loop.md, and the current
  task-run implementation surface.
  Identify whether the dogfood design is coherent...
  Produce a concise review report with concrete file or section evidence. Do
  not modify files.
expectation: |
  This is a realistic design review task over the current filesystem workspace.
  Passing requires a concrete review grounded in design/dogfood.md, related design
  documents, and task-run implementation paths...
workspace:
  provider: current-file-system
  read_scope:
    - design/**/*.md
    - src/task_run/**/*.rs
    - src/agent_run/**/*.rs
    - src/assistant/**/*.rs
    - AGENTS.md
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique scenario identifier. Used for CLI selection and artifact directory naming. |
| `task` | string | Natural task request sent to the engine. No decomposition hints — the engine must decide the execution shape. |
| `expectation` | string | Judge rubric. Describes what a passing run looks like, including constraints on decomposition, evidence sourcing, and artifact quality. |
| `workspace` | object | Workspace configuration (see below). |

### Workspace Object

```yaml
workspace:
  provider: current-file-system    # memory | current-file-system | current-git
  read_scope:                      # globs for readable paths
    - design/**/*.md
  write_scope:                     # globs for writable paths (optional)
    - design/
  allow_write: false               # required for write_scope to take effect
```

---

## Workspace Types

Three workspace providers are available for eval scenarios:

### `memory`

An ephemeral workspace with no real filesystem access. The agent can produce text
artifacts but cannot read or write actual files. Used for:

- Simple answer tasks (`simple-qa`)
- Self-contained design analysis (`design-analysis`)
- Static application concepts (`small-app`)
- Developer preview readiness packages (`preview-runtime`)

```yaml
workspace:
  provider: memory
```

`read_scope` must not be defined for memory workspaces.

### `current-file-system`

Reads and optionally writes to the current filesystem, restricted by glob patterns.
The workspace is the actual working directory; no git worktree is created.

```yaml
workspace:
  provider: current-file-system
  read_scope:
    - design/**/*.md
    - src/**/*.rs
  # Optional write access:
  write_scope:
    - design/
  allow_write: true
```

Used for design reviews, code inspection, and document creation tasks that need
real file access but don't need git isolation.

### `current-git`

Creates a temporary git worktree from the current repository HEAD for the agent
to operate in. Provides full git isolation for read-only or write-scoped tasks.

```yaml
workspace:
  provider: current-git
  read_scope:
    - src/**/*.rs
    - design/**/*.md
  write_scope:
    - design/
```

The worktree is created at a temp path:
`/tmp/siko-live-eval-worktrees/<pid>-<scenario-id>/`

Used for repository analysis tasks (`sikong-project-analysis`,
`sikong-redundancy-audit`) that need real file evidence.

---

## Route-Only vs Full Execution

Both eval commands and the dogfood run support a `--route-only` flag.

### Full Execution (default)

```text
Specify → (optionally Plan → children → Combine) → Verify → Commit
```

The engine runs the full task lifecycle. For broad tasks, this means:
1. The root node runs `Specify` to assess scope.
2. If scope is `large`/`xlarge`, the engine runs `Plan` to create child groups.
3. Children execute in workspace isolation.
4. The engine `Combine`s child artifacts.
5. The engine `Verify`s the combined result.
6. The engine `Commit`s if verified.

For simple tasks, the engine may skip `Plan` and execute directly.

### Route-Only Mode

```text
Specify → Plan (stops here)
```

When `--route-only` is set, the engine stops after the root route decision
(equivalent to `with_stop_after_route_depth(0)`). The final status will be
`Planned` with child nodes but no execution has occurred.

Use route-only mode for:
- **Cheap routing validation** — verify that the engine selects the right
  execution shape without spending model tokens on execution.
- **Scenario iteration** — test whether a new scenario produces the expected
  plan without running the full eval.

Implementation:

```rust
if route_only {
    engine = engine.with_stop_after_route_depth(0);
}
```

---

## Judge Protocol

Each eval run is judged by an independent agent-loop agent. The judge receives
the full transcript and must call the `finish_eval` terminal tool.

### Tool Specification

```rust
fn eval_judgement_tool_spec() -> AgentToolSpec {
    AgentToolSpec {
        name: "finish_eval",
        description: "Submit the evaluation judgement.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "passed": { "type": "boolean" },
                "findings": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "evidence": {
                    "type": "array",
                    "items": { "type": "string" }
                }
            },
            "required": ["passed", "findings", "evidence"],
            "additionalProperties": false
        }),
    }
}
```

### Judge Response

The judge must call `finish_eval` with:

| Field | Type | Description |
|-------|------|-------------|
| `passed` | boolean | Whether the scenario passed. |
| `findings` | string[] | Concise finding descriptions (e.g., "Engine did not decompose broad task"). |
| `evidence` | string[] | Supporting evidence strings (e.g., "Status is Committed with no child nodes"). |

If the judge fails to call `finish_eval`, the eval records a protocol failure:
```
"judge did not call finish_eval"
```

### Judge Prompt Structure

The judge prompt has four sections:

1. **Role** — "You are an independent evaluator for a recursive task-run engine."
2. **Evaluation Context** — The full transcript rendered as JSON.
3. **Rubric** — Rules for passing, including:
   - Simple tasks should remain atomic (no unnecessary decomposition).
   - Broad tasks must show real Specify decisions, Plan operations, and child nodes.
   - Git-backed scenarios require concrete repository evidence (file paths, module names).
   - Child nodes must be relevant, not trivial copies.
   - Penalize skipped phases, weak artifacts, protocol failures.
4. **Output** — "You must finish by calling the finish_eval tool..."

---

## Transcript Format

The transcript is a structured JSON object produced after each task run:

```json
{
  "scenario": "preview-runtime",
  "task": "Prepare a developer-preview readiness package...",
  "expectation": "This is a broad product-engineering task...",
  "workspace": "memory",
  "root": 1,
  "status": "Committed",
  "artifact": 3,
  "root_children": [
    {
      "id": 2,
      "key": "child-key",
      "intent": "Review launch/configuration",
      "plan": "Execute",
      "read_scope": [],
      "write_scope": []
    }
  ],
  "agent_runs": [
    {
      "node_id": 1,
      "operation": "Specify",
      "terminal_tool": "submit_specification",
      "terminal_payload": { "next": "...", "size": "Large" },
      "duration_ms": 15234,
      "usage": { "input_tokens": 4500, "output_tokens": 1200 },
      "report": "specified as broad preparation work..."
    }
  ],
  "events": [
    {
      "node_id": 1,
      "operation": "Specify",
      "note": "starting agent run"
    }
  ]
}
```

### Key Structures

#### `TaskRunSplitTranscript`

| Field | Description |
|-------|-------------|
| `scenario` | Scenario identifier from the eval definition. |
| `task` | The original task prompt. |
| `expectation` | The judge rubric for this scenario. |
| `workspace` | Workspace type label (`memory`, `current-file-system`, `current-git`). |
| `root` | Root node ID in the engine. |
| `status` | Final engine status (`Committed`, `Planned`, `Failed`, etc.). |
| `artifact` | Final artifact ID, if one was produced. |
| `root_children` | Children of the root node (id, key, intent, plan, read/write scope). |
| `agent_runs` | All agent-loop runs with timing, tools, and usage. |
| `events` | Engine events with node_id, operation, and note. |

#### `TaskRunSplitAgentRun`

| Field | Description |
|-------|-------------|
| `node_id` | The engine node this run served. |
| `operation` | The operation (`Specify`, `Plan`, `Execute`, `Combine`, `Verify`). |
| `terminal_tool` | The terminal tool that ended the agent loop. |
| `terminal_payload` | Summarized tool arguments (long strings truncated to 2000 chars). |
| `duration_ms` | Wall-clock duration of the agent loop run. |
| `usage` | Token usage (input, output, cache, total). |
| `report` | The raw report text from the agent loop. |

---

## Artifact Capture & Review Workflow

When `--artifact-dir <path>` is specified, the eval writes human-readable artifact
files to disk for review.

### Artifact Directory Layout

```
<artifact-dir>/
  └── <sanitized-scenario-id>/
      ├── final-artifact-<id>.md        # Root accepted artifact
      ├── artifact-<id>-node-<nid>.md   # Child accepted artifacts
      └── ...
```

Git status tracking and CI have all filename components
sanitized (non-alphanumeric characters replaced with `-`, leading/trailing `-`
trimmed).

### Artifact Collection

The engine collects accepted artifacts from the root node and all child nodes:

```rust
fn collect_accepted_artifact_ids(node_id, engine, &mut artifact_ids) {
    for child in node.children {
        collect_accepted_artifact_ids(child, engine, artifact_ids)
    }
    if node.accepted_artifact exists: push to list
}
```

### Artifact File Format

```markdown
# Task Run Artifact

scenario: preview-runtime
status: Committed
artifact_id: 3
node_id: 1

---

<artifact text content>
```

---

## Creating and Running New Evals

### Built-in Scenarios

To add a built-in scenario, extend `task_run_split_eval_scenarios()` in
`src/cli.rs`:

```rust
fn task_run_split_eval_scenarios() -> Vec<TaskRunSplitScenario> {
    vec![
        TaskRunSplitScenario {
            id: "my-new-scenario",
            task: "Natural task request...",
            expectation: "Judge rubric...",
            workspace: TaskRunSplitWorkspace::Memory,
        },
        // ...
    ]
}
```

### External YAML Scenarios

Create a new YAML file in `evals/task-run/`:

```yaml
id: my-scenario
task: |
  Describe the task in natural language.
expectation: |
  Describe what a passing run looks like.
workspace:
  provider: current-file-system
  read_scope:
    - src/**/*.rs
```

Then reference it with `--scenario-file`:

```bash
cargo run -- eval task-run-split \
  --scenario-file evals/task-run/my-scenario.yaml \
  --artifact-dir /tmp/siko-artifacts --json
```

For dogfood runs (which write to the development log), use `dogfood run`:

```bash
cargo run -- dogfood run \
  --scenario-file evals/task-run/my-scenario.yaml \
  --artifact-dir /tmp/siko-artifacts --log --json
```

### Best Practices

1. **Write a specific expectation.** The judge uses this as the rubric. Vague
   expectations produce unreliable passing/failing results.
2. **Set appropriate workspace and read_scope.** Memory-only tasks are cheaper but
   the agent cannot reference real files. Git-backed tasks provide real evidence.
3. **Test with `--route-only` first.** Verify the engine routes your scenario
   correctly before spending tokens on full execution.
4. **Set `allow_write: true` and `write_scope` when files should be modified.**
   Without these, the agent runs in read-only mode.
5. **Use `--artifact-dir` for human review.** The artifact files show exactly
   what the engine produced at each stage.

---

## Eval CLI Commands

### `eval task-run-split`

Run one or more scenarios through the full task engine and judge the result.

```bash
# Default scenario (preview-runtime)
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval task-run-split

# Named scenario
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval task-run-split --scenario simple-qa

# All built-in scenarios
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval task-run-split --scenario all

# Custom task (creates one-off "custom" scenario)
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval task-run-split --task "Review the CLI"

# External YAML file
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval task-run-split \
  --scenario-file evals/task-run/dogfood-doc-review.yaml \
  --artifact-dir /tmp/siko-artifacts --json

# Route-only mode (stops after Plan)
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval task-run-split \
  --scenario sikong-project-analysis --route-only
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--task` | Natural task request (creates a custom scenario). |
| `--scenario` | Scenario ID or `all` (default: `preview-runtime`). |
| `--scenario-file` | External YAML scenario file path. |
| `--artifact-dir` | Directory to write task-run artifacts for review. |
| `--route-only` | Stop after root route decision (no execution). |
| `--json` | Print full structured JSON output. |

**Selection logic:**

1. If `--scenario-file` is given, load that file (cannot combine with `--task` or `--scenario`).
2. If `--task` is given, create a one-off `"custom"` scenario with memory workspace.
3. Otherwise, filter built-in scenarios by `--scenario` (default: `"preview-runtime"`).

**Runtime profile:** Each scenario gets `actor_max_steps()` steps (24 for memory,
32 for file-system/git), and the judge gets 6 steps.

### `eval task-run-operation`

Evaluate one engine operation in isolation, without running the full task lifecycle.

```bash
# One operation scenario
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval task-run-operation \
  --operation specify --scenario execute --json

# All scenarios for one operation
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval task-run-operation \
  --operation plan --scenario all

# Full operation matrix (spends model calls)
SIKONG_RUN_LIVE_AGENT_TESTS=1 cargo run -- eval task-run-operation \
  --operation all --scenario all
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--operation` | Operation name (`specify`, `plan`, `execute`, `combine`, `verify`) or `all`. |
| `--scenario` | Scenario ID or `all`. |
| `--json` | Print full structured JSON output. |

**Operation scenarios:**

| Operation | Scenarios |
|-----------|-----------|
| `Specify` | `execute`, `split`, `coherent-medium`, `independent-evidence-surfaces`, `git-redundancy-audit-surfaces`, `evidence-work` |
| `Plan` | `stage`, `parallel`, `git-parallel-scoped` |
| `Execute` | `simple-result`, `blocked-files` |
| `Combine` | `normal`, `conflict` |
| `Verify` | `accept`, `reject`, `uncertain` |

### `dogfood run`

Identical to `eval task-run-split` but adds development-log recording and is
intended for self-development iteration.

```bash
cargo run -- dogfood run --scenario simple-qa --log
cargo run -- dogfood run --scenario-file evals/task-run/dogfood-doc-review.yaml \
  --artifact-dir /tmp/siko-artifacts --log --json
```

**Additional flags (on top of `eval task-run-split` flags):**

| Flag | Description |
|------|-------------|
| `--log` | Write the outcome to `development-log/YYYY-MM-DD.md`. |

### Safety Gate

All eval commands require `SIKONG_RUN_LIVE_AGENT_TESTS=1` and at least one
provider API key to be set:

```bash
SIKONG_RUN_LIVE_AGENT_TESTS=1 DEEPSEEK_API_KEY=sk-... cargo run -- eval task-run-split
```

Without these, the eval returns an error explaining what is missing.
