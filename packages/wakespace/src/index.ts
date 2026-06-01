/**
 * wakespace — the coordination layer over `agent-loop`.
 *
 * A persistent, headless, agent-facing workflow engine: a Workflow is a schema
 * of fields + staged state machine with declarative guards; a Task is a
 * workflow instance whose append-only event timeline is the system of record
 * and whose `fields` are the projection an agent reads. Agents emit Commands; a
 * deterministic reducer validates them against the schema + the next stage's
 * guard and records Events. `agent-loop`'s `runTask` is the worker primitive
 * used inside wake execution.
 *
 * Current scope: workflow kernel, JSONL-backed stores/projections, wake engine,
 * project/worktree isolation, worker permission modes, workspace wiring, CLI,
 * and smokes.
 */

// ---- Workflow kernel (M0) -------------------------------------------------
// NOTE: the workspace `Task`/`TaskStatus`/`TaskEvent` are the workflow-INSTANCE
// concepts. They are deliberately distinct from agent-loop's run-level
// `runTask`/`TaskResult` (the worker primitive) — import those from "agent-loop"
// directly so the two "task" vocabularies never collide in one namespace.
export * from "./workflow";

// ---- Stores ---------------------------------------------------------------
export * from "./store";

// ---- Wake engine (M1) -----------------------------------------------------
export * from "./engine";

// ---- Observability --------------------------------------------------------
export * from "./inspect";

// ---- Projects + Workers ---------------------------------------------------
export * from "./project";
export * from "./worker";

// ---- Workspace wiring (durable engine over a dir) -------------------------
export * from "./workspace";
export * from "./workspace-layout";

/** Package version marker. */
export const WAKESPACE_VERSION = "0.0.0";
