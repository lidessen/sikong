import { Badge } from "./components/ui/badge";
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
  WorkerRunObservation,
  WorkerRunView,
} from "./types";

type ObservationGroup = TaskDetailView["observations"][number];

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
            <span className="font-mono text-[11px] text-muted-foreground">{props.round.id}</span>
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

export function WorkerRunRow(props: { worker: WorkerRunView; rounds: TaskStageRoundView[] }) {
  const round = props.rounds.find((item) => item.id === props.worker.roundId);
  const workUnit = round?.workUnits.find((item) => item.id === props.worker.workUnitId);
  return (
    <div className="grid grid-cols-[130px_120px_minmax(0,1fr)_140px] gap-2 py-2 text-[12px]">
      <div className="min-w-0">
        <Badge variant={workerStatusVariant(props.worker.status)}>{props.worker.status}</Badge>
        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
          {props.worker.runId}
        </p>
      </div>
      <div className="min-w-0">
        <p className="truncate text-muted-foreground">{round?.title ?? props.worker.roundId}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {props.worker.workUnitId}
        </p>
      </div>
      <div className="min-w-0">
        <p className="truncate font-medium">
          {workUnit?.title ?? props.worker.objective ?? "Worker"}
        </p>
        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
          {props.worker.result?.summary ?? props.worker.objective ?? "No result yet."}
        </p>
      </div>
      <div className="min-w-0 text-right text-[11px] text-muted-foreground">
        <p>{props.worker.startedAt ? formatTime(props.worker.startedAt) : "not started"}</p>
        <p>{props.worker.finishedAt ? formatTime(props.worker.finishedAt) : "running"}</p>
      </div>
    </div>
  );
}

export function ObservationRow(props: { observation: WorkerRunObservation & { runId: string } }) {
  return (
    <div className="rounded-[var(--radius-md)] border bg-background p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge variant={observationVariant(props.observation)}>
            {observationLabel(props.observation)}
          </Badge>
          {props.observation.toolName ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {props.observation.toolName}
            </span>
          ) : null}
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          {formatTime(props.observation.at)}
        </span>
      </div>
      <p className="text-[12px] leading-5 text-muted-foreground">{props.observation.summary}</p>
      {props.observation.argsSummary ? (
        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
          args {props.observation.argsSummary}
        </p>
      ) : null}
      {props.observation.resultSummary ? (
        <p className="mt-1 line-clamp-2 font-mono text-[11px] leading-4 text-muted-foreground">
          result {props.observation.resultSummary}
        </p>
      ) : null}
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
        {recent.map((observation) => (
          <div
            key={observation.id}
            className="rounded-[var(--radius-sm)] border border-border-soft bg-surface px-2 py-1.5"
          >
            <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Badge variant={observationVariant(observation)}>
                  {observationLabel(observation)}
                </Badge>
                {observation.toolName ? (
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {observation.toolName}
                  </span>
                ) : null}
              </div>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {formatTime(observation.at)}
              </span>
            </div>
            <p className="text-[12px] leading-5 text-foreground/90">{observation.summary}</p>
            {observation.argsSummary ? (
              <p className="mt-1 line-clamp-2 font-mono text-[11px] leading-4 text-muted-foreground">
                args {observation.argsSummary}
              </p>
            ) : null}
            {observation.resultSummary ? (
              <p className="mt-1 line-clamp-2 font-mono text-[11px] leading-4 text-muted-foreground">
                result {observation.resultSummary}
              </p>
            ) : null}
          </div>
        ))}
      </div>
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
