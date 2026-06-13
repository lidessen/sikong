import { defineTool, type ToolSet } from "../core/types";

/**
 * The structured result a worker task round produces by calling exactly one
 * task exit tool. `continue` is the only non-final status: it appends `report`
 * to the transient task timeline and starts the next fresh work loop.
 */
export type ExitOutcome =
  | { status: "continue"; report: string }
  | { status: "completed"; report: string; result?: unknown }
  | { status: "failed"; report: string }
  | { status: "budget_exceeded"; report: string };

export type ExitToolMode = "work" | "finish";

export interface TaskReadContext {
  goal: string;
  mode: ExitToolMode | "gate";
  round: number;
  timeline: Array<{ round: number; report: string }>;
}

export interface ExitToolOptions {
  /**
   * Work rounds can continue, complete, or fail. Finish-only rounds can
   * complete, fail, or report budget exhaustion. Defaults to "finish" for direct
   * use.
   */
  mode?: ExitToolMode;
  /** Context returned by the read-only task context tool. */
  readContext?: TaskReadContext;
  /** Called immediately after a task exit tool records an outcome. */
  onTerminal?: (outcome: ExitOutcome) => void;
}

/**
 * Build task exit tools plus an accessor for whichever outcome the model
 * chose. The tools' `execute` records the outcome into a closure and returns a
 * small ack. The supervisor cancels the run after a terminal tool is called, so
 * each round ends with that tool call as the absorbing action.
 *
 * Requires the runtime's `tools` capability. Runtimes without it can't receive
 * these terminal tools, so `runTask` rejects them rather than pretending.
 */
export function createExitTools(options: ExitToolOptions = {}): {
  tools: ToolSet;
  outcome: () => ExitOutcome | null;
} {
  const mode = options.mode ?? "finish";
  let outcome: ExitOutcome | null = null;

  const finish = (next: ExitOutcome) => {
    if (outcome) {
      return { acknowledged: true, terminal: true, status: outcome.status, ignored: true };
    }
    outcome = next;
    options.onTerminal?.(next);
    return { acknowledged: true, terminal: true, status: next.status };
  };

  const tools: ToolSet = {
    agent_loop_task_read: defineTool({
      description: "Read the current agent-loop task goal, mode, round, and timeline.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: () => options.readContext ?? null,
    }),
    agent_loop_task_complete: defineTool({
      description:
        "Call this ONLY when the entire task is fully complete. This is a terminal action.",
      inputSchema: {
        type: "object",
        properties: {
          report: {
            type: "string",
            minLength: 1,
            description: "Final task report: what was completed, key result, and verification.",
          },
          result: { description: "Optional structured final result." },
        },
        required: ["report"],
        additionalProperties: false,
      },
      execute: (args) => {
        return finish({
          status: "completed",
          report: asString(args.report),
          ...(args.result !== undefined ? { result: args.result } : {}),
        });
      },
    }),
    agent_loop_task_fail: defineTool({
      description:
        "Call this when the task cannot be completed successfully. This is a terminal action.",
      inputSchema: {
        type: "object",
        properties: {
          report: {
            type: "string",
            minLength: 1,
            description:
              "Failure report: why the task failed, what was attempted, and any useful current state.",
          },
        },
        required: ["report"],
        additionalProperties: false,
      },
      execute: (args) => {
        return finish({ status: "failed", report: asString(args.report) });
      },
    }),
  };

  if (mode === "work") {
    tools.agent_loop_task_continue = defineTool({
      description:
        "Call this when this work round should stop and a fresh loop should continue the task. This is a terminal action for the current round.",
      inputSchema: {
        type: "object",
        properties: {
          report: {
            type: "string",
            minLength: 1,
            description:
              "Continuation report: what changed this round and what the next fresh loop should know.",
          },
        },
        required: ["report"],
        additionalProperties: false,
      },
      execute: (args) => {
        return finish({ status: "continue", report: asString(args.report) });
      },
    });
  }

  if (mode === "finish") {
    tools.agent_loop_task_budget_exceeded = defineTool({
      description:
        "Call this when the task did not complete before the available work budget was exhausted. This is a terminal action.",
      inputSchema: {
        type: "object",
        properties: {
          report: {
            type: "string",
            minLength: 1,
            description:
              "Budget report: what was completed, current state, and what remains unfinished.",
          },
        },
        required: ["report"],
        additionalProperties: false,
      },
      execute: (args) => {
        return finish({ status: "budget_exceeded", report: asString(args.report) });
      },
    });
  }

  return { tools, outcome: () => outcome };
}

export type GateOutcome =
  | { decision: "accept"; report: string }
  | { decision: "reject"; report: string };

export interface GateToolOptions {
  readContext?: TaskReadContext;
  onTerminal?: (outcome: GateOutcome) => void;
}

export function createGateTools(options: GateToolOptions = {}): {
  tools: ToolSet;
  outcome: () => GateOutcome | null;
} {
  let outcome: GateOutcome | null = null;

  const finish = (next: GateOutcome) => {
    if (outcome) {
      return { acknowledged: true, terminal: true, decision: outcome.decision, ignored: true };
    }
    outcome = next;
    options.onTerminal?.(next);
    return { acknowledged: true, terminal: true, decision: next.decision };
  };

  const tools: ToolSet = {
    agent_loop_task_read: defineTool({
      description: "Read the current agent-loop task goal, mode, round, and timeline.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: () => options.readContext ?? null,
    }),
    agent_loop_gate_accept: defineTool({
      description:
        "Accept the worker's completed/failed claim after evaluating the available evidence. This is a terminal gate action.",
      inputSchema: {
        type: "object",
        properties: {
          report: {
            type: "string",
            minLength: 1,
            description: "Why the worker claim is supported by the available evidence.",
          },
        },
        required: ["report"],
        additionalProperties: false,
      },
      execute: (args) => finish({ decision: "accept", report: asString(args.report) }),
    }),
    agent_loop_gate_reject: defineTool({
      description:
        "Reject the worker's completed/failed claim after evaluating the available evidence. This is a terminal gate action.",
      inputSchema: {
        type: "object",
        properties: {
          report: {
            type: "string",
            minLength: 1,
            description:
              "Why the worker claim is not supported and what the next work loop should know.",
          },
        },
        required: ["report"],
        additionalProperties: false,
      },
      execute: (args) => finish({ decision: "reject", report: asString(args.report) }),
    }),
  };

  return { tools, outcome: () => outcome };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
