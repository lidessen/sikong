import { defineTool, type ToolDefinition, type ToolSet } from "agent-loop";
import type {
  AgentRunRequest,
  AgentTerminalToolCall,
  AgentToolSpec,
  AgentWorkerResult,
  JsonValue,
} from "./protocol";

interface DynamicTools {
  tools: ToolSet;
}

export function createDynamicTools(specs: AgentToolSpec[]): DynamicTools {
  const tools: ToolSet = {};

  for (const spec of specs) {
    tools[spec.name] = defineTool({
      description: spec.description,
      inputSchema: spec.inputSchema,
      execute: () => {
        return { acknowledged: true };
      },
    });
  }

  return {
    tools,
  };
}

export async function runMockAgentWorker(request: AgentRunRequest): Promise<AgentWorkerResult> {
  const delayMs = delayFromInput(request.input);
  if (delayMs > 0) {
    await Bun.sleep(delayMs);
  }

  const { tools } = createDynamicTools(request.tools);
  const toolName = selectToolName(request);
  if (!toolName) {
    return {
      report: `mock agent worker found no terminal tool for ${request.objective}`,
    };
  }

  const tool = tools[toolName];
  if (!tool?.execute) {
    return {
      report: `mock agent worker could not find selected tool ${toolName}`,
    };
  }

  const agent = new ToolLoopAgent({
    tools,
    terminalToolSet: request.terminalToolSet,
  });
  const loopResult = await agent.run([
    { name: toolName, arguments: mockTerminalArguments(request, toolName) },
  ]);

  const call = loopResult.terminalCall;
  return {
    report: call
      ? `mock agent worker completed ${request.objective}; terminal tool ${call.name} called`
      : `mock agent worker completed ${request.objective}`,
    ...(call ? { terminalCall: call } : {}),
  };
}

function delayFromInput(input: JsonValue): number {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const value = input.mockDelayMs;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  }
  return 0;
}

export interface ToolLoopStep {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolLoopResult {
  calls: AgentTerminalToolCall[];
  terminalCall?: AgentTerminalToolCall;
}

export class ToolLoopAgent {
  private readonly terminalToolNames: Set<string>;

  constructor(
    private readonly options: {
      tools: ToolSet;
      terminalToolSet: string[];
    },
  ) {
    this.terminalToolNames = new Set(options.terminalToolSet);
  }

