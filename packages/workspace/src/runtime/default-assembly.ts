import type { DefaultAgentRuntime } from "../settings";
import type { RuntimeAssemblyConfig } from "./assembly";

export type RuntimeAssemblyProfile = "lead" | "planning" | "worker" | "review";

const claudeInspectionTools = ["Read", "Glob", "Grep", "LS"];
const claudeExecutionTools = ["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "LS"];
const claudeSikongDisabledTools = ["Task", "Agent", "ExitPlanMode", "TodoWrite", "TaskUpdate"];

export function defaultRuntimeAssembly(
  runtime: DefaultAgentRuntime,
  profile: RuntimeAssemblyProfile,
  options: Record<string, unknown> = {},
): RuntimeAssemblyConfig {
  const backendOptions = runtimeOptions(runtime, profile, options);
  return {
    backend:
      Object.keys(backendOptions).length > 0
        ? { name: runtime.backend, options: backendOptions }
        : runtime.backend,
    toolProfiles: {
      ...(runtime.backend === "ai-sdk"
        ? {
            inspection: "ai-sdk-local-inspection",
            execution: "ai-sdk-local-execution",
          }
        : {}),
      leadProtocol: "sikong-lead-protocol",
      planningProtocol: "sikong-planning-protocol",
      stageReviewProtocol: "sikong-stage-review-protocol",
      finalReviewProtocol: "sikong-final-review-protocol",
    },
  };
}

function runtimeOptions(
  runtime: DefaultAgentRuntime,
  profile: RuntimeAssemblyProfile,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const base = {
    ...(runtime.provider ? { provider: runtime.provider } : {}),
    ...(runtime.model ? { model: runtime.model } : {}),
    ...options,
  };
  if (runtime.backend !== "claude-code") return base;

  if (profile !== "worker") {
    return {
      ...base,
      builtinTools: claudeInspectionTools,
      allowedTools: claudeInspectionTools,
      disallowedTools: claudeSikongDisabledTools,
    };
  }

  return {
    ...base,
    permissionMode: "bypassPermissions",
    builtinTools: claudeExecutionTools,
    allowedTools: claudeExecutionTools,
    disallowedTools: claudeSikongDisabledTools,
  };
}
