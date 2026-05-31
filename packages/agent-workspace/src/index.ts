/**
 * agent-workspace — the coordination layer over `agent-loop`.
 *
 * SCOPE TBD (placeholder). Intended direction: a persistent substrate where
 * multiple `agent-loop` tasks/agents collaborate — shared state/filespace, a
 * chronicle (event log), and multi-agent orchestration (delegation, channels) —
 * with `runTask` from agent-loop as the single-agent execution primitive.
 *
 * For now this package only proves the monorepo wiring: it depends on
 * `agent-loop` and re-exports its task primitives so callers have one import
 * surface as the real API lands.
 */
export {
  runTask,
  type TaskInput,
  type TaskResult,
  type TaskStatus,
  type Handoff,
  type HandoffStore,
} from "agent-loop";

/** Placeholder version marker until the workspace API is defined. */
export const AGENT_WORKSPACE_VERSION = "0.0.0";
