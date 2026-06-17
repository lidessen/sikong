import { X } from "lucide-react";
import { useState } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  formatToolName,
  groupObservationsForDisplay,
  ObservationView,
  UsageObservationGroup,
} from "./observation-view";
import { actionTypeLabel } from "./task-labels";
import {
  compactArgs,
  elapsedBetween,
  formatDuration,
  formatTime,
  formatTimeout,
  observationLabel,
  observationVariant,
  runtimeStatusVariant,
  workerStatusVariant,
} from "./task-detail-utils";
import type {
  ProcessRunSnapshotView,
  RuntimeProcessRunView,
  TaskDetailView,
  TaskStageRoundView,
  TaskStageWorkUnitView,
  WorkerRunObservation,
  WorkerRunView,
} from "./types";

type ObservationGroup = TaskDetailView["observations"][number];

export interface WorkUnitExecutionTarget {
  round: TaskStageRoundView;
  workUnit: TaskStageWorkUnitView;
  worker?: WorkerRunView;
  observationGroup?: ObservationGroup;
}

function truncateId(value: string, max = 20): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function RoundDetail(props: { round: TaskStageRoundView; workers: WorkerRunView[] }) {
  const workers = props.workers.filter((worker) => worker.roundId === props.round.id);
  const completed = workers.filter((worker) => worker.status === "completed").length;
  const percent = Math.round((completed / Math.max(props.round.workUnits.length, 1)) * 100);
  return (
    <div className="rounded-[var(--radius-md)] border bg-background p-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge variant={props.round.status === "completed" ? "ok" : "info"}>
              {props.round.status}
            </Badge>
            <span className="font-mono text-[11px] text-muted-foreground" title={props.round.id}>
              {truncateId(props.round.id)}
            </span>
          </div>
          <p className="text-[13px] font-medium">{props.round.title ?? props.round.intent}</p>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{props.round.intent}</p>
        </div>
        <Badge variant="outline">
          {completed}/{props.round.workUnits.length} work units
        </Badge>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-info" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {props.round.workUnits.map((unit) => {
          const worker = workers.find((item) => item.workUnitId === unit.id);
          return (
            <div
              key={unit.id}
              className="rounded-[var(--radius-sm)] border border-border-soft bg-surface px-2 py-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-medium">{unit.title}</span>
                <Badge variant={worker ? workerStatusVariant(worker.status) : "outline"}>
                  {worker?.status ?? "pending"}
                </Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                {unit.objective}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function StageRoundCard(props: {
  round: TaskStageRoundView;
  workers: WorkerRunView[];
  observationGroups: Map<string, ObservationGroup>;
  onOpenWorkUnitDetail: (target: WorkUnitExecutionTarget) => void;
}) {
  const workers = props.workers.filter((worker) => worker.roundId === props.round.id);
  const terminal = workers.filter((worker) => worker.status !== "running").length;
  const completed = workers.filter((worker) => worker.status === "completed").length;
  const percent = Math.round((terminal / Math.max(props.round.workUnits.length, 1)) * 100);
  return (
    <div className="rounded-[var(--radius-md)] border border-border-soft bg-background/80">
      <div className="border-b border-border-soft px-3 py-2.5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <Badge variant={props.round.status === "completed" ? "ok" : "info"}>
                {props.round.status}
              </Badge>
              <span className="font-mono text-[11px] text-muted-foreground" title={props.round.id}>
                {truncateId(props.round.id)}
              </span>
            </div>
            <p className="text-[13px] font-semibold">{props.round.title ?? props.round.intent}</p>
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{props.round.intent}</p>
          </div>
          <Badge variant="outline">
            {completed}/{props.round.workUnits.length} completed
          </Badge>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-info" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <div className="grid gap-2 p-3 sm:grid-cols-2 2xl:grid-cols-3">
        {props.round.workUnits.map((unit) => {
          const worker = workers.find((item) => item.workUnitId === unit.id);
          return (
            <WorkUnitTile
              key={unit.id}
              round={props.round}
              workUnit={unit}
              worker={worker}
              observationGroup={worker ? props.observationGroups.get(worker.runId) : undefined}
              onOpen={props.onOpenWorkUnitDetail}
            />
          );
        })}
      </div>
    </div>
  );
}

function WorkUnitTile(props: {
  round: TaskStageRoundView;
  workUnit: TaskStageWorkUnitView;
  worker?: WorkerRunView;
  observationGroup?: ObservationGroup;
  onOpen: (target: WorkUnitExecutionTarget) => void;
}) {
  const worker = props.worker;
  const summary = worker?.result?.summary ?? worker?.objective ?? props.workUnit.objective;
  const observations = props.observationGroup?.observations ?? worker?.result?.observations ?? [];

  return (
    <button
      type="button"
      className="flex min-h-[118px] w-full min-w-0 flex-col justify-between rounded-[var(--radius-md)] border border-border-soft bg-card/55 px-2.5 py-2 text-left outline-none transition-[background-color,border-color] hover:border-border-strong hover:bg-hover/40 focus-visible:border-ring"
      onClick={() =>
        props.onOpen({
          round: props.round,
          workUnit: props.workUnit,
          ...(worker ? { worker } : {}),
          ...(props.observationGroup ? { observationGroup: props.observationGroup } : {}),
        })
      }
    >
      <div className="min-w-0">
        <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2">
          <Badge variant={worker ? workerStatusVariant(worker.status) : "outline"}>
            {worker?.status ?? "pending"}
          </Badge>
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            {observations.length ? `${observations.length} events` : "details"}
          </span>
        </div>
        <p className="line-clamp-2 text-[12px] font-medium leading-4 text-foreground">
          {props.workUnit.title}
        </p>
        <p className="mt-1.5 line-clamp-3 text-[11px] leading-4 text-muted-foreground">{summary}</p>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border-soft pt-1.5 text-[10px] text-muted-foreground">
        <span className="truncate font-mono" title={props.workUnit.id}>
          {truncateId(props.workUnit.id, 14)}
        </span>
        <span className="shrink-0 tabular-nums">
          {worker?.finishedAt
            ? formatTime(worker.finishedAt)
            : worker?.startedAt
              ? formatTime(worker.startedAt)
              : "not started"}
        </span>
      </div>
    </button>
  );
}

export function WorkUnitExecutionDrawer(props: {
  target: WorkUnitExecutionTarget | null;
  onClose: () => void;
}) {
  const target = props.target;
  if (!target) return null;
  const observations = [
    ...(target.observationGroup?.observations ?? target.worker?.result?.observations ?? []),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/45 backdrop-blur-[1px]"
      onClick={props.onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-unit-detail-title"
        className="flex h-full w-full max-w-[760px] flex-col border-l border-border bg-background shadow-[var(--shadow-sheet)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative shrink-0 border-b border-divider px-4 py-3 pr-12">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="absolute right-3 top-3 size-7"
            onClick={props.onClose}
            aria-label="Close work unit detail"
          >
            <X />
          </Button>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Badge variant={target.worker ? workerStatusVariant(target.worker.status) : "outline"}>
              {target.worker?.status ?? "pending"}
            </Badge>
            <span className="font-mono text-[11px] text-muted-foreground" title={target.round.id}>
              {truncateId(target.round.id)}
            </span>
          </div>
          <h3 id="work-unit-detail-title" className="text-[15px] font-semibold">
            {target.workUnit.title}
          </h3>
          <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted-foreground">
            {target.round.title ?? target.round.intent}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          <WorkerExecutionDetail
            workUnit={target.workUnit}
            worker={target.worker}
            observations={observations}
            hiddenObservationCount={0}
          />
        </div>
      </aside>
    </div>
  );
}

function WorkerExecutionDetail(props: {
  workUnit: TaskStageWorkUnitView;
  worker?: WorkerRunView;
  observations: WorkerRunObservation[];
  hiddenObservationCount: number;
}) {
  const worker = props.worker;
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="min-w-0 space-y-2 text-[12px]">
        <div className="rounded-[var(--radius-sm)] border border-border-soft bg-surface px-2.5 py-2">
          <p className="text-[11px] font-medium text-muted-foreground">Objective</p>
          <p className="mt-1 leading-5 text-foreground">{props.workUnit.objective}</p>
        </div>
        {props.workUnit.acceptance?.length ? (
          <div className="rounded-[var(--radius-sm)] border border-border-soft bg-surface px-2.5 py-2">
            <p className="text-[11px] font-medium text-muted-foreground">Acceptance</p>
            <ul className="mt-1 space-y-1 text-[11px] leading-4 text-muted-foreground">
              {props.workUnit.acceptance.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {worker ? (
          <div className="rounded-[var(--radius-sm)] border border-border-soft bg-surface px-2.5 py-2">
            <p className="text-[11px] font-medium text-muted-foreground">Worker</p>
            <div className="mt-1 grid gap-1 font-mono text-[11px] text-muted-foreground">
              <span title={worker.runId}>run {worker.runId}</span>
              {worker.workerId ? (
                <span title={worker.workerId}>worker {worker.workerId}</span>
              ) : null}
            </div>
          </div>
        ) : null}
        {worker?.result?.report ? (
          <div className="rounded-[var(--radius-sm)] border border-border-soft bg-surface px-2.5 py-2">
            <p className="text-[11px] font-medium text-muted-foreground">Report</p>
            <div className="mt-1 text-muted-foreground">
              <ObservationView
                observation={{
                  id: `${worker.runId}_report`,
                  kind: "text",
                  at: worker.finishedAt ?? worker.startedAt ?? new Date(0).toISOString(),
                  summary: worker.result.report,
                }}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="min-w-0">
        <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Execution activity</p>
        {props.observations.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {groupObservationsForDisplay(props.observations).map((item) =>
              item.kind === "usage_group" ? (
                <UsageObservationGroup key={item.id} observations={item.observations} />
              ) : (
                <div
                  key={item.observation.id}
                  className="rounded-[var(--radius-sm)] border border-border-soft bg-surface px-2 py-1.5"
                >
                  <ObservationHeader observation={item.observation} />
                  <div className="mt-1.5">
                    <ObservationView observation={item.observation} />
                  </div>
                </div>
              ),
            )}
            {props.hiddenObservationCount > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {props.hiddenObservationCount} older activity items hidden.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="rounded-[var(--radius-sm)] border border-dashed border-border-soft bg-surface px-2.5 py-2 text-[11px] text-muted-foreground">
            No worker activity captured yet.
          </p>
        )}
      </div>
    </div>
  );
}

export function WorkerRunRow(props: { worker: WorkerRunView; rounds: TaskStageRoundView[] }) {
  const round = props.rounds.find((item) => item.id === props.worker.roundId);
  const workUnit = round?.workUnits.find((item) => item.id === props.worker.workUnitId);
  const title = workUnit?.title ?? props.worker.objective ?? "Worker";
  const summary = props.worker.result?.summary ?? props.worker.objective ?? "No result yet.";
  const started = props.worker.startedAt ? formatTime(props.worker.startedAt) : "not started";
  const finished = props.worker.finishedAt ? formatTime(props.worker.finishedAt) : "running";

  return (
    <div className="rounded-[var(--radius-md)] border bg-background p-2.5 text-[12px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant={workerStatusVariant(props.worker.status)}>{props.worker.status}</Badge>
            <span
              className="font-mono text-[11px] text-muted-foreground"
              title={props.worker.runId}
            >
              {truncateId(props.worker.runId)}
            </span>
          </div>
          <p className="truncate font-medium text-foreground">{title}</p>
          <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-muted-foreground">{summary}</p>
        </div>
        <div className="shrink-0 text-right text-[11px] leading-4 text-muted-foreground tabular-nums">
          <p>{started}</p>
          <p className="text-muted-foreground/80">{finished}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border-soft pt-2 text-[11px] text-muted-foreground">
        <span className="truncate">{round?.title ?? truncateId(props.worker.roundId)}</span>
        {workUnit ? (
          <span className="truncate font-mono" title={props.worker.workUnitId}>
            {truncateId(props.worker.workUnitId, 16)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function ObservationRow(props: { observation: WorkerRunObservation & { runId: string } }) {
  return (
    <div className="rounded-[var(--radius-md)] border bg-background p-2">
      <ObservationHeader observation={props.observation} />
      <div className="mt-1.5">
        <ObservationView observation={props.observation} />
      </div>
    </div>
  );
}

export function AgentActivityGroup(props: {
  group: ObservationGroup;
  worker?: WorkerRunView;
  rounds: TaskStageRoundView[];
}) {
  const round = props.rounds.find((item) => item.id === props.group.roundId);
  const workUnit = round?.workUnits.find((item) => item.id === props.group.workUnitId);
  const recent = [...props.group.observations]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 8);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? recent : recent.slice(0, 3);
  const last = recent[0];

  return (
    <div className="rounded-[var(--radius-md)] border bg-background p-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge variant={props.worker ? workerStatusVariant(props.worker.status) : "outline"}>
              {props.worker?.status ?? "observed"}
            </Badge>
            {last ? (
              <span className="font-mono text-[11px] text-muted-foreground">
                {formatTime(last.at)}
              </span>
            ) : null}
          </div>
          <p className="truncate text-[13px] font-medium">
            {workUnit?.title ?? props.worker?.objective ?? "Worker activity"}
          </p>
          <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted-foreground">
            {workUnit?.objective ?? props.worker?.objective ?? props.group.runId}
          </p>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {props.group.runId.slice(0, 18)}
        </span>
      </div>

      <div className="mt-2.5 flex flex-col gap-1.5">
        {groupObservationsForDisplay(visible).map((item) =>
          item.kind === "usage_group" ? (
            <UsageObservationGroup key={item.id} observations={item.observations} />
          ) : (
            <div
              key={item.observation.id}
              className="rounded-[var(--radius-sm)] border border-border-soft bg-surface px-2 py-1.5"
            >
              <ObservationHeader observation={item.observation} />
              <div className="mt-1.5">
                <ObservationView observation={item.observation} />
              </div>
            </div>
          ),
        )}
        {recent.length > 3 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 self-start px-2 text-[11px] text-muted-foreground"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : `Show ${recent.length - 3} more`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ObservationHeader(props: { observation: WorkerRunObservation }) {
  const toolLabel =
    props.observation.kind === "tool_call" && props.observation.toolName
      ? formatToolName(props.observation.toolName)
      : undefined;

  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <Badge variant={observationVariant(props.observation)}>
          {observationLabel(props.observation)}
        </Badge>
        {toolLabel ? (
          <span
            className="truncate text-[12px] font-medium text-foreground"
            title={props.observation.toolName}
          >
            {toolLabel}
          </span>
        ) : null}
      </div>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
        {formatTime(props.observation.at)}
      </span>
    </div>
  );
}

export function RuntimeRunRow(props: {
  processRun: RuntimeProcessRunView;
  snapshot?: ProcessRunSnapshotView;
}) {
  const status =
    props.snapshot?.result?.status ??
    props.processRun.processStatus ??
    props.snapshot?.state ??
    props.processRun.status;
  const duration =
    props.snapshot?.result?.durationMs !== undefined
      ? formatDuration(props.snapshot.result.durationMs)
      : props.processRun.finishedAt
        ? elapsedBetween(props.processRun.startedAt, props.processRun.finishedAt)
        : status === "queued"
          ? "queued"
          : "running";
  return (
    <div className="rounded-[var(--radius-md)] border bg-background p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] font-medium">
          {actionTypeLabel(props.processRun.actionType)}
        </span>
        <Badge variant={runtimeStatusVariant(status)}>{status}</Badge>
      </div>
      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
        {props.processRun.processRunId}
      </p>
      {props.snapshot ? (
        <div className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
          <p className="truncate font-mono">
            {props.snapshot.spec.command} {compactArgs(props.snapshot.spec.args)}
          </p>
          {props.snapshot.spec.cwd ? (
            <p className="truncate font-mono">cwd {props.snapshot.spec.cwd}</p>
          ) : null}
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {props.snapshot.queuedAt ? (
              <span>queued {formatTime(props.snapshot.queuedAt)}</span>
            ) : null}
            {props.snapshot.startedAt ? (
              <span>started {formatTime(props.snapshot.startedAt)}</span>
            ) : null}
            <span>duration {duration}</span>
            <span>timeout {formatTimeout(props.snapshot.spec.timeoutMs)}</span>
          </div>
          {props.snapshot.error ? <p className="text-err">error {props.snapshot.error}</p> : null}
          {props.snapshot.result?.stderr ? (
            <p className="line-clamp-2 font-mono text-err">
              stderr {props.snapshot.result.stderr.trim()}
            </p>
          ) : null}
          {props.snapshot.result?.stdout ? (
            <p className="line-clamp-2 font-mono">stdout {props.snapshot.result.stdout.trim()}</p>
          ) : null}
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">daemon snapshot unavailable</p>
      )}
    </div>
  );
}
