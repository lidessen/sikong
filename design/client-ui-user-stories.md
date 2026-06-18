# Client UI User Stories

This document defines the operator-facing interaction model for the Sikong
client UI. The operator is not a worker supervisor and should not need to watch
internal agent plumbing. The UI should expose goals, plans, progress, decisions,
and drill-down evidence at the right level.

## Primary User

The primary user is the client-agent operator: they describe intent, approve or
revise direction, check overall progress, and inspect details only when they
need confidence or intervention.

## Stories

1. As an operator, I want to describe my goal directly in the composer so that I
   do not need to understand workspaces, rounds, or worker internals first.

   Acceptance:
   - The composer remains the entry point for the next user message.
   - During a running turn, the composer remains editable for drafting.
   - Running state does not turn the composer into a blocking cancel panel.

2. As an operator, I want high-level turn status so that I know whether Sikong is
   working or stuck.

   Acceptance:
   - The visible phases use operator language such as understanding the request,
     checking context, updating work, and preparing the response.
   - Internal pipeline labels such as context packets, focus workspace, or model
     loops are not the primary UI.
   - Long turns show elapsed time and recent activity summary.

3. As an operator, I want to cancel a running turn without making cancel the main
   interaction.

   Acceptance:
   - Cancel is a secondary stop control.
   - Cancel does not replace the send affordance or disable drafting.
   - Cancellation messages distinguish user cancel, timeout, and disconnect
     recovery failure when that information is known.

4. As an operator, I want the work detail page to start from the plan so that I
   can judge whether the work is pointed at the right outcome.

   Acceptance:
   - The top of work detail shows objective, plan status, stages, and current
     stage before low-level runtime details.
   - Plan content is written in user-facing language.
   - Pending plan decisions expose clear accept, revise, or stop actions.

5. As an operator, I want progress grouped by stage so that I can understand
   where the task is in the plan.

   Acceptance:
   - The first structural level is stages.
   - A stage shows objective, acceptance, status, and review state.
   - Rounds are shown under the relevant stage.

6. As an operator, I want work units shown as a compact grid inside a round so
   that parallel execution is scannable.

   Acceptance:
   - Each work unit card shows title, status, short result or objective, and
     timing.
   - The grid does not expand worker logs inline by default.
   - Failed work units expose the reason and next useful action when available.

7. As an operator, I want to open a work unit detail drawer so that I can inspect
   evidence only when needed.

   Acceptance:
   - The drawer contains task description, acceptance scope, worker identity,
     result/report, and execution activity.
   - Execution activity is chronological.
   - Tool calls, thinking, token usage, and raw execution details live in this
     drill-down surface rather than the primary page.

8. As an operator, I want failures to explain impact and next steps instead of
   only showing failed.

   Acceptance:
   - Failed cards include a human-readable reason when available.
   - The UI suggests retry, revise scope, split work, or ignore/close when those
     actions are valid.
   - Logs and raw traces are secondary evidence, not the first screen.

9. As an operator, I want logs to look like logs so that I can debug service
   issues without reading raw concatenated text.

   Acceptance:
   - Default logs expose time, source, level, component, and message.
   - Raw mode remains available for advanced debugging.
   - Filtering by source, level, and keyword should be possible once logs move
     into the client UI.

10. As an operator, I want to know that background work is active without
    watching every tool call.

    Acceptance:
    - The chat surface shows work overview and decision points.
    - The task detail surface shows plan, stages, rounds, and work units.
    - The work unit drawer shows worker/tool execution detail.

## Interaction Architecture

- Chat: composer, high-level turn status, work overview, and assistant outcome.
- Work detail: objective, plan status, stages, rounds, and work unit grid.
- Work unit drawer: worker report, acceptance evidence, observations, tool
  calls, usage, and low-level execution.
- Logs: table-like operational stream with raw mode available.

## Design Rules

- Default to user-decision information.
- Hide implementation mechanics until drill-down.
- Do not block drafting while a turn runs.
- Present progress as work narrative, not telemetry.
- Every failure state should answer what happened, what it affects, and what the
  operator can do next.
