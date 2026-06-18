import {
  CheckCircle2,
  Copy,
  FileText,
  Loader2,
  MessageSquare,
  PlayCircle,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { DetailSection, EmptyInline, FactRow } from "./task-detail-primitives";
import { MarkdownMessage } from "./markdown-message";
import { taskRequestPreview, taskRequestTitle } from "./task-request";
import { LeadDecisionPendingCard } from "./outcome-card";
import {
  RuntimeRunRow,
  StageRoundCard,
  WorkUnitExecutionDrawer,
  type WorkUnitExecutionTarget,
} from "./task-detail-rows";
import { TaskTimeline } from "./task-timeline";
import { stageBadgeVariant, stageLabel, taskStageSummary } from "./task-detail-utils";
import {
  currentOperatorLabel,
  nextActionLabel,
  statusBadgeVariant,
  taskPhaseLabel,
} from "./task-labels";
import type {
  SchedulerStatus,
  TaskCard,
  TaskDetailView,
  TaskPlanStageView,
  TaskStageRoundView,
  WorkerRunView,
} from "./types";

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
        accepted ? "border-ok/30 bg-[var(--ok-soft)]/40" : "border-err/30 bg-[var(--err-soft)]/40"
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
        {terminal.report ? (
          <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted-foreground">
            {terminal.report}
          </p>
        ) : null}
      </div>
      <Badge variant={accepted ? "ok" : "err"} className="ml-auto shrink-0">
        {terminal.outcome}
      </Badge>
    </div>
  );
}

function TaskRequestCompact(props: { task: TaskCard }) {
  if (!props.task.request) {
    return <h2 className="text-[15px] font-semibold leading-6">{props.task.nextAction.type}</h2>;
  }
  return (
    <details className="group rounded-[var(--radius-md)] border border-border-soft bg-background/70">
      <summary className="cursor-pointer list-none px-3 py-2 marker:content-none [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="sr-only">{taskRequestTitle(props.task.request)}</h2>
            <p className="text-[12px] font-medium text-foreground">Request</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground group-open:hidden">
              {taskRequestPreview(props.task.request, 180)}
            </p>
          </div>
          <span className="shrink-0 text-[11px] text-primary group-open:hidden">Show full</span>
        </div>
      </summary>
      <div className="border-t border-border-soft px-3 py-3">
        <MarkdownMessage text={props.task.request} />
      </div>
    </details>
  );
}

