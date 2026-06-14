import type { AgentLoop, TaskInput, TaskResult as AgentTaskResult } from "agent-loop";
import { startStageReview, type CommandContext, type CommandResult } from "../commands";
import { fail, ok } from "../commands";
import { runWorkerLoop, runWorkerTask, type RunWorkerTaskResult } from "../runtime";
import type { TaskProjection } from "../coordination";
import type { OrchestrationAction } from "./tick";

export interface OrchestrationExecutionRuntime {
  loop?: AgentLoop;
  runTask?: (input: TaskInput) => Promise<AgentTaskResult>;
}

export type OrchestrationExecutionResult =
  | {
      resultType: "loop_completed";
      actionType:
        | "start_planning_worker"
        | "start_stage_verification_worker"
        | "start_final_verification_worker";
      loopResult: unknown;
    }
  | {
      resultType: "worker_task_completed";
      run: RunWorkerTaskResult;
      projection: TaskProjection;
    }
  | {
      resultType: "stage_review_started";
      reviewId: string;
      projection: TaskProjection;
    }
  | {
      resultType: "waiting";
      waitFor: "plan_decision" | "final_decision";
      taskId: string;
      planId?: string;
      version?: number;
      recommendation?: "accept" | "reject";
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
    case "start_planning_worker":
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
        loopResult,
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
        run: run.data,
        projection: run.data.projection,
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

    case "await_plan_decision":
      return ok({
        resultType: "waiting",
        waitFor: "plan_decision",
        taskId: action.taskId,
        ...(action.planId ? { planId: action.planId } : {}),
        ...(action.version !== undefined ? { version: action.version } : {}),
      });

    case "await_final_decision":
      return ok({
        resultType: "waiting",
        waitFor: "final_decision",
        taskId: action.taskId,
        ...(action.recommendation ? { recommendation: action.recommendation } : {}),
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
