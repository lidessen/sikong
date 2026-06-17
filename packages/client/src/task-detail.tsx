import {
  Bot,
  CheckCircle2,
  CircleDot,
  Clock3,
  Copy,
  FileText,
  GitBranch,
  Hammer,
  Layers3,
  Loader2,
  MessageSquare,
  PlayCircle,
  Wrench,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  CollapsibleMarkdown,
  DetailSection,
  EmptyInline,
  FactRow,
  Metric,
} from "./task-detail-primitives";
import { MarkdownMessage } from "./markdown-message";
import { taskRequestTitle } from "./task-request";
import { LeadDecisionPendingCard } from "./outcome-card";
import { AgentActivityGroup, RoundDetail, RuntimeRunRow, WorkerRunRow } from "./task-detail-rows";
import { TaskTimeline } from "./task-timeline";
import { stageBadgeVariant, stageLabel, taskStageSummary } from "./task-detail-utils";
import {
  currentOperatorLabel,
  nextActionLabel,
  statusBadgeVariant,
  taskPhaseLabel,
} from "./task-labels";
import type { SchedulerStatus, TaskCard, TaskDetailView, TaskPlanStageView } from "./types";

function truncateId(value: string, max = 22): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function CopyIdButton(props: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-6 px-1.5 font-mono text-[11px] text-muted-foreground"
      title={props.value}
      onClick={() => {
        void navigator.clipboard.writeText(props.value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Copy className="size-3" data-icon="inline-start" />
      {copied ? "Copied" : truncateId(props.value)}
    </Button>
  );
}

function TerminalBanner(props: { task: TaskCard }) {
  const terminal = props.task.terminal;
  if (!terminal) return null;
  const accepted = terminal.outcome === "accepted";
  return (
    <div
      className={`flex items-start gap-2.5 rounded-[var(--radius-lg)] border px-3 py-2.5 ${
        accepted
          ? "border-ok/30 bg-[var(--ok-soft)]/40"
          : "border-err/30 bg-[var(--err-soft)]/40"
      }`}
    >
      {accepted ? (
        <CheckCircle2 className="mt-0.5 shrink-0 text-ok" />
      ) : (
        <XCircle className="mt-0.5 shrink-0 text-err" />
      )}
      <div className="min-w-0">
        <p className="text-[13px] font-medium">
          {accepted ? "Task completed successfully" : `Task ${terminal.outcome}`}
        </p>
      </div>
      <Badge variant={accepted ? "ok" : "err"} className="ml-auto shrink-0">
        {terminal.outcome}
      </Badge>
    </div>
  );
}

export function TaskDetailMain(props: {
  task: TaskCard;
  detail: TaskDetailView | null;
  loading: boolean;
  scheduler?: SchedulerStatus;
  onClose: () => void;
  onSendMessage?: (text: string) => void;
}) {
  const projection = props.detail?.projection;
  const stages = projection?.plan?.stages ?? [];
  const rounds = Object.values(projection?.stageRounds ?? {}).sort((a, b) =>
    String(a.startedAt ?? a.id).localeCompare(String(b.startedAt ?? b.id)),
  );
  const workers = Object.values(projection?.workerRuns ?? {}).sort((a, b) =>
    String(a.startedAt ?? a.runId).localeCompare(String(b.startedAt ?? b.runId)),
  );
  const runtimeRuns = Object.values(projection?.runtimeProcessRuns ?? {}).sort((a, b) =>
    String(a.startedAt).localeCompare(String(b.startedAt)),
  );
  const processRunSnapshots = new Map(
    (props.detail?.processRuns ?? []).map((run) => [run.runId, run] as const),
  );
  const observationGroups = [...(props.detail?.observations ?? [])].sort((a, b) => {
    const lastA = a.observations.at(-1)?.at ?? "";
    const lastB = b.observations.at(-1)?.at ?? "";
    return lastB.localeCompare(lastA);
  });
  const round = props.task.activeRound;
  const roundPercent = round
    ? Math.round((round.completedWorkUnits / Math.max(round.workUnits, 1)) * 100)
    : 0;
  const schedulerTaskKey = `${props.task.workspaceId}/${props.task.taskId}`;
  const schedulerActive = props.scheduler?.activeTasks?.includes(schedulerTaskKey);
  const schedulerIdleRunnable =
    props.task.runtimeProcesses.running === 0 &&
    props.task.runtimeProcesses.queued === 0 &&
    !props.task.terminal &&
    !["await_worker_results", "blocked", "terminal"].includes(props.task.nextAction.type) &&
    Boolean(props.scheduler?.enabled) &&
    !schedulerActive;
  const schedulerLabel = schedulerActive
    ? "active"
    : schedulerIdleRunnable
      ? "idle with runnable action"
      : props.scheduler?.paused
        ? "paused"
        : props.scheduler?.enabled
          ? "watching"
          : "unavailable";

  return (
    <div className="mx-auto flex max-w-[1080px] flex-col gap-3">
      <TerminalBanner task={props.task} />

      <section className="rounded-[var(--radius-lg)] border bg-card/92 p-3 sm:p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge variant={statusBadgeVariant(props.task)}>{taskPhaseLabel(props.task)}</Badge>
          <CopyIdButton value={props.task.taskId} />
          {props.loading ? (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Refreshing
            </span>
          ) : null}
        </div>

        {props.task.request ? (
          <div className="min-w-0">
            <h2 className="sr-only">{taskRequestTitle(props.task.request)}</h2>
            <CollapsibleMarkdown title="Request" text={props.task.request}>
              <MarkdownMessage text={props.task.request} />
            </CollapsibleMarkdown>
          </div>
        ) : (
          <h2 className="text-[15px] font-semibold leading-6">{props.task.nextAction.type}</h2>
        )}

        <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
          {nextActionLabel(props.task)} · {currentOperatorLabel(props.task)}
        </p>

        {props.task.terminal?.report ? (
          <details className="group mt-3 rounded-[var(--radius-md)] border border-border-soft bg-background/70">
            <summary className="cursor-pointer list-none px-3 py-2 text-[12px] font-medium text-muted-foreground marker:content-none [&::-webkit-details-marker]:hidden">
              Outcome report · {props.task.terminal.outcome}
              <span className="ml-2 text-primary group-open:hidden">Show report</span>
            </summary>
            <div className="border-t border-border-soft px-3 py-3">
              <MarkdownMessage text={props.task.terminal.report} />
            </div>
          </details>
        ) : null}

        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs lg:grid-cols-4">
          <Metric icon={<Bot />} label="Owner" value={currentOperatorLabel(props.task)} />
          <Metric
            icon={<Clock3 />}
            label="Runtime"
            value={`${props.task.runtimeProcesses.running} running · ${props.task.runtimeProcesses.queued} queued`}
          />
          <Metric
            icon={<Layers3 />}
            label="Plan"
            value={
              props.task.plan
                ? `${props.task.plan.status ?? "draft"} · ${props.task.plan.stageCount} stages`
                : "none"
            }
          />
          <Metric icon={<CircleDot />} label="Next" value={nextActionLabel(props.task)} />
        </dl>

        <div className="mt-3 rounded-[var(--radius-md)] border border-border bg-background p-2.5">
          <FactRow label="Scheduler" value={schedulerLabel} />
          <FactRow label="Stage" value={taskStageSummary(props.task, props.detail)} />
          {round ? (
            <div className="mt-2 space-y-1.5">
              <FactRow label="Round" value={round.title ?? round.intent} />
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-[width] ${props.task.terminal ? "bg-neutral" : "bg-info"}`}
                  style={{ width: `${roundPercent}%` }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {round.startedWorkUnits} started · {round.runningWorkUnits} running ·{" "}
                {round.completedWorkUnits} completed / {round.workUnits}
              </p>
            </div>
          ) : (
            <div className="mt-2">
              <FactRow label="Round" value="waiting for Lead round planning" />
            </div>
          )}
        </div>
      </section>

      {props.task.waitingForLead ? (
        <LeadDecisionPendingCard
          taskId={props.task.taskId}
          nextActionType={props.task.nextAction.type}
          planStatus={props.task.plan?.status}
          report={
            props.detail?.projection.planDecision?.report ??
            props.detail?.projection.finalReview?.report
          }
          onSendMessage={props.onSendMessage}
        />
      ) : null}

      <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-3">
          <DetailSection
            title="Agent activity"
            icon={<Wrench />}
            count={observationGroups.length}
            defaultOpen={observationGroups.length > 0}
          >
            {observationGroups.length > 0 ? (
              <div className="flex flex-col gap-2">
                {observationGroups.map((group) => (
                  <AgentActivityGroup
                    key={group.runId}
                    group={group}
                    worker={workers.find((worker) => worker.runId === group.runId)}
                    rounds={rounds}
                  />
                ))}
              </div>
            ) : (
              <EmptyInline text="No live thinking, text, or tool activity has been recorded yet." />
            )}
          </DetailSection>

          <DetailSection
            title="Plan"
            icon={<FileText />}
            count={stages.length}
            defaultOpen={stages.length > 0}
          >
            {stages.length > 0 ? (
              <>
                <PlanStageStepper detail={props.detail} stages={stages} />
                <div className="mt-3 flex flex-col divide-y divide-divider">
                {stages.map((stage, index) => (
                  <div
                    key={stage.id}
                    className="grid gap-2 py-2.5 sm:grid-cols-[120px_minmax(0,1fr)]"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={stageBadgeVariant(props.detail, stage.id)}>
                        {stageLabel(props.detail, stage.id, index)}
                      </Badge>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium">{stage.title}</p>
                      <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                        {stage.objective}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {stage.acceptance.length} acceptance items
                      </p>
                    </div>
                  </div>
                ))}
                </div>
              </>
            ) : (
              <EmptyInline text="No submitted plan yet." />
            )}
          </DetailSection>

          <DetailSection
            title="Rounds"
            icon={<GitBranch />}
            count={rounds.length}
            defaultOpen={rounds.length > 0}
          >
            {rounds.length > 0 ? (
              <div className="flex flex-col gap-2">
                {rounds.map((item) => (
                  <RoundDetail key={item.id} round={item} workers={workers} />
                ))}
              </div>
            ) : (
              <EmptyInline text="No stage rounds planned yet." />
            )}
          </DetailSection>

          <DetailSection
            title="Workers"
            icon={<Hammer />}
            count={workers.length}
            defaultOpen={workers.length > 0}
          >
            {workers.length > 0 ? (
              <div className="flex flex-col gap-2">
                {workers.map((worker) => (
                  <WorkerRunRow key={worker.runId} worker={worker} rounds={rounds} />
                ))}
              </div>
            ) : (
              <EmptyInline text="No worker runs have started." />
            )}
          </DetailSection>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <DetailSection
            title="Runtime diagnostics"
            icon={<PlayCircle />}
            count={runtimeRuns.length}
            defaultOpen={Boolean(props.detail?.processRunError) || runtimeRuns.length > 0}
          >
            {props.detail?.processRunError ? (
              <p className="mb-2 rounded-[var(--radius-md)] border border-err/30 bg-[var(--err-soft)] p-2 text-[12px] text-err">
                {props.detail.processRunError}
              </p>
            ) : null}
            {runtimeRuns.length > 0 ? (
              <details className="group">
                <summary className="cursor-pointer rounded-[var(--radius-md)] border bg-background px-2.5 py-2 text-[12px] text-muted-foreground marker:text-muted-foreground hover:text-foreground">
                  Process snapshots, commands, and I/O
                </summary>
                <div className="mt-2 flex flex-col gap-1.5">
                  {runtimeRuns.map((processRun) => (
                    <RuntimeRunRow
                      key={processRun.processRunId}
                      processRun={processRun}
                      snapshot={processRunSnapshots.get(processRun.processRunId)}
                    />
                  ))}
                </div>
              </details>
            ) : (
              <EmptyInline text="No runtime process records." />
            )}
          </DetailSection>

          <DetailSection
            title="Timeline"
            icon={<MessageSquare />}
            count={props.detail?.trace.length ?? 0}
            defaultOpen={(props.detail?.trace.length ?? 0) > 0}
          >
            {props.detail?.trace.length ? (
              <TaskTimeline entries={props.detail.trace} />
            ) : (
              <EmptyInline text="No timeline events loaded." />
            )}
          </DetailSection>
        </div>
      </section>
    </div>
  );
}

function PlanStageStepper(props: {
  detail: TaskDetailView | null;
  stages: TaskPlanStageView[];
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      {props.stages.map((stage, index) => {
        const variant = stageBadgeVariant(props.detail, stage.id);
        const dotClass =
          variant === "ok"
            ? "bg-ok ring-ok/30"
            : variant === "info"
              ? "bg-info ring-info/30"
              : "bg-muted-foreground/35 ring-border";
        return (
          <div key={stage.id} className="flex min-w-0 items-center gap-1">
            <div
              className={`size-2.5 shrink-0 rounded-full ring-2 ${dotClass}`}
              title={stage.title}
            />
            {index < props.stages.length - 1 ? (
              <div className="h-px w-5 shrink-0 bg-border-strong" />
            ) : null}
          </div>
        );
      })}
      <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
        {props.detail?.projection.acceptedStageIds.length ?? 0}/{props.stages.length} done
      </span>
    </div>
  );
}
