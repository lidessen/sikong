import { defineTool, type ToolSet } from "agent-loop";
import {
  acceptStageReview,
  fail,
  recommendFinalReview,
  rejectStageReview,
  submitPlan,
  type CommandContext,
  type CommandResult,
} from "../commands";
import type { OrchestrationRunnerRequest } from "../orchestration/runner";

interface ProtocolToolContext {
  request?: OrchestrationRunnerRequest;
}

interface ProtocolTarget {
  workspaceId: string;
  taskId: string;
  reviewId?: string;
}

export function createPlanningProtocolTools(context: ProtocolToolContext): ToolSet {
  return {
    submit_plan: defineTool({
      description: "Submit the ordered Sikong PlanDef for the current task.",
      inputSchema: planSchema,
      execute: async (args) => {
        const target = planningTarget(context);
        if (!target.ok) return target;
        const input = parsePlanArgs(args);
        if (!input.ok) return input;
        return await submitPlan(commandContext(context), {
          workspaceId: target.data.workspaceId,
          taskId: target.data.taskId,
          ...input.data,
        });
      },
    }),
  };
}

export function createStageReviewProtocolTools(context: ProtocolToolContext): ToolSet {
  return {
    accept_stage_review: defineTool({
      description: "Accept the current Sikong stage review.",
      inputSchema: reviewDecisionSchema,
      execute: async (args) => {
        const target = reviewTarget(context, "start_stage_verification_worker");
        if (!target.ok) return target;
        const input = parseReviewArgs(args);
        if (!input.ok) return input;
        return await acceptStageReview(commandContext(context), {
          workspaceId: target.data.workspaceId,
          taskId: target.data.taskId,
          reviewId: target.data.reviewId ?? "",
          report: input.data.report,
        });
      },
    }),
    reject_stage_review: defineTool({
      description: "Reject the current Sikong stage review and request more work.",
      inputSchema: reviewDecisionSchema,
      execute: async (args) => {
        const target = reviewTarget(context, "start_stage_verification_worker");
        if (!target.ok) return target;
        const input = parseReviewArgs(args);
        if (!input.ok) return input;
        return await rejectStageReview(commandContext(context), {
          workspaceId: target.data.workspaceId,
          taskId: target.data.taskId,
          reviewId: target.data.reviewId ?? "",
          report: input.data.report,
          ...(input.data.requestedChanges ? { requestedChanges: input.data.requestedChanges } : {}),
        });
      },
    }),
  };
}

export function createFinalReviewProtocolTools(context: ProtocolToolContext): ToolSet {
  return {
    recommend_final_review: defineTool({
      description: "Submit the final Sikong review recommendation.",
      inputSchema: finalReviewSchema,
      execute: async (args) => {
        const target = reviewTarget(context, "start_final_verification_worker");
        if (!target.ok) return target;
        const input = parseFinalReviewArgs(args);
        if (!input.ok) return input;
        return await recommendFinalReview(commandContext(context), {
          workspaceId: target.data.workspaceId,
          taskId: target.data.taskId,
          reviewId: target.data.reviewId ?? "",
          recommendation: input.data.recommendation,
          report: input.data.report,
        });
      },
    }),
  };
}

function commandContext(context: ProtocolToolContext): CommandContext {
  const runner = requireRequest(context);
  if (!runner.ok) return { dataDir: "", workspaceId: "" };
  return {
    dataDir: runner.data.context.dataDir,
    ...(runner.data.context.workspaceId ? { workspaceId: runner.data.context.workspaceId } : {}),
    ...(runner.data.context.outputMode ? { outputMode: runner.data.context.outputMode } : {}),
  };
}

function planningTarget(context: ProtocolToolContext): CommandResult<ProtocolTarget> {
  const request = requireRequest(context);
  if (!request.ok) return request;
  const { action } = request.data;
  if (action.type !== "start_planning_worker") {
    return fail("invalid_input", "submit_plan is only available to planning runs.", {
      actionType: action.type,
    });
  }
  return okTarget(action.spec.workspaceId, action.spec.taskId);
}

function reviewTarget(
  context: ProtocolToolContext,
  actionType: "start_stage_verification_worker" | "start_final_verification_worker",
): CommandResult<ProtocolTarget> {
  const request = requireRequest(context);
  if (!request.ok) return request;
  const { action } = request.data;
  if (action.type !== actionType) {
    return fail("invalid_input", "Review protocol tool is not available for this action.", {
      actionType: action.type,
      expectedActionType: actionType,
    });
  }
  const target = okTarget(action.spec.workspaceId, action.spec.taskId);
  if (!target.ok) return target;
  return { ok: true, data: { ...target.data, reviewId: action.reviewId } };
}

