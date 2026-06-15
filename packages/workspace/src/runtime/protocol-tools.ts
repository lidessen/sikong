import { defineTool, type ToolSet } from "agent-loop";
import {
  acceptPlan,
  acceptStageReview,
  acceptTask,
  fail,
  planStageRound,
  recommendFinalReview,
  rejectPlan,
  rejectStageReview,
  rejectTask,
  submitRequirementSpec,
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

export function createLeadProtocolTools(context: ProtocolToolContext): ToolSet {
  return {
    submit_requirement_spec: defineTool({
      description: "Submit the Task Lead requirement spec for the current Sikong task.",
      inputSchema: requirementSpecSchema,
      execute: async (args) => {
        const target = leadTarget(context, "start_lead_requirement_spec");
        if (!target.ok) return target;
        const input = parseRequirementSpecArgs(args);
        if (!input.ok) return input;
        return await submitRequirementSpec(commandContext(context), {
          workspaceId: target.data.workspaceId,
          taskId: target.data.taskId,
          ...input.data,
        });
      },
    }),
    accept_plan: defineTool({
      description: "Accept the submitted Sikong plan.",
      inputSchema: planDecisionSchema,
      execute: async (args) => {
        const target = leadTarget(context, "start_lead_plan_decision");
        if (!target.ok) return target;
        const input = parsePlanDecisionArgs(args);
        if (!input.ok) return input;
        return await acceptPlan(commandContext(context), {
          workspaceId: target.data.workspaceId,
          taskId: target.data.taskId,
          ...input.data,
        });
      },
    }),
    reject_plan: defineTool({
      description: "Reject the submitted Sikong plan and request a revision.",
      inputSchema: rejectPlanSchema,
      execute: async (args) => {
        const target = leadTarget(context, "start_lead_plan_decision");
        if (!target.ok) return target;
        const input = parsePlanDecisionArgs(args);
        if (!input.ok) return input;
        const requestedChanges = optionalString(args.requestedChanges);
        return await rejectPlan(commandContext(context), {
          workspaceId: target.data.workspaceId,
          taskId: target.data.taskId,
          ...input.data,
          ...(requestedChanges ? { requestedChanges } : {}),
        });
      },
    }),
    plan_stage_round: defineTool({
      description: "Plan the next stage round with explicit work units.",
      inputSchema: stageRoundSchema,
      execute: async (args) => {
        const target = leadTarget(context, "start_lead_round_planning");
        if (!target.ok) return target;
        const input = parseStageRoundArgs(args);
        if (!input.ok) return input;
        return await planStageRound(commandContext(context), {
          workspaceId: target.data.workspaceId,
          taskId: target.data.taskId,
          ...input.data,
        });
      },
    }),
    accept_task: defineTool({
      description: "Accept and close the Sikong task after final review.",
      inputSchema: taskDecisionSchema,
      execute: async (args) => {
        const target = leadTarget(context, "start_lead_final_decision");
        if (!target.ok) return target;
        const report = requiredString(args.report, "Task decision report is required.");
        if (!report.ok) return report;
        return await acceptTask(commandContext(context), {
          workspaceId: target.data.workspaceId,
          taskId: target.data.taskId,
          report: report.data,
        });
      },
    }),
    reject_task: defineTool({
      description: "Reject and close the Sikong task after final review.",
      inputSchema: taskDecisionSchema,
      execute: async (args) => {
        const target = leadTarget(context, "start_lead_final_decision");
        if (!target.ok) return target;
        const report = requiredString(args.report, "Task decision report is required.");
        if (!report.ok) return report;
        return await rejectTask(commandContext(context), {
          workspaceId: target.data.workspaceId,
          taskId: target.data.taskId,
          report: report.data,
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

function leadTarget(
  context: ProtocolToolContext,
  actionType:
    | "start_lead_requirement_spec"
    | "start_lead_plan_decision"
    | "start_lead_round_planning"
    | "start_lead_final_decision",
): CommandResult<ProtocolTarget> {
  const request = requireRequest(context);
  if (!request.ok) return request;
  const { action } = request.data;
  if (action.type !== actionType) {
    return fail("invalid_input", "Lead protocol tool is not available for this action.", {
      actionType: action.type,
      expectedActionType: actionType,
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
  stages: Array<{ title: string; objective: string; acceptance: string[] }>;
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
): CommandResult<{ title: string; objective: string; acceptance: string[] }> {
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
  return {
    ok: true,
    data: {
      title: title.data,
      objective: objective.data,
      acceptance: acceptance.data,
    },
  };
}

function parseRequirementSpecArgs(args: Record<string, unknown>): CommandResult<{
  summary: string;
  constraints?: string[];
  acceptance?: string[];
}> {
  const summary = requiredString(args.summary, "Requirement spec summary is required.");
  if (!summary.ok) return summary;
  const constraints =
    args.constraints === undefined ? { ok: true as const, data: [] } : stringList(args.constraints);
  if (!constraints.ok) return constraints;
  const acceptance =
    args.acceptance === undefined ? { ok: true as const, data: [] } : stringList(args.acceptance);
  if (!acceptance.ok) return acceptance;
  return {
    ok: true,
    data: {
      summary: summary.data,
      ...(constraints.data.length > 0 ? { constraints: constraints.data } : {}),
      ...(acceptance.data.length > 0 ? { acceptance: acceptance.data } : {}),
    },
  };
}

function parsePlanDecisionArgs(args: Record<string, unknown>): CommandResult<{
  planId: string;
  version: number;
  report: string;
}> {
  const planId = requiredString(args.planId, "Plan id is required.");
  if (!planId.ok) return planId;
  const version = requiredPositiveInteger(args.version, "Plan version must be a positive integer.");
  if (!version.ok) return version;
  const report = requiredString(args.report, "Plan decision report is required.");
  if (!report.ok) return report;
  return okData({ planId: planId.data, version: version.data, report: report.data });
}

function parseStageRoundArgs(args: Record<string, unknown>): CommandResult<{
  stageId: string;
  title?: string;
  intent: string;
  workUnits: Array<{ title: string; objective: string; acceptance?: string[] }>;
}> {
  const stageId = requiredString(args.stageId, "Stage id is required.");
  if (!stageId.ok) return stageId;
  const intent = requiredString(args.intent, "Stage round intent is required.");
  if (!intent.ok) return intent;
  const workUnits = args.workUnits;
  if (!Array.isArray(workUnits) || workUnits.length === 0) {
    return fail("invalid_input", "plan_stage_round requires at least one work unit.");
  }
  const parsed = workUnits.map((workUnit, index) => parseWorkUnit(workUnit, index));
  const failed = parsed.find((result) => !result.ok);
  if (failed && !failed.ok) return failed;
  return okData({
    stageId: stageId.data,
    ...(optionalString(args.title) ? { title: optionalString(args.title) } : {}),
    intent: intent.data,
    workUnits: parsed.map((result) => {
      if (!result.ok) throw new Error("unreachable");
      return result.data;
    }),
  });
}

function parseWorkUnit(
  value: unknown,
  index: number,
): CommandResult<{ title: string; objective: string; acceptance?: string[] }> {
  const record = asRecord(value);
  if (!record) return fail("invalid_input", `Work unit ${index + 1} must be an object.`);
  const title = requiredString(record.title, `Work unit ${index + 1} title is required.`);
  if (!title.ok) return title;
  const objective = requiredString(
    record.objective,
    `Work unit ${index + 1} objective is required.`,
  );
  if (!objective.ok) return objective;
  const acceptance =
    record.acceptance === undefined
      ? { ok: true as const, data: [] }
      : stringList(record.acceptance);
  if (!acceptance.ok) return acceptance;
  return okData({
    title: title.data,
    objective: objective.data,
    ...(acceptance.data.length > 0 ? { acceptance: acceptance.data } : {}),
  });
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

function requiredPositiveInteger(value: unknown, message: string): CommandResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return fail("invalid_input", message);
  }
  return { ok: true, data: value };
}

function okData<T>(data: T): CommandResult<T> {
  return { ok: true, data };
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
        },
      },
    },
  },
} as const;

const requirementSpecSchema = {
  type: "object",
  required: ["summary"],
  properties: {
    summary: { type: "string" },
    constraints: { type: "array", items: { type: "string" } },
    acceptance: { type: "array", items: { type: "string" } },
  },
} as const;

const planDecisionSchema = {
  type: "object",
  required: ["planId", "version", "report"],
  properties: {
    planId: { type: "string" },
    version: { type: "integer", minimum: 1 },
    report: { type: "string" },
  },
} as const;

const rejectPlanSchema = {
  type: "object",
  required: ["planId", "version", "report"],
  properties: {
    planId: { type: "string" },
    version: { type: "integer", minimum: 1 },
    report: { type: "string" },
    requestedChanges: { type: "string" },
  },
} as const;

const stageRoundSchema = {
  type: "object",
  required: ["stageId", "intent", "workUnits"],
  properties: {
    stageId: { type: "string" },
    title: { type: "string" },
    intent: { type: "string" },
    workUnits: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["title", "objective"],
        properties: {
          title: { type: "string" },
          objective: { type: "string" },
          acceptance: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

const taskDecisionSchema = {
  type: "object",
  required: ["report"],
  properties: {
    report: { type: "string" },
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
