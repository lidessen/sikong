# CLI Module Split

**Status:** Draft (+) — 2026-07-XX

**Governs:** `src/interface/cli/` submodules

**Layer:** L1 — Command & Interface

**Supersedes:** `cli-architecture.md` §Parsing Structure (architecture unchanged, only module layout)

---

## Purpose

Keep `src/interface/cli/` as a directory module with focused submodules, each
owning one command surface. No behavior changes.

## Rationale

A single 5k+ line file for CLI dispatch creates several problems:

1. **Compile-time friction** — any change to any subcommand recompiles the entire
   CLI module and all its dependents.
2. **Navigation overhead** — finding the right function requires scanning a single
   5k-line file; related code (eval scenario types, judge request building) lives
   alongside unrelated code (setup prompts, agent host resolution).
3. **Test isolation** — ~85 tests in the same module means changing one test can
   affect unrelated test compilation.
4. **Onboarding** — new contributors cannot see the module structure from the
   file tree; they must open one file and scroll.

## Module Structure

```
src/interface/cli/
├── mod.rs          — re-exports; Cli, Command enums; pub fn run(); fn run_cli();
│                     CliOutput, JSON helpers; DebugConfig
├── assistant.rs    — AssistantCommand, run_assistant_acp, run_assistant_prompt,
│                     assistant display, spinner/format helpers
├── task.rs         — TaskCommand, run_task_command, task list/show/inspect,
│                     agent event filtering
├── eval.rs         — EvalCommand, eval scenario types, scenario loading,
│                     run_task_run_split_eval, run_task_run_operation_eval,
│                     judgement types, artifact writing, judge request builder
├── launch.rs       — AgentHostLaunch, resolve_agent_loop_launch,
│                     resolve_agent_host_launch, binary resolution helpers
└── tests.rs        — All ~85 test functions (moved from mod cli tests block)
```

## Module Responsibilities

### `cli/mod.rs`

Re-exports everything needed by `main.rs` and other interface modules:

- `pub fn run(args) -> i32` (main entrypoint)
- `pub fn run_assistant_acp()` (used by assistant/mod.rs)
- `pub use` of key types from submodules if needed externally

Contains:

- `Cli` struct, `Command` enum + all 7 variants
- `fn run_cli(cli: Cli) -> i32` — match dispatch to submodules
- `CliOutput`, `print_json_output`, `print_json_data`, `print_json_error`
- `DebugConfig` struct
- `fn require_dev()`, `fn init_tracing()`, `fn send_spinner()`

### `cli/assistant.rs`

- `AssistantCommand` enum (moved)
- `AssistantPromptWorkspace` enum (moved)
- `fn run_assistant_acp()`, `fn run_assistant_prompt()`
- `AssistantPromptOutput`, `print_assistant_logs`, `print_assistant_list`
- `fn resolve_assistant_prompt_workspace()`, `fn current_git_root()`
- `fn send_spinner()`, `fn format_duration()`

### `cli/task.rs`

- `TaskCommand` enum (moved)
- `fn run_task_command()`, `fn print_task_list()`, `fn print_task_show()`
- `fn inspect_task_stream()`, `fn print_assistant_events()`
- Agent event types: `AgentEventFilter`, `AgentEventEntry`
- Task helpers: `fn resolve_task_ref()`, `fn task_list_id()`, etc.

### `cli/eval.rs`

- `EvalCommand` enum (moved)
- `fn run_task_run_split_eval()`, `fn run_task_run_operation_eval()`
- Eval scenario types: `TaskRunSplitScenario`, `OperationEvalScenario`, etc.
- Eval output types: `TaskRunSplitEvalOutput`, `TaskRunSplitJudgement`, etc.
- `fn select_task_run_split_eval_scenarios()`, `fn load_scenario_file()`
- `fn operation_judge_request()`, `fn decode_judgement()`
- `fn write_task_run_artifacts()`, `fn collect_accepted_artifact_ids()`
- Helpers: `fn sum_usage()`, `fn format_usage()`, `fn truncate_for_eval()`

### `cli/launch.rs`

- `AgentHostLaunch` struct
- `fn resolve_agent_loop_launch()`, `fn resolve_agent_host_launch()`
- `fn resolve_agent_host_launch_from()`
- `fn sibling_agent_host_binary()`, `fn sibling_agent_host_source_dir()`
- `fn which_bun()`, `fn binary_launch()`, `fn bun_script_launch()`

### `cli/tests.rs`

All test functions moved from `mod tests { ... }` in the original cli.rs.
Module declaration uses `#[cfg(test)] mod tests;` in `mod.rs`.

## Dependency Flow

```
mod.rs → { assistant, task, eval, launch }
  ↑ no cross-dependencies between submodules
  ↑ all submodules import from crate::* (same as before)
```

Submodules are independent — they do not call each other. The dispatch in
`run_cli()` calls one submodule per matched command variant.

## Migration Strategy

1. Keep `src/interface/cli/mod.rs` as thin dispatch.
2. Keep command-specific behavior in sibling submodules.
3. Extract tests into focused modules when a command surface grows large enough.
4. Run `cargo test` and `cargo clippy` after each extracted submodule.

The migration preserves:

- All imports (submodules use `use super::*;` for re-exported types)
- All function signatures
- All test names and coverage
- All public API surface (`pub fn run()`, `pub fn run_assistant_acp()`)

## Verification

- `cargo build` — must compile
- `cargo test` — all ~85 CLI tests pass (same count)
- `cargo clippy --all-targets -- -D warnings` — no warnings
- `cargo run -- assistant --acp --help` — help text unchanged
- `cargo run -- task list` — task command still works
