import { defineTool, type ToolDefinition, type ToolSet } from "agent-loop";
import type {
  AgentRunRequest,
  AgentRunResponse,
  AgentToolCall,
  AgentToolSpec,
  JsonValue,
} from "./protocol";

export function createDynamicTools(specs: AgentToolSpec[]): ToolSet {
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

  return tools;
}

export async function runMockAgentWorker(request: AgentRunRequest): Promise<AgentRunResponse> {
  const delayMs = delayFromInput(request.input);
  if (delayMs > 0) {
    await Bun.sleep(delayMs);
  }

  const tools = createDynamicTools(request.tools);
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
  const terminalArguments = await mockTerminalArguments(request, toolName);
  const steps = mockToolSteps(request, toolName, terminalArguments);

  const agent = new ToolLoopAgent({
    tools,
    terminalToolSet: request.terminalToolSet,
  });
  const loopResult = await agent.run(steps);

  const call = loopResult.terminalCall;
  const callNames = loopResult.calls.map((toolCall) => toolCall.name).join(" -> ");
  return {
    report: call
      ? `mock agent worker completed ${request.objective}; tool calls ${callNames}; terminal tool ${call.name} called`
      : `mock agent worker completed ${request.objective}`,
    toolCalls: loopResult.calls,
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
  calls: AgentToolCall[];
  terminalCall?: AgentToolCall;
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
    const calls: AgentToolCall[] = [];

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
  return request.terminalToolSet[0];
}

function mockToolSteps(
  request: AgentRunRequest,
  toolName: string,
  terminalArguments: Record<string, unknown>,
): ToolLoopStep[] {
  if (toolName === "finish_assistant_turn") {
    return mockAssistantToolSteps(request, terminalArguments);
  }

  const contextToolName = contextReaderToolName(request);
  if (
    contextToolName &&
    contextToolName !== toolName &&
    !request.terminalToolSet.includes(contextToolName)
  ) {
    return [
      { name: contextToolName, arguments: {} },
      { name: toolName, arguments: terminalArguments },
    ];
  }

  return [{ name: toolName, arguments: terminalArguments }];
}

function mockAssistantToolSteps(
  request: AgentRunRequest,
  terminalArguments: Record<string, unknown>,
): ToolLoopStep[] {
  const input = toRecord(request.input);
  const message = stringOr(input.current_message, "").trim();
  const lowerMessage = message.toLowerCase();
  const steps: ToolLoopStep[] = [];

  if (request.tools.some((tool) => tool.name === "read_assistant_context")) {
    steps.push({ name: "read_assistant_context", arguments: {} });
  }

  if (lowerMessage === "list" || lowerMessage === "tasks") {
    steps.push({ name: "list_tasks", arguments: {} });
  } else if (lowerMessage === "cancel") {
    steps.push({ name: "cancel_task", arguments: {} });
  } else if (lowerMessage.startsWith("status ")) {
    steps.push({
      name: "inspect_task",
      arguments: { task_id: message.slice("status ".length).trim() },
    });
  } else if (message.length > 0) {
    steps.push({ name: "create_task", arguments: { request: message } });
  }

  steps.push({ name: "finish_assistant_turn", arguments: terminalArguments });
  return steps;
}

function contextReaderToolName(request: AgentRunRequest): string | undefined {
  const preferred = request.terminalToolSet.includes("finish_assistant_turn")
    ? "read_assistant_context"
    : "read_operation_context";
  if (request.tools.some((tool) => tool.name === preferred)) {
    return preferred;
  }
  return request.tools.find(
    (tool) => tool.name.startsWith("read_") && tool.name.endsWith("_context"),
  )?.name;
}

async function mockTerminalArguments(
  request: AgentRunRequest,
  toolName: string,
): Promise<Record<string, unknown>> {
  const input = toRecord(request.input);
  const plan = toRecord(input.plan);
  const operation = typeof input.operation === "string" ? input.operation : "";

  switch (toolName) {
    case "submit_specification":
      return {};
    case "submit_evidence":
      return mockEvidenceArgs(plan, input);
    case "submit_plan_group":
      return mockPlanGroupArgs(plan);
    case "submit_work":
      return await mockWorkArgs(input);
    case "submit_combination":
      return mockCombinationArgs(input);
    case "submit_verdict":
      return mockVerdictArgs(input);
    case "submit_commit":
      return {};
    case "finish_assistant_turn":
      return mockFinishAssistantTurnArgs(input);
    default:
      return { operation };
  }
}

function mockFinishAssistantTurnArgs(input: Record<string, unknown>): Record<string, unknown> {
  const message = stringOr(input.current_message, "").trim();
  const lowerMessage = message.toLowerCase();

  if (lowerMessage === "list" || lowerMessage === "tasks") {
    return {
      response: formatTaskList(input),
      task_ids: [],
    };
  }

  if (lowerMessage === "cancel") {
    return {
      response: "Cancelling active task.",
      task_ids: [],
    };
  }

  if (lowerMessage.startsWith("status ")) {
    const taskId = message.slice("status ".length).trim();
    return {
      response: formatTaskStatus(input, taskId),
      task_ids: [taskId],
    };
  }

  if (message.length === 0) {
    return {
      response: "Please provide a task request.",
      task_ids: [],
    };
  }

  return {
    response: "Creating task.",
    task_ids: [],
  };
}

function formatTaskList(input: Record<string, unknown>): string {
  const tasks = arrayOfRecords(input.tasks);
  if (tasks.length === 0) {
    return "No tasks yet.";
  }
  return tasks
    .map(
      (task) =>
        `${stringOr(task.id, "<unknown>")} ${stringOr(task.status, "<unknown>")}: ${stringOr(task.title, "")}`,
    )
    .join("\n");
}

function formatTaskStatus(input: Record<string, unknown>, taskId: string): string {
  const task = arrayOfRecords(input.tasks).find((item) => stringOr(item.id, "") === taskId);
  if (!task) {
    return `Task ${taskId} was not found.`;
  }
  return `${stringOr(task.id, taskId)} ${stringOr(task.status, "<unknown>")}: ${stringOr(task.title, "")}`;
}

function mockEvidenceArgs(
  plan: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const needsInfo = toRecord(plan.NeedsInfo);
  const node = toRecord(input.node);
  return {
    need: stringOr(needsInfo.need, "missing_information"),
    evidence: `evidence for ${stringOr(node.intent, "mock work")}`,
    next_plan: needsInfo.then ?? "Execute",
  };
}

function mockPlanGroupArgs(plan: Record<string, unknown>): Record<string, unknown> {
  const group = toRecord(plan.Group);
  return {
    mode: stringOr(group.mode, "parallel"),
    items: Array.isArray(group.items) ? group.items : [],
  };
}

async function mockWorkArgs(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const node = toRecord(input.node);
  const changedPaths = changedPathsFor(input);
  await writeWorkspaceSurfaceFiles(input, changedPaths);
  return {
    output: stringOr(node.intent, "mock output"),
  };
}

async function writeWorkspaceSurfaceFiles(
  input: Record<string, unknown>,
  changedPaths: string[],
): Promise<void> {
  const surface = toRecord(input.workspace_surface);
  const worktreePath = stringOr(surface.git_worktree_path, "");
  if (worktreePath.length === 0) {
    return;
  }

  for (const relativePath of changedPaths) {
    const filePath = `${worktreePath}/${relativePath}`;
    const parent = filePath.slice(0, filePath.lastIndexOf("/"));
    if (parent.length > 0) {
      await Bun.$`mkdir -p ${parent}`.quiet();
    }
    await Bun.write(filePath, `mock write for ${relativePath}\n`);
  }
}

function mockCombinationArgs(input: Record<string, unknown>): Record<string, unknown> {
  const node = toRecord(input.node);
  return {
    output: stringOr(node.intent, "mock combined output"),
  };
}

function mockVerdictArgs(input: Record<string, unknown>): Record<string, unknown> {
  const node = toRecord(input.node);
  const attempt = typeof node.verification_attempts === "number" ? node.verification_attempts : 0;
  return verdictToArgs(verdictFor(stringOr(node.intent, ""), attempt));
}

function changedPathsFor(input: Record<string, unknown>): string[] {
  const node = toRecord(input.node);
  const workspace = toRecord(node.workspace);
  const intent = stringOr(node.intent, "");
  if (intent.includes("read only must not write")) {
    return ["development-log/report.md"];
  }
  return stringArray(workspace.write_scope).filter((path) => path !== "**/*");
}

function verdictFor(intent: string, attempt: number): unknown {
  if (intent.includes("always bad")) {
    return { Reject: { failure_class: "BadOutput", reason: "bad output" } };
  }
  if (intent.includes("retry once") && attempt === 0) {
    return { Reject: { failure_class: "BadOutput", reason: "bad output" } };
  }
  if (intent.includes("needs post-verify info")) {
    return {
      Uncertain: {
        missing_info: "missing citation",
        reason: "needs source",
      },
    };
  }
  return "Accept";
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

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

async function executeTool(tool: ToolDefinition, args: Record<string, unknown>): Promise<void> {
  await tool.execute?.(args, {});
}

function toJsonObject(args: Record<string, unknown>): JsonValue {
  return JSON.parse(JSON.stringify(args)) as JsonValue;
}
