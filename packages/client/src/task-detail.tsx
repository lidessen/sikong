import {
  ArrowLeft,
  Bot,
  CircleDot,
  Clock3,
  FileText,
  GitBranch,
  Hammer,
  Layers3,
  Loader2,
  MessageSquare,
  PlayCircle,
  Wrench,
} from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { DetailSection, EmptyInline, FactRow, Metric } from "./task-detail-primitives";
import { AgentActivityGroup, RoundDetail, RuntimeRunRow, WorkerRunRow } from "./task-detail-rows";
import { formatTime, stageBadgeVariant, stageLabel, taskStageSummary } from "./task-detail-utils";
import {
  currentOperatorLabel,
  nextActionLabel,
  statusBadgeVariant,
  taskPhaseLabel,
} from "./task-labels";
import type { SchedulerStatus, TaskCard, TaskDetailView } from "./types";

export function TaskDetailMain(props: {
  task: TaskCard;
  detail: TaskDetailView | null;
  loading: boolean;
  scheduler?: SchedulerStatus;
  onClose: () => void;
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

  return (
    <div className="mx-auto flex max-w-[1080px] flex-col gap-3">
      <section className="rounded-[var(--radius-lg)] border bg-card/92 p-3 sm:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <Badge variant={statusBadgeVariant(props.task)}>{taskPhaseLabel(props.task)}</Badge>
              <span className="font-mono text-[11px] text-muted-foreground">
                {props.task.taskId}
              </span>
              {props.loading ? (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Loader2 className="animate-spin" />
                  refreshing
                </span>
              ) : null}
            </div>
            <h2 className="text-[15px] font-semibold leading-6">
              {props.task.request ?? props.task.nextAction.type}
            </h2>
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
              {nextActionLabel(props.task)} · {currentOperatorLabel(props.task)}
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={props.onClose}>
            <ArrowLeft data-icon="inline-start" />
            Chat
          </Button>
        </div>

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
          <FactRow
            label="Scheduler"
            value={
              schedulerActive
                ? "active"
                : schedulerIdleRunnable
                  ? "idle with runnable action"
                  : props.scheduler?.paused
                    ? "paused"
                    : props.scheduler?.enabled
                      ? "watching"
                      : "unavailable"
            }
          />
          <FactRow label="Stage" value={taskStageSummary(props.task, props.detail)} />
          {round ? (
            <div className="mt-2 space-y-1.5">
              <FactRow label="Round" value={round.title ?? round.intent} />
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-info"
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

      <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-3">
          <DetailSection title="Agent activity" icon={<Wrench />} count={observationGroups.length}>
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

          <DetailSection title="Plan" icon={<FileText />} count={stages.length}>
            {stages.length > 0 ? (
              <div className="flex flex-col divide-y divide-divider">
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
            ) : (
              <EmptyInline text="No submitted plan yet." />
            )}
          </DetailSection>

          <DetailSection title="Rounds" icon={<GitBranch />} count={rounds.length}>
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

          <DetailSection title="Workers" icon={<Hammer />} count={workers.length}>
            {workers.length > 0 ? (
              <div className="overflow-x-auto">
                <div className="min-w-[620px] divide-y divide-divider">
                  {workers.map((worker) => (
                    <WorkerRunRow key={worker.runId} worker={worker} rounds={rounds} />
                  ))}
                </div>
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
          >
            {props.detail?.processRunError ? (
              <p className="mb-2 rounded-[var(--radius-md)] border border-err/30 bg-err/10 p-2 text-[12px] text-err">
                {props.detail.processRunError}
              </p>
            ) : null}
            {runtimeRuns.length > 0 ? (
              <details className="group">
                <summary className="cursor-pointer rounded-[var(--radius-md)] border bg-background px-2.5 py-2 text-[12px] text-muted-foreground marker:text-muted-foreground hover:text-foreground">
                  Show process snapshots, commands, stdout/stderr, and timeout diagnostics
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
          >
            {props.detail?.trace.length ? (
              <div className="flex max-h-[420px] flex-col gap-1.5 overflow-auto pr-1">
                {props.detail.trace.map((entry) => (
                  <div
                    key={entry.eventId}
                    className="rounded-[var(--radius-md)] border bg-background p-2"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <Badge variant="outline">{entry.type}</Badge>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {formatTime(entry.createdAt)}
                      </span>
                    </div>
                    <p className="text-[12px] leading-5 text-muted-foreground">{entry.summary}</p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyInline text="No timeline events loaded." />
            )}
          </DetailSection>
        </div>
      </section>
    </div>
  );
}