  async run(steps: ToolLoopStep[]): Promise<ToolLoopResult> {
    const calls: AgentTerminalToolCall[] = [];

    for (const step of steps) {
      const tool = this.options.tools[step.name];
      if (!tool?.execute) {
        continue;
      }

      await executeTool(tool, step.arguments);
      const call = {
        name: step.name,
        arguments: toJsonObject(step.arguments),
      };
      calls.push(call);

      if (this.terminalToolNames.has(call.name)) {
        return { calls, terminalCall: call };
      }
    }

    return { calls };
  }
}

function selectToolName(request: AgentRunRequest): string | undefined {
  if (request.toolChoice.type === "tool") {
    return request.toolChoice.name;
  }

  return request.terminalToolSet[0];
}

function mockTerminalArguments(
  request: AgentRunRequest,
  toolName: string,
): Record<string, unknown> {
  const input = toRecord(request.input);
  const script = toRecord(input.script);
  const operation = typeof input.operation === "string" ? input.operation : "";

  switch (toolName) {
    case "submit_specification":
      return { report: `specified ${request.objective}` };
    case "submit_evidence":
      return mockEvidenceArgs(script);
    case "submit_division":
      return mockDivisionArgs(script);
    case "submit_work":
      return mockWorkArgs(script);
    case "submit_combination":
      return mockCombinationArgs(script, input);
    case "submit_verdict":
      return mockVerdictArgs(script, input);
    case "submit_commit":
      return { report: `committed ${request.objective}` };
    case "submit_assistant_decision":
      return mockAssistantDecisionArgs(input);
    default:
      return { operation };
  }
}

function mockAssistantDecisionArgs(input: Record<string, unknown>): Record<string, unknown> {
  const message = stringOr(input.current_message, "").trim();
  const lowerMessage = message.toLowerCase();

  if (lowerMessage === "list" || lowerMessage === "tasks") {
    return {
      decision: "list_tasks",
      response: "Listing tasks.",
    };
  }

  if (lowerMessage === "cancel") {
    return {
      decision: "cancel_active_task",
      response: "Cancelling active task.",
    };
  }

  if (lowerMessage.startsWith("status ")) {
    return {
      decision: "inspect_task",
      task_id: message.slice("status ".length).trim(),
      response: "Inspecting task.",
    };
  }

  if (message.length === 0) {
    return {
      decision: "reply",
      response: "Please provide a task request.",
    };
  }

  return {
    decision: "create_task",
    request: message,
    response: "Creating task.",
  };
}

function mockEvidenceArgs(script: Record<string, unknown>): Record<string, unknown> {
  const needsInfo = toRecord(script.NeedsInfo);
  return {
    need: stringOr(needsInfo.need, "missing_information"),
    evidence: stringOr(needsInfo.acquired, "mock evidence"),
    next_script: needsInfo.then ?? { Leaf: defaultLeafScript("mock acquired output") },
  };
}

function mockDivisionArgs(script: Record<string, unknown>): Record<string, unknown> {
  const divide = toRecord(script.Divide);
  return {
    children: Array.isArray(divide.children) ? divide.children : [],
  };
}

function mockWorkArgs(script: Record<string, unknown>): Record<string, unknown> {
  const leaf = toRecord(script.Leaf);
  return {
    output: stringOr(leaf.output, "mock output"),
    changed_paths: stringArray(leaf.changed_paths),
    side_effects: stringArray(leaf.side_effects),
  };
}

function mockCombinationArgs(
  script: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const divide = toRecord(script.Divide);
  const integration = toRecord(input.workspace_integration);
  return {
    output: stringOr(divide.combine_output, "mock combined output"),
    resolved_conflicts: stringArray(integration.conflicts),
  };
}

function mockVerdictArgs(
  script: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const variants = [toRecord(script.Leaf), toRecord(script.Divide)];
  const verdicts = variants.flatMap((variant) =>
    Array.isArray(variant.verdicts) ? variant.verdicts : [],
  );
  const node = toRecord(input.node);
  const attempt = typeof node.verification_attempts === "number" ? node.verification_attempts : 0;
  return verdictToArgs(verdicts[attempt] ?? "Accept");
}

function verdictToArgs(verdict: unknown): Record<string, unknown> {
  if (verdict === "Accept") {
    return { verdict: "accept", reason: "mock accepted" };
  }

  const record = toRecord(verdict);
  const reject = toRecord(record.Reject);
  if (Object.keys(reject).length > 0) {
    return {
      verdict: "reject",
      reason: stringOr(reject.reason, "mock rejected"),
      failure_class: reject.failure_class ?? "BadOutput",
    };
  }

  const uncertain = toRecord(record.Uncertain);
  if (Object.keys(uncertain).length > 0) {
    return {
      verdict: "need_information",
      reason: stringOr(uncertain.reason, "mock needs information"),
      missing_info: stringOr(uncertain.missing_info, "missing_information"),
    };
  }

  return { verdict: "accept", reason: "mock accepted" };
}

function defaultLeafScript(output: string): Record<string, unknown> {
  return {
    output,
    changed_paths: [],
    side_effects: [],
    verdicts: ["Accept"],
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function executeTool(tool: ToolDefinition, args: Record<string, unknown>): Promise<void> {
  await tool.execute?.(args, {});
}

function toJsonObject(args: Record<string, unknown>): JsonValue {
  return JSON.parse(JSON.stringify(args)) as JsonValue;
}
