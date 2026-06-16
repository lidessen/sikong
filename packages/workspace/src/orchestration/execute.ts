import type { AgentLoop, TaskInput, TaskResult as AgentTaskResult } from "agent-loop";
import {
  completeStageRound,
  startStageReview,
  type CommandContext,
  type CommandResult,
} from "../commands";
import { fail, ok } from "../commands";
import { runWorkerLoop, runWorkerTask, type RunWorkerTaskResult } from "../runtime";
import type { TaskProjection } from "../coordination";
import type { OrchestrationAction } from "./tick";

export interface OrchestrationLoopSummary {
  status?: string;
  stopReason?: string;
  text?: string;
  eventCount?: number;
  messageCount?: number;
}

export interface OrchestrationExecutionRuntime {
  loop?: AgentLoop;
  runTask?: (input: TaskInput) => Promise<AgentTaskResult>;
}

export interface OrchestrationWorkerRunSummary {
  runId: string;
  taskResult: {
    status: AgentTaskResult["status"];
    report?: string;
  };
}

export type OrchestrationExecutionResult =
  | {
      resultType: "loop_completed";
      actionType:
        | "start_lead_requirement_spec"
        | "start_planning_worker"
        | "start_lead_plan_decision"
        | "start_lead_round_planning"
        | "start_lead_final_decision"
        | "start_stage_verification_worker"
        | "start_final_verification_worker";
      loopResult: OrchestrationLoopSummary;
    }
  | {
      resultType: "worker_task_completed";
      run: OrchestrationWorkerRunSummary;
      projection: TaskProjection;
    }
  | {
      resultType: "worker_tasks_completed";
      runs: OrchestrationWorkerRunSummary[];
      projection: TaskProjection;
    }
  | {
      resultType: "stage_review_started";
      reviewId: string;
      projection: TaskProjection;
    }
  | {
      resultType: "stage_round_completed";
      roundId: string;
      projection: TaskProjection;
    }
  | {
      resultType: "waiting";
      waitFor: "worker_results";
      taskId: string;
      stageId?: string;
      runningRuns?: number;
      targetRuns?: number;
    }
  | {
      resultType: "terminal";
      taskId: string;
      outcome: "accepted" | "rejected";
    }
  | {
      resultType: "blocked";
      taskId: string;
      reason: string;
    };

export async function executeOrchestrationAction(
  ctx: CommandContext,
  action: OrchestrationAction,
  runtime: OrchestrationExecutionRuntime,
): Promise<CommandResult<OrchestrationExecutionResult>> {
  switch (action.type) {
    case "start_lead_requirement_spec":
    case "start_planning_worker":
    case "start_lead_plan_decision":
    case "start_lead_round_planning":
    case "start_lead_final_decision":
    case "start_stage_verification_worker":
    case "start_final_verification_worker": {
      if (!runtime.loop) {
        return fail("invalid_input", "Agent loop is required for this orchestration action.", {
          actionType: action.type,
        });
      }
      const loopResult = await runWorkerLoop({ ...action.spec, loop: runtime.loop });
      return ok({
        resultType: "loop_completed",
        actionType: action.type,
        loopResult: summarizeLoopResult(loopResult),
      });
    }

    case "complete_stage_round": {
      const completed = await completeStageRound(ctx, {
        workspaceId: action.workspaceId,
        taskId: action.taskId,
        roundId: action.roundId,
      });
      if (!completed.ok) return completed;
      return ok({
        resultType: "stage_round_completed",
        roundId: action.roundId,
        projection: completed.data.projection,
      });
    }

    case "start_stage_worker": {
      if (!runtime.runTask) {
        return fail("invalid_input", "runTask is required for stage worker execution.", {
          actionType: action.type,
        });
      }
      const run = await runWorkerTask(ctx, {
        ...action.input,
        runTask: runtime.runTask,
      });
      if (!run.ok) return run;
      return ok({
        resultType: "worker_task_completed",
        run: summarizeWorkerRun(run.data),
        projection: run.data.projection,
      });
    }

    case "start_stage_workers": {
      if (!runtime.runTask) {
        return fail("invalid_input", "runTask is required for stage worker execution.", {
          actionType: action.type,
        });
      }
      const runs = await Promise.all(
        action.inputs.map((input) =>
          runWorkerTask(ctx, {
            ...input,
            runTask: runtime.runTask!,
          }),
        ),
      );
      const failed = runs.find((run) => !run.ok);
      if (failed && !failed.ok) return failed;
      const completed = runs.filter((run): run is Extract<typeof run, { ok: true }> => run.ok);
      return ok({
        resultType: "worker_tasks_completed",
        runs: completed.map((run) => summarizeWorkerRun(run.data)),
        projection: completed.at(-1)!.data.projection,
      });
    }

    case "start_stage_review": {
      const review = await startStageReview(ctx, {
        workspaceId: action.workspaceId,
        taskId: action.taskId,
        stageId: action.stageId,
      });
      if (!review.ok) return review;
      return ok({
        resultType: "stage_review_started",
        reviewId: review.data.reviewId,
        projection: review.data.projection,
      });
    }

    case "await_worker_results":
      return ok({
        resultType: "waiting",
        waitFor: "worker_results",
        taskId: action.taskId,
        stageId: action.stageId,
        runningRuns: action.runningRuns,
        targetRuns: action.targetRuns,
      });

    case "terminal":
      return ok({
        resultType: "terminal",
        taskId: action.taskId,
        outcome: action.outcome,
      });

    case "blocked":
      return ok({
        resultType: "blocked",
        taskId: action.taskId,
        reason: action.reason,
      });
  }
}

function summarizeLoopResult(loopResult: unknown): OrchestrationLoopSummary {
  if (!loopResult || typeof loopResult !== "object") {
    return { text: truncateText(String(loopResult ?? ""), 1_000) };
  }

  const record = loopResult as Record<string, unknown>;
  return {
    ...stringField(record, "status"),
    ...stringField(record, "stopReason"),
    ...textField(record),
    ...arrayCount(record, "events", "eventCount"),
    ...arrayCount(record, "messages", "messageCount"),
  };
}

function stringField(record: Record<string, unknown>, key: "status" | "stopReason") {
  const value = record[key];
  return typeof value === "string" && value.trim() ? { [key]: value } : {};
}

function textField(record: Record<string, unknown>): Pick<OrchestrationLoopSummary, "text"> {
  const value = record.outcomeText ?? record.text ?? record.output;
  return typeof value === "string" && value.trim()
    ? { text: truncateText(value.trim(), 2_000) }
    : {};
}

function arrayCount(
  record: Record<string, unknown>,
  sourceKey: string,
  targetKey: "eventCount" | "messageCount",
) {
  const value = record[sourceKey];
  return Array.isArray(value) ? { [targetKey]: value.length } : {};
}

function truncateText(text: string, maxLength: number): string | undefined {
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function summarizeWorkerRun(run: RunWorkerTaskResult): OrchestrationWorkerRunSummary {
  return {
    runId: run.runId,
    taskResult: {
      status: run.taskResult.status,
      ...(run.taskResult.report ? { report: truncateText(run.taskResult.report, 2_000) } : {}),
    },
  };
}