function requireRequest(context: ProtocolToolContext): CommandResult<OrchestrationRunnerRequest> {
  if (!context.request) {
    return fail("invalid_input", "Protocol tools require an orchestration runner request.");
  }
  return { ok: true, data: context.request };
}

function okTarget(workspaceId: string | undefined, taskId: string): CommandResult<ProtocolTarget> {
  if (!workspaceId) {
    return fail("invalid_input", "Protocol tool target requires a workspace id.", { taskId });
  }
  return { ok: true, data: { workspaceId, taskId } };
}

function parsePlanArgs(args: Record<string, unknown>): CommandResult<{
  summary?: string;
  stages: Array<{ title: string; objective: string; acceptance: string[]; workerCount?: number }>;
}> {
  const stages = args.stages;
  if (!Array.isArray(stages) || stages.length === 0) {
    return fail("invalid_input", "submit_plan requires at least one stage.");
  }

  const parsed = stages.map((stage, index) => parseStage(stage, index));
  const failed = parsed.find((result) => !result.ok);
  if (failed && !failed.ok) return failed;

  const summary = optionalString(args.summary);
  return {
    ok: true,
    data: {
      ...(summary ? { summary } : {}),
      stages: parsed.map((result) => {
        if (!result.ok) throw new Error("unreachable");
        return result.data;
      }),
    },
  };
}

function parseStage(
  value: unknown,
  index: number,
): CommandResult<{ title: string; objective: string; acceptance: string[]; workerCount?: number }> {
  const record = asRecord(value);
  if (!record) return fail("invalid_input", `Stage ${index + 1} must be an object.`);
  const title = requiredString(record.title, `Stage ${index + 1} title is required.`);
  if (!title.ok) return title;
  const objective = requiredString(record.objective, `Stage ${index + 1} objective is required.`);
  if (!objective.ok) return objective;
  const acceptance = stringList(record.acceptance);
  if (!acceptance.ok) return acceptance;
  if (acceptance.data.length === 0) {
    return fail("invalid_input", `Stage ${index + 1} acceptance must be non-empty.`);
  }
  const workerCount = optionalPositiveInteger(record.workerCount);
  if (!workerCount.ok) return workerCount;
  return {
    ok: true,
    data: {
      title: title.data,
      objective: objective.data,
      acceptance: acceptance.data,
      ...(workerCount.data && workerCount.data > 1 ? { workerCount: workerCount.data } : {}),
    },
  };
}

function parseReviewArgs(args: Record<string, unknown>): CommandResult<{
  report: string;
  requestedChanges?: string;
}> {
  const report = requiredString(args.report, "Review report is required.");
  if (!report.ok) return report;
  const requestedChanges = optionalString(args.requestedChanges);
  return {
    ok: true,
    data: {
      report: report.data,
      ...(requestedChanges ? { requestedChanges } : {}),
    },
  };
}

function parseFinalReviewArgs(args: Record<string, unknown>): CommandResult<{
  recommendation: "accept" | "reject";
  report: string;
}> {
  if (args.recommendation !== "accept" && args.recommendation !== "reject") {
    return fail("invalid_input", "Final review recommendation must be accept or reject.");
  }
  const report = requiredString(args.report, "Final review report is required.");
  if (!report.ok) return report;
  return {
    ok: true,
    data: {
      recommendation: args.recommendation,
      report: report.data,
    },
  };
}

function requiredString(value: unknown, message: string): CommandResult<string> {
  if (typeof value !== "string" || !value.trim()) return fail("invalid_input", message);
  return { ok: true, data: value.trim() };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveInteger(value: unknown): CommandResult<number | undefined> {
  if (value === undefined) return { ok: true, data: undefined };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return fail("invalid_input", "workerCount must be a positive integer.");
  }
  return { ok: true, data: value };
}

function stringList(value: unknown): CommandResult<string[]> {
  if (!Array.isArray(value)) return fail("invalid_input", "Expected a string array.");
  const items = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  if (items.length !== value.length) {
    return fail("invalid_input", "Expected a string array without empty values.");
  }
  return { ok: true, data: items };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const planSchema = {
  type: "object",
  required: ["stages"],
  properties: {
    summary: { type: "string" },
    stages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["title", "objective", "acceptance"],
        properties: {
          title: { type: "string" },
          objective: { type: "string" },
          acceptance: { type: "array", items: { type: "string" }, minItems: 1 },
          workerCount: { type: "integer", minimum: 1 },
        },
      },
    },
  },
} as const;

const reviewDecisionSchema = {
  type: "object",
  required: ["report"],
  properties: {
    report: { type: "string" },
    requestedChanges: { type: "string" },
  },
} as const;

const finalReviewSchema = {
  type: "object",
  required: ["recommendation", "report"],
  properties: {
    recommendation: { type: "string", enum: ["accept", "reject"] },
    report: { type: "string" },
  },
} as const;
