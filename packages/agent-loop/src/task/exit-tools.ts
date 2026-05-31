import { defineTool, type ToolSet } from "../core/types";

/**
 * The structured result a run produces by calling one of the two exit tools.
 * The supervisor reads it after the run ends to decide: stop (complete) or
 * spawn the next round (handoff).
 */
export type ExitOutcome =
  | { kind: "complete"; summary: string; result?: unknown }
  | {
      kind: "handoff";
      progress: string;
      nextSteps: string;
      openQuestions?: string;
      artifacts?: string[];
    };

/**
 * Build the two exit tools injected into each round's run, plus an accessor for
 * whichever outcome the model chose. The tools' `execute` records the outcome
 * into a closure and returns a small ack — the supervisor inspects `outcome()`
 * once the run completes.
 *
 * Requires the runtime's `tools` capability (claude / ai-sdk). Runtimes without
 * it (codex / cursor) can't receive these tools — `runTask` rejects them rather
 * than pretend.
 */
export function createExitTools(): {
  tools: ToolSet;
  outcome: () => ExitOutcome | null;
} {
  let outcome: ExitOutcome | null = null;

  const tools: ToolSet = {
    task_complete: defineTool({
      description:
        "Call this ONLY when the entire task is fully complete. Ends the task and returns your final summary.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What was accomplished, overall." },
          result: { description: "Optional structured final result." },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      execute: (args) => {
        outcome = {
          kind: "complete",
          summary: asString(args.summary),
          ...(args.result !== undefined ? { result: args.result } : {}),
        };
        return { acknowledged: true };
      },
    }),
    task_handoff: defineTool({
      description:
        "Call this when you are running low on context and CANNOT finish the task this round. " +
        "Writes a handoff so a fresh agent continues exactly where you left off.",
      inputSchema: {
        type: "object",
        properties: {
          progress: { type: "string", description: "What you accomplished this round." },
          nextSteps: { type: "string", description: "Concrete next steps for the next agent." },
          openQuestions: { type: "string", description: "Unresolved questions / decisions." },
          artifacts: {
            type: "array",
            items: { type: "string" },
            description: "References to durable outputs (files, ids, URLs).",
          },
        },
        required: ["progress", "nextSteps"],
        additionalProperties: false,
      },
      execute: (args) => {
        outcome = {
          kind: "handoff",
          progress: asString(args.progress),
          nextSteps: asString(args.nextSteps),
          ...(args.openQuestions ? { openQuestions: asString(args.openQuestions) } : {}),
          ...(Array.isArray(args.artifacts)
            ? { artifacts: args.artifacts.map(asString) }
            : {}),
        };
        return { acknowledged: true };
      },
    }),
  };

  return { tools, outcome: () => outcome };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
