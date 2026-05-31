import { defineTool, type ToolSet } from "agent-loop";
import type { WorkflowDef } from "../workflow/types";

/** The intake agent's decision: which workflow, and the fields it extracted. */
export interface RouteDecision {
  workflowId: string;
  fields: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The single tool an intake wake is given: it records the routing decision (like
 * exit-tools — the engine reads it after the run, validates the workflow + fields,
 * and instantiates the task).
 */
export function buildRouteTool(workflowIds: readonly string[]): {
  tools: ToolSet;
  decision: () => RouteDecision | null;
} {
  let decision: RouteDecision | null = null;
  const tools: ToolSet = {
    route: defineTool({
      description:
        "Route this request to the best-matching workflow and extract its fields from the request. Use \"general\" if nothing fits.",
      inputSchema: {
        type: "object",
        properties: {
          workflowId: { type: "string", enum: [...workflowIds] },
          fields: {
            type: "object",
            description: "Values for the chosen workflow's declared fields, extracted from the request.",
          },
        },
        required: ["workflowId"],
        additionalProperties: false,
      },
      execute: (args) => {
        decision = {
          workflowId: String(args.workflowId),
          fields: isRecord(args.fields) ? args.fields : {},
        };
        return { acknowledged: true };
      },
    }),
  };
  return { tools, decision: () => decision };
}

/** The system prompt: the candidate workflows (incl. GENERAL) + their field schemas. */
export function buildIntakeSystem(workflows: readonly WorkflowDef[], request: string): string {
  const lines: string[] = [
    "# Intake router",
    "A new request must be routed to exactly one workflow. Pick the best match and extract its fields from the request; route to \"general\" if nothing specific fits.",
    "",
    "## Request",
    request,
    "",
    "## Available workflows",
  ];
  for (const wf of workflows) {
    lines.push(`- ${wf.id}: ${wf.name} — ${wf.description}`);
    const fieldNames = Object.keys(wf.fields);
    if (fieldNames.length)
      lines.push(
        `    fields: ${fieldNames
          .map((n) => `${n} (${wf.fields[n]?.type})${wf.fields[n]?.description ? ` — ${wf.fields[n]?.description}` : ""}`)
          .join("; ")}`,
      );
  }
  lines.push(
    "",
    "## How to route",
    "Call `route` once with the chosen `workflowId` and a `fields` object populated only from the declared fields of that workflow.",
  );
  return lines.join("\n");
}
