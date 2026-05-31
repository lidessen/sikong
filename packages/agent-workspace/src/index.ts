/**
 * agent-workspace — the coordination layer over `agent-loop`.
 *
 * A persistent, headless, agent-facing workflow engine: a Workflow is a schema
 * of fields + staged state machine with declarative guards; a Task is a
 * workflow instance whose append-only event timeline is the system of record
 * and whose `fields` are the projection an agent reads. Agents emit Commands; a
 * deterministic reducer validates them against the schema + the next stage's
 * guard and records Events. `agent-loop`'s `runTask` is the worker that executes
 * a single wake.
 *
 * M0 (here): the workflow kernel — data model, reducer/guard/validate, and
 * in-memory stores. The wake engine, persistence backends, and MCP surface land
 * in later milestones.
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

/** Package version marker. */
export const AGENT_WORKSPACE_VERSION = "0.0.0";