function PlanOverviewCard(props: {
  task: TaskCard;
  detail: TaskDetailView | null;
  stages: TaskPlanStageView[];
}) {
  const plan = props.detail?.projection.plan;
  const acceptedStages = props.detail?.projection.acceptedStageIds.length ?? 0;
  const currentStage =
    props.stages.find((stage) => stage.id === props.detail?.projection.currentStageId) ??
    props.stages[0];
  const planStatus = props.task.plan?.status ?? props.detail?.projection.planDecision?.status;
  const objective =
    plan?.summary ??
    props.task.request ??
    (props.task.currentStage ? props.task.currentStage.title : props.task.nextAction.type);
  const activeRound = props.task.activeRound;
  const runningWorkers = Object.values(props.detail?.projection.workerRuns ?? {}).filter(
    (worker) => worker.status === "running",
  ).length;

  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-background/75 p-3">
      <div className="flex flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Badge variant={plan ? "info" : "outline"}>{plan ? "Plan" : "Plan pending"}</Badge>
            <Badge variant="outline">
              {planStatus ? planStatus.replaceAll("_", " ") : "not submitted"}
            </Badge>
            {props.stages.length > 0 ? (
              <Badge variant="outline">
                {acceptedStages}/{props.stages.length} stages accepted
              </Badge>
            ) : null}
          </div>
          <h2 className="line-clamp-2 text-[15px] font-semibold leading-6">
            {taskRequestPreview(objective, 180)}
          </h2>
          {currentStage ? (
            <div className="mt-3 rounded-[var(--radius-md)] border border-border-soft bg-surface px-2.5 py-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="truncate text-[12px] font-medium">{currentStage.title}</p>
                <Badge variant={stageBadgeVariant(props.detail, currentStage.id)}>
                  {props.detail?.projection.currentStageId === currentStage.id
                    ? "current"
                    : props.detail?.projection.acceptedStageIds.includes(currentStage.id)
                      ? "done"
                      : "next"}
                </Badge>
              </div>
              <p className="line-clamp-2 text-[12px] leading-5 text-muted-foreground">
                {currentStage.objective}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
              Sikong has not submitted a stage plan yet.
            </p>
          )}
        </div>

        <div className="grid gap-2 text-[12px]">
          <div className="rounded-[var(--radius-md)] border border-border-soft bg-surface px-2.5 py-2">
            <FactRow label="Next" value={nextActionLabel(props.task)} />
            <FactRow label="Owner" value={currentOperatorLabel(props.task)} />
            <FactRow label="Workers" value={`${runningWorkers} running`} />
          </div>
          {activeRound ? (
            <div className="rounded-[var(--radius-md)] border border-border-soft bg-surface px-2.5 py-2">
              <FactRow label="Round" value={activeRound.title ?? activeRound.intent} />
              <FactRow
                label="Units"
                value={`${activeRound.completedWorkUnits}/${activeRound.workUnits} done`}
              />
            </div>
          ) : null}
        </div>
      </div>

      {currentStage?.acceptance.length ? (
        <div className="mt-3 rounded-[var(--radius-md)] border border-border-soft bg-surface px-2.5 py-2">
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">Acceptance scope</p>
          <ul className="grid gap-1 text-[11px] leading-4 text-muted-foreground sm:grid-cols-2">
            {currentStage.acceptance.slice(0, 4).map((item) => (
              <li key={item} className="min-w-0">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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
  const [workUnitDetail, setWorkUnitDetail] = useState<WorkUnitExecutionTarget | null>(null);
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
  const observationGroupsByRunId = new Map(
    observationGroups.map((group) => [group.runId, group] as const),
  );
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

  useEffect(() => {
    if (!workUnitDetail) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setWorkUnitDetail(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workUnitDetail]);

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

        <PlanOverviewCard task={props.task} detail={props.detail} stages={stages} />

        <div className="mt-3">
          <TaskRequestCompact task={props.task} />
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
          <Badge variant="outline">Owner · {currentOperatorLabel(props.task)}</Badge>
          <Badge variant="outline">Next · {nextActionLabel(props.task)}</Badge>
          <Badge variant="outline">
            Runtime · {props.task.runtimeProcesses.running} running /{" "}
            {props.task.runtimeProcesses.queued} queued
          </Badge>
          <Badge variant="outline">
            Plan ·{" "}
            {props.task.plan
              ? `${props.task.plan.status ?? "draft"} / ${props.task.plan.stageCount} stages`
              : "none"}
          </Badge>
        </div>

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

        <div className="mt-3 rounded-[var(--radius-md)] border border-border bg-background/75 p-2.5">
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
            title="Stages"
            icon={<FileText />}
            count={stages.length}
            defaultOpen={stages.length > 0}
          >
            {stages.length > 0 ? (
              <>
                <PlanStageStepper detail={props.detail} stages={stages} />
                <div className="mt-3 flex flex-col gap-3">
                  {stages.map((stage, index) => (
                    <PlanStagePanel
                      key={stage.id}
                      detail={props.detail}
                      stage={stage}
                      index={index}
                      rounds={rounds.filter((item) => item.stageId === stage.id)}
                      workers={workers.filter((worker) => worker.stageId === stage.id)}
                      observationGroups={observationGroupsByRunId}
                      onOpenWorkUnitDetail={setWorkUnitDetail}
                    />
                  ))}
                </div>
              </>
            ) : (
              <EmptyInline text="No submitted plan yet." />
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
      <WorkUnitExecutionDrawer target={workUnitDetail} onClose={() => setWorkUnitDetail(null)} />
    </div>
  );
}

function PlanStagePanel(props: {
  detail: TaskDetailView | null;
  stage: TaskPlanStageView;
  index: number;
  rounds: TaskStageRoundView[];
  workers: WorkerRunView[];
  observationGroups: Map<string, TaskDetailView["observations"][number]>;
  onOpenWorkUnitDetail: (target: WorkUnitExecutionTarget) => void;
}) {
  const variant = stageBadgeVariant(props.detail, props.stage.id);
  const completedWorkers = props.workers.filter((worker) => worker.status === "completed").length;
  const runningWorkers = props.workers.filter((worker) => worker.status === "running").length;
  const reviews = Object.values(props.detail?.projection.stageReviews ?? {})
    .filter((review) => review.stageId === props.stage.id)
    .sort((a, b) =>
      String(b.finishedAt ?? b.startedAt ?? "").localeCompare(
        String(a.finishedAt ?? a.startedAt ?? ""),
      ),
    );
  const latestReview = reviews[0];

  return (
    <article className="rounded-[var(--radius-lg)] border border-border bg-card/75">
      <div className="grid gap-3 border-b border-divider px-3 py-3 lg:grid-cols-[140px_minmax(0,1fr)]">
        <div className="flex items-start gap-2 lg:flex-col lg:gap-1.5">
          <Badge variant={variant}>{stageLabel(props.detail, props.stage.id, props.index)}</Badge>
          <span className="font-mono text-[11px] text-muted-foreground" title={props.stage.id}>
            {truncateId(props.stage.id)}
          </span>
        </div>
        <div className="min-w-0">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h3 className="truncate text-[14px] font-semibold">{props.stage.title}</h3>
              <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                {props.stage.objective}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              <Badge variant="outline">{props.rounds.length} rounds</Badge>
              <Badge
                variant={runningWorkers > 0 ? "info" : completedWorkers > 0 ? "ok" : "outline"}
              >
                {completedWorkers}/{props.workers.length} workers
              </Badge>
            </div>
          </div>

          <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)]">
            <div className="rounded-[var(--radius-md)] border border-border-soft bg-background/70 px-2.5 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">Acceptance</p>
              <ul className="mt-1 space-y-1 text-[11px] leading-4 text-muted-foreground">
                {props.stage.acceptance.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-[var(--radius-md)] border border-border-soft bg-background/70 px-2.5 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">Review</p>
              {latestReview ? (
                <div className="mt-1 space-y-1">
                  <Badge
                    variant={
                      latestReview.status === "accepted"
                        ? "ok"
                        : latestReview.status === "rejected"
                          ? "err"
                          : "accent"
                    }
                  >
                    {latestReview.status}
                  </Badge>
                  {latestReview.report ? (
                    <p className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                      {latestReview.report}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-1 text-[11px] text-muted-foreground">No stage review yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 px-3 py-3">
        {props.rounds.length > 0 ? (
          props.rounds.map((round) => (
            <StageRoundCard
              key={round.id}
              round={round}
              workers={props.workers}
              observationGroups={props.observationGroups}
              onOpenWorkUnitDetail={props.onOpenWorkUnitDetail}
            />
          ))
        ) : (
          <EmptyInline text="No rounds planned for this stage yet." />
        )}
      </div>
    </article>
  );
}

function PlanStageStepper(props: { detail: TaskDetailView | null; stages: TaskPlanStageView[] }) {
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
