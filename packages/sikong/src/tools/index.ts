/**
 * Worker tools barrel — task-agnostic tools injected at the worker boundary.
 *
 * These tools are NOT command tools (they don't push commands to the engine's
 * reducer). They are worker-boundary tools that execute directly — writing files,
 * reading state, etc. Each tool set is built by a factory function that takes
 * project context and returns a `{ tools: ToolSet }`.
 *
 * Worker tools are injected via the engine's `WorkerToolsFactory` and merged
 * with the stage's command tools into the agent's tool set:
 *
 *   workerTools: (ctx, loop) => ({
 *     ...(ctx.workflow.id === "visual-design"
 *       ? buildDesignTools({ projectRoot: ctx.project.root }).tools
 *       : {}),
 *   })
 */
export { buildDesignTools, DESIGN_TOOL_NAMES } from "./design-tools";
export type {
  DesignToolsOptions,
  DesignToolName,
  DesignFile,
  PreviewType,
} from "./design-tools";
