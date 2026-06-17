import {
  AlertTriangle,
  BrainCircuit,
  BotMessageSquare,
  CircleDot,
  CircleUserRound,
  Gauge,
  Loader2,
  MessageSquareText,
  TerminalSquare,
  Trash2,
  Wrench,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { MarkdownMessage } from "./markdown-message";
import { TurnOutcomeCard } from "./outcome-card";
import { buildClientTurnProgress } from "./turn-progress";
import { taskRequestPreview } from "./task-request";
import type {
  ClientMessage,
  ClientState,
  ClientTurnActivity,
  ClientTurnActivityKind,
  ClientTurnActivityStatus,
  ClientTurnProgress,
  ClientTurnProgressPhaseId,
  ClientTurnProgressStatus,
  ClientWorkLogEntry,
  MessagePart,
  SikongUIAction,
  SikongUIElement,
  SikongUISpec,
  TaskCard,
  Workspace,
} from "./types";

type ConsoleBadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "destructive"
  | "ok"
  | "warn"
  | "err"
  | "info"
  | "neutral"
  | "accent";

export interface MessageRenderContext {
  state: ClientState;
  onAction?: (action: SikongUIAction) => void;
  onSendMessage?: (text: string) => void;
}

function messageBubbleClass(message: ClientMessage): string {
  if (message.pending) {
    return "border-[color-mix(in_srgb,var(--info)_22%,transparent)] bg-[var(--info-soft)]/25";
  }
  if (message.role === "user") {
    return "border-[var(--accent-dim)]/60 bg-[var(--accent-soft)]/20";
  }
  if (message.role === "system") {
    return "border-[color-mix(in_srgb,var(--warn)_25%,transparent)] bg-[var(--warn-soft)]/20";
  }
  return "border-border-soft bg-card/92";
}

export function MessageView(props: {
  message: ClientMessage;
  context: MessageRenderContext;
  onDelete?: (messageId: string) => void;
}) {
  return (
    <article className="group/message grid grid-cols-[28px_minmax(0,1fr)] gap-3 animate-in">
      <MessageAvatar message={props.message} />
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-[13px] font-medium tracking-[-0.01em]">
              {messageLabel(props.message)}
            </p>
            <p className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
              {new Date(props.message.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </div>
          {props.onDelete && !props.message.pending ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-[22px] shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/message:opacity-100 focus-visible:opacity-100"
              aria-label="Delete message"
              title="Delete message"
              onClick={() => props.onDelete?.(props.message.id)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          ) : null}
        </div>
        <div
          className={`flex flex-col gap-2 rounded-[var(--radius-lg)] border px-3 py-2.5 text-[13px] leading-5 ${messageBubbleClass(props.message)}`}
        >
          {props.message.parts.map((part, index) => (
            <MessagePartView
              // Message parts are immutable presentation records; index keeps duplicate text parts renderable.
              key={`${part.type}-${index}`}
              part={part}
              context={props.context}
            />
          ))}
        </div>
      </div>
    </article>
  );
}

function MessageAvatar(props: { message: ClientMessage }) {
  const className = `mt-0.5 flex size-7 items-center justify-center rounded-[var(--radius-lg)] border ${
    props.message.pending
      ? "border-[color-mix(in_srgb,var(--info)_35%,transparent)] bg-[var(--info-soft)] text-info"
      : props.message.role === "user"
        ? "border-[var(--accent-dim)] bg-[var(--accent-soft)] text-primary"
        : props.message.role === "system"
          ? "border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[var(--warn-soft)] text-warn"
          : "border-[color-mix(in_srgb,var(--info)_35%,transparent)] bg-[var(--info-soft)] text-info"
  }`;

  return (
    <div className={className} aria-hidden="true">
      {props.message.pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : props.message.role === "user" ? (
        <CircleUserRound className="size-4" />
      ) : props.message.role === "system" ? (
        <AlertTriangle className="size-4" />
      ) : (
        <BotMessageSquare className="size-4" />
      )}
    </div>
  );
}

function MessagePartView(props: { part: MessagePart; context: MessageRenderContext }) {
  switch (props.part.type) {
    case "text":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <MarkdownMessage text={props.part.text} />
        </div>
      );
    case "outcome-card":
      return (
        <TurnOutcomeCard
          outcome={props.part.outcome}
          onOpenTask={(taskId) => props.context.onAction?.({ type: "focusTask", taskId })}
          onSendMessage={props.context.onSendMessage}
        />
      );
    case "progress-card":
      return <TurnProgressCard progress={props.part.progress} />;
    case "task-card":
      return (
        <TaskCardPart
          task={findTask(props.context.state.taskCards, props.part.taskId)}
          onOpen={(taskId) => props.context.onAction?.({ type: "focusTask", taskId })}
        />
      );
    case "work-log-summary":
      return <WorkLogSummary entries={props.part.entries} />;
    case "ui":
      return <SikongUIRenderer spec={props.part.spec} context={props.context} />;
  }
}

function TurnProgressCard(props: { progress: ClientTurnProgress }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const progress = useMemo(() => {
    const activePhaseId = props.progress.phases.find((phase) => phase.status === "running")?.id;
    return buildClientTurnProgress({
      startedAt: props.progress.startedAt,
      detail: props.progress.detail,
      activities: props.progress.activities,
      ...(activePhaseId ? { activePhaseId: activePhaseId as ClientTurnProgressPhaseId } : {}),
      nowMs,
    });
  }, [
    nowMs,
    props.progress.activities,
    props.progress.detail,
    props.progress.phases,
    props.progress.startedAt,
  ]);
  const activities = progress.activities.slice(-18);
  const currentPhase =
    progress.phases.find((phase) => phase.status === "running") ??
    progress.phases.findLast((phase) => phase.status === "done") ??
    progress.phases[0];
  const latestActivity = activities.at(-1);
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
            <Loader2 className="animate-spin text-info" data-icon="inline-start" />
            Client Agent is working
          </p>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
            {currentPhase?.detail ?? progress.detail}
          </p>
        </div>
        <Badge variant="info">{formatElapsed(progress.elapsedMs)}</Badge>
      </div>

      <div className="rounded-[var(--radius-md)] border border-border-soft bg-background/55 p-2.5">
        <div className="grid gap-1.5 sm:grid-cols-5">
          {progress.phases.map((phase) => (
            <div
              key={phase.id}
              className={`rounded-[var(--radius-sm)] border px-2 py-1.5 ${
                phase.status === "running"
                  ? "border-info/35 bg-[var(--info-soft)]"
                  : "border-border-soft bg-surface/70"
              }`}
            >
              <div className="mb-1 flex items-center justify-between gap-1">
                <span className="truncate text-[11px] font-medium">{phase.title}</span>
                <Badge variant={activityBadgeVariant(phase.status)}>{phase.status}</Badge>
              </div>
              <p className="line-clamp-2 text-[10px] leading-4 text-muted-foreground">
                {phase.substeps.find((step) => step.status === "running")?.label ??
                  phase.substeps.at(-1)?.label}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-2 rounded-[var(--radius-sm)] border border-border-soft bg-background/60 px-2 py-1.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{currentPhase?.title ?? "Working"}</span>
          {latestActivity ? (
            <>
              <span> · Latest: </span>
              <span className="font-mono">{latestActivity.title}</span>
            </>
          ) : null}
        </div>

        <details className="group mt-2">
          <summary className="cursor-pointer list-none rounded-[var(--radius-sm)] px-1 py-1 text-[11px] text-muted-foreground marker:content-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            Agent/tool details · {activities.length} events
          </summary>
          <div className="mt-1.5 rounded-[var(--radius-md)] border border-border-soft bg-background/55">
            {activities.map((activity, index) => (
              <AgentActivityRow
                key={activity.id}
                activity={activity}
                first={index === 0}
                latest={index === activities.length - 1}
              />
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}

function AgentActivityRow(props: {
  activity: ClientTurnActivity;
  first: boolean;
  latest: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-[22px_minmax(0,1fr)] gap-2 px-2.5 py-2 ${
        props.first ? "" : "border-t border-border-soft"
      } ${props.latest && props.activity.status === "running" ? "bg-[var(--info-soft)]" : ""}`}
    >
      <div className="flex justify-center pt-0.5">
        <ActivityIcon kind={props.activity.kind} status={props.activity.status} />
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-[12px] font-medium text-foreground">{props.activity.title}</p>
          <Badge variant={activityBadgeVariant(props.activity.status)}>
            {props.activity.status}
          </Badge>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
            {formatActivityTime(props.activity.at)}
          </span>
          <span className="shrink-0 rounded-[var(--radius-sm)] border border-border-soft px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {props.activity.phase}
          </span>
        </div>
        {props.activity.detail ? (
          <p className="mt-1 max-h-12 overflow-hidden break-words font-mono text-[11px] leading-4 text-muted-foreground">
            {props.activity.detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ActivityIcon(props: { kind: ClientTurnActivityKind; status: ClientTurnActivityStatus }) {
  const className =
    props.status === "error"
      ? "text-err"
      : props.status === "done"
        ? "text-ok"
        : "animate-spin text-info";
  if (props.status === "running") return <Loader2 className={className} />;
  if (props.kind === "thinking") return <BrainCircuit className={className} />;
  if (props.kind === "text") return <MessageSquareText className={className} />;
  if (props.kind === "tool") return <Wrench className={className} />;
  if (props.kind === "usage") return <Gauge className={className} />;
  if (props.kind === "error") return <AlertTriangle className={className} />;
  if (props.kind === "status") return <TerminalSquare className={className} />;
  return <CircleDot className={className} />;
}

function activityBadgeVariant(
  status: ClientTurnActivityStatus | ClientTurnProgressStatus,
): ConsoleBadgeVariant {
  if (status === "done") return "ok";
  if (status === "running") return "info";
  if (status === "error") return "err";
  return "neutral";
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function SikongUIRenderer(props: { spec: SikongUISpec; context: MessageRenderContext }) {
  return (
    <>
      {renderElement({
        id: props.spec.root,
        spec: props.spec,
        context: props.context,
        seen: new Set<string>(),
      }) ?? <UnsupportedElement reason="Missing UI root" />}
    </>
  );
}

function renderElement(input: {
  id: string;
  spec: SikongUISpec;
  context: MessageRenderContext;
  seen: Set<string>;
}): React.ReactNode {
  if (input.seen.has(input.id))
    return <UnsupportedElement reason={`Circular UI node ${input.id}`} />;
  const element = input.spec.elements[input.id];
  if (!element) return <UnsupportedElement reason={`Missing UI node ${input.id}`} />;
  const seen = new Set(input.seen);
  seen.add(input.id);
  const children = (element.children ?? [])
    .map((childId) =>
      renderElement({
        id: childId,
        spec: input.spec,
        context: input.context,
        seen,
      }),
    )
    .filter((child): child is React.ReactNode => child !== null && child !== undefined);
  return renderKnownElement(element, children, input.context);
}

function renderKnownElement(
  element: SikongUIElement,
  children: React.ReactNode[],
  context: MessageRenderContext,
): React.ReactNode {
  const props = recordProps(element.props);
  switch (element.type) {
    case "Text":
      return (
        <p className={textVariantClass(enumProp(props, "variant", ["muted", "body"], "body"))}>
          {stringProp(props, "text")}
        </p>
      );
    case "Heading":
      return <Heading level={numberProp(props, "level", 3)} text={stringProp(props, "text")} />;
    case "Badge":
      return (
        <span>
          <Badge variant={badgeVariant(props)}>{stringProp(props, "text")}</Badge>
        </span>
      );
    case "Alert":
      return <AlertBox title={stringProp(props, "title")} message={stringProp(props, "message")} />;
    case "CodeBlock":
      return (
        <pre className="overflow-auto rounded-[var(--radius-md)] border bg-background p-3 text-xs leading-5">
          {stringProp(props, "code")}
        </pre>
      );
    case "KeyValueList":
      return <KeyValueList items={arrayProp(props, "items")} />;
    case "Timeline":
      return <Timeline items={arrayProp(props, "items")} />;
    case "Stack":
      return (
        <div
          className={`flex ${directionClass(props, "vertical")} ${gapClass(props, "md")} ${densityClass(props)}`}
        >
          {children}
        </div>
      );
    case "Inline":
      return (
        <div className={`flex flex-wrap items-center ${gapClass(props, "sm")}`}>{children}</div>
      );
    case "Section":
      return (
        <SectionBlock
          title={stringProp(props, "title")}
          description={stringProp(props, "description")}
        >
          {children}
        </SectionBlock>
      );
    case "Card":
      return (
        <UICard title={stringProp(props, "title")} description={stringProp(props, "description")}>
          {children}
        </UICard>
      );
    case "Collapsible":
      return <CollapsibleBlock title={stringProp(props, "title")}>{children}</CollapsibleBlock>;
    case "WorkspaceSummary":
      return (
        <WorkspaceSummary
          workspace={findWorkspace(context.state.workspaces, stringProp(props, "workspaceId"))}
        />
      );
    case "TaskSummary":
      return (
        <TaskCardPart
          task={findTask(context.state.taskCards, stringProp(props, "taskId"))}
          onOpen={(taskId) => context.onAction?.({ type: "focusTask", taskId })}
        />
      );
    case "TaskList":
      return <TaskList tasks={filterTasks(context.state.taskCards, props)} />;
    case "PlanStageList":
      return (
        <PlanStageList task={findTask(context.state.taskCards, stringProp(props, "taskId"))} />
      );
    case "ReviewResult":
      return <ReviewResult props={props} />;
    case "RuntimeProcessList":
      return (
        <RuntimeProcessList task={findTask(context.state.taskCards, stringProp(props, "taskId"))} />
      );
    case "WorkLogList":
      return (
        <WorkLogSummary entries={context.state.workLog.slice(0, numberProp(props, "limit", 5))} />
      );
  }
}

function messageLabel(message: ClientMessage): string {
  if (message.role === "user") return "You";
  if (message.role === "system") return "System";
  return "Sikong";
}

function TaskCardPart(props: { task?: TaskCard; onOpen?: (taskId: string) => void }) {
  if (!props.task) return <UnsupportedElement reason="Work item not found" />;
  const content = (
    <>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {props.task.taskId}
          </p>
          <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
            {taskRequestPreview(props.task.request ?? props.task.nextAction.type, 160)}
          </p>
        </div>
        <TaskStatusBadge task={props.task} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{actionTypeLabel(props.task.nextAction.type)}</Badge>
        {props.task.activeRound ? (
          <Badge variant="outline">
            {props.task.activeRound.completedWorkUnits}/{props.task.activeRound.workUnits} work
            units
          </Badge>
        ) : null}
        <Badge variant="outline">
          {props.task.runtimeProcesses.running} running · {props.task.runtimeProcesses.queued}{" "}
          queued
        </Badge>
      </div>
    </>
  );
  if (props.onOpen) {
    return (
      <button
        type="button"
        className="group/task w-full rounded-[var(--radius-lg)] border bg-background p-3 text-left outline-none transition-[background-color,border-color,box-shadow] hover:border-ring/30 hover:bg-hover focus-visible:border-ring"
        onClick={() => props.onOpen?.(props.task!.taskId)}
      >
        {content}
        <p className="mt-2 text-[11px] font-medium text-primary opacity-80 transition-opacity group-hover/task:opacity-100">
          View work detail
        </p>
      </button>
    );
  }
  return <div className="rounded-[var(--radius-lg)] border bg-background p-3">{content}</div>;
}

function TaskList(props: { tasks: TaskCard[] }) {
  if (props.tasks.length === 0)
    return (
      <p className="rounded-[var(--radius-md)] border border-dashed bg-background p-2.5 text-[13px] text-muted-foreground">
        No work-item cards.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      {props.tasks.map((task) => (
        <TaskCardPart key={task.taskId} task={task} />
      ))}
    </div>
  );
}

function WorkLogSummary(props: { entries: ClientWorkLogEntry[] }) {
  if (props.entries.length === 0)
    return (
      <p className="rounded-[var(--radius-md)] border border-dashed bg-background p-2.5 text-[13px] text-muted-foreground">
        No saved notes.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      {props.entries.map((entry) => (
        <div key={entry.id} className="rounded-[var(--radius-lg)] border bg-background p-3">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <Badge variant="outline">{entry.kind}</Badge>
            <span className="text-xs text-muted-foreground">
              {new Date(entry.createdAt).toLocaleString()}
            </span>
          </div>
          <p className="text-[13px] leading-5">{entry.summary}</p>
        </div>
      ))}
    </div>
  );
}

function WorkspaceSummary(props: { workspace?: Workspace }) {
  if (!props.workspace) return <UnsupportedElement reason="Workspace not found" />;
  return (
    <div className="rounded-[var(--radius-lg)] border bg-background p-3">
      <p className="font-medium">{props.workspace.name}</p>
      <p className="font-mono text-xs text-muted-foreground">{props.workspace.id}</p>
    </div>
  );
}

function PlanStageList(props: { task?: TaskCard }) {
  if (!props.task?.currentStage && !props.task?.activeRound)
    return <p className="text-sm text-muted-foreground">No active stage round.</p>;
  return (
    <div className="rounded-[var(--radius-lg)] border bg-background p-3">
      <p className="text-xs text-muted-foreground">Current execution layer</p>
      {props.task.currentStage ? (
        <>
          <p className="mt-1 font-medium">{props.task.currentStage.title}</p>
          <p className="font-mono text-xs text-muted-foreground">{props.task.currentStage.id}</p>
        </>
      ) : null}
      {props.task.activeRound ? (
        <div className="mt-2 space-y-1.5">
          <p className="line-clamp-2 text-[13px] leading-5">{props.task.activeRound.intent}</p>
          <p className="text-xs text-muted-foreground">
            {props.task.activeRound.startedWorkUnits} started ·{" "}
            {props.task.activeRound.runningWorkUnits} running ·{" "}
            {props.task.activeRound.completedWorkUnits} completed /{" "}
            {props.task.activeRound.workUnits}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function RuntimeProcessList(props: { task?: TaskCard }) {
  if (!props.task) return <UnsupportedElement reason="Work item not found" />;
  return (
    <div className="grid grid-cols-3 gap-2 text-xs">
      <div className="rounded-[var(--radius-md)] border bg-background p-2">
        <p className="text-muted-foreground">Total</p>
        <p className="font-medium">{props.task.runtimeProcesses.total}</p>
      </div>
      <div className="rounded-[var(--radius-md)] border bg-background p-2">
        <p className="text-muted-foreground">Queued</p>
        <p className="font-medium">{props.task.runtimeProcesses.queued}</p>
      </div>
      <div className="rounded-[var(--radius-md)] border bg-background p-2">
        <p className="text-muted-foreground">Running</p>
        <p className="font-medium">{props.task.runtimeProcesses.running}</p>
      </div>
    </div>
  );
}

function actionTypeLabel(actionType: string): string {
  switch (actionType) {
    case "start_lead_requirement_spec":
      return "Lead spec";
    case "start_planning_worker":
      return "Planner";
    case "start_lead_plan_decision":
      return "Lead plan decision";
    case "start_lead_round_planning":
      return "Lead round planning";
    case "start_stage_worker":
      return "Worker unit";
    case "start_stage_workers":
      return "Worker units";
    case "await_worker_results":
      return "Waiting for workers";
    case "complete_stage_round":
      return "Complete round";
    case "start_stage_review":
      return "Start stage review";
    case "start_stage_verification_worker":
      return "Stage reviewer";
    case "start_final_verification_worker":
      return "Final reviewer";
    case "start_lead_final_decision":
      return "Lead final decision";
    case "terminal":
      return "Closed";
    default:
      return actionType.replace(/^start_/, "").replaceAll("_", " ");
  }
}

function ReviewResult(props: { props: Record<string, unknown> }) {
  return (
    <div className="rounded-[var(--radius-lg)] border bg-background p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="font-medium">{stringProp(props.props, "title") || "Review result"}</p>
        <Badge variant="secondary">{stringProp(props.props, "outcome") || "pending"}</Badge>
      </div>
      <div className="text-[13px] leading-5 text-muted-foreground">
        <MarkdownMessage text={stringProp(props.props, "report") || "No report."} />
      </div>
    </div>
  );
}

function KeyValueList(props: { items: unknown[] }) {
  return (
    <dl className="grid grid-cols-1 gap-2">
      {props.items.map((item, index) => {
        const record = recordProps(item);
        return (
          <div
            key={index}
            className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 rounded-[var(--radius-md)] border bg-background px-2.5 py-2 text-[13px]"
          >
            <dt className="truncate text-muted-foreground">{stringProp(record, "label")}</dt>
            <dd className="break-words">{stringProp(record, "value")}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function Timeline(props: { items: unknown[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      {props.items.map((item, index) => {
        const record = recordProps(item);
        return (
          <div key={index} className="grid grid-cols-[14px_minmax(0,1fr)] gap-2.5">
            <div className="relative flex justify-center">
              <div className="mt-1.5 size-2 rounded-full bg-info" />
              {index < props.items.length - 1 ? (
                <div className="absolute top-4 bottom-[-12px] w-px bg-border" />
              ) : null}
            </div>
            <div>
              <p className="font-medium">{stringProp(record, "title")}</p>
              {stringProp(record, "time") ? (
                <p className="text-xs text-muted-foreground">{stringProp(record, "time")}</p>
              ) : null}
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
                {stringProp(record, "description")}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AlertBox(props: { title: string; message: string }) {
  return (
    <div className="flex gap-2 rounded-[var(--radius-lg)] border bg-background p-3">
      <AlertTriangle className="mt-0.5 text-muted-foreground" />
      <div>
        <p className="font-medium">{props.title || "Notice"}</p>
        {props.message ? (
          <p className="text-[13px] leading-5 text-muted-foreground">{props.message}</p>
        ) : null}
      </div>
    </div>
  );
}

function SectionBlock(props: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {props.title ? <Heading level={3} text={props.title} /> : null}
      {props.description ? (
        <p className="text-sm text-muted-foreground">{props.description}</p>
      ) : null}
      {props.children}
    </section>
  );
}

function UICard(props: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card>
      {props.title || props.description ? (
        <CardHeader className="pb-3">
          {props.title ? <CardTitle className="text-sm">{props.title}</CardTitle> : null}
          {props.description ? <CardDescription>{props.description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent className={props.title || props.description ? undefined : "pt-3"}>
        {props.children}
      </CardContent>
    </Card>
  );
}

function CollapsibleBlock(props: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-[var(--radius-lg)] border bg-background p-3">
      <summary className="cursor-pointer text-sm font-medium">{props.title || "Details"}</summary>
      <div className="mt-2.5">{props.children}</div>
    </details>
  );
}

function Heading(props: { level: number; text: string }) {
  if (props.level <= 1) return <h1 className="text-lg font-medium">{props.text}</h1>;
  if (props.level === 2) return <h2 className="text-base font-medium">{props.text}</h2>;
  if (props.level === 3) return <h3 className="text-sm font-medium">{props.text}</h3>;
  return <h4 className="text-sm font-semibold">{props.text}</h4>;
}

function UnsupportedElement(props: { reason: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-dashed bg-background p-2.5 text-[13px] text-muted-foreground">
      {props.reason}
    </div>
  );
}

function TaskStatusBadge(props: { task: TaskCard }) {
  return <Badge variant={statusBadgeVariant(props.task)}>{taskPhaseLabel(props.task)}</Badge>;
}

function findTask(tasks: TaskCard[], taskId: string): TaskCard | undefined {
  return tasks.find((task) => task.taskId === taskId);
}

function findWorkspace(workspaces: Workspace[], workspaceId: string): Workspace | undefined {
  return workspaces.find((workspace) => workspace.id === workspaceId);
}

function filterTasks(tasks: TaskCard[], props: Record<string, unknown>): TaskCard[] {
  const taskIds = arrayProp(props, "taskIds").filter(
    (item): item is string => typeof item === "string",
  );
  if (taskIds.length > 0) return tasks.filter((task) => taskIds.includes(task.taskId));
  return tasks.slice(0, numberProp(props, "limit", 5));
}

function recordProps(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringProp(props: Record<string, unknown>, key: string): string {
  const value = props[key];
  return typeof value === "string" ? value : "";
}

function numberProp(props: Record<string, unknown>, key: string, fallback: number): number {
  const value = props[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function arrayProp(props: Record<string, unknown>, key: string): unknown[] {
  const value = props[key];
  return Array.isArray(value) ? value : [];
}

function enumProp<T extends string>(
  props: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = props[key];
  return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

function badgeVariant(props: Record<string, unknown>): ConsoleBadgeVariant {
  return enumProp(
    props,
    "variant",
    [
      "default",
      "secondary",
      "outline",
      "destructive",
      "ok",
      "warn",
      "err",
      "info",
      "neutral",
      "accent",
    ],
    "secondary",
  );
}

function statusBadgeVariant(task: TaskCard): ConsoleBadgeVariant {
  if (task.terminal?.outcome === "accepted") return "ok";
  if (task.terminal?.outcome === "rejected") return "err";
  if (task.terminal) return "neutral";
  if (task.runtimeProcesses.running > 0 || task.runtimeProcesses.queued > 0) return "info";
  if (task.waitingForLead) return "warn";
  if (task.status === "planning" || task.nextAction.type.includes("plan")) return "warn";
  if (task.status === "running") return "info";
  return "neutral";
}

function taskPhaseLabel(task: TaskCard): string {
  if (task.terminal) return task.terminal.outcome;
  if (task.activeRound) return "round active";
  if (task.currentStage) return "stage active";
  if (task.plan?.status) return `plan ${task.plan.status}`;
  return actionTypeLabel(task.nextAction.type);
}

function textVariantClass(variant: "body" | "muted"): string {
  return variant === "muted" ? "break-words text-muted-foreground" : "break-words";
}

function directionClass(
  props: Record<string, unknown>,
  fallback: "vertical" | "horizontal",
): string {
  return enumProp(props, "direction", ["vertical", "horizontal"], fallback) === "horizontal"
    ? "flex-row flex-wrap"
    : "flex-col";
}

function gapClass(props: Record<string, unknown>, fallback: "xs" | "sm" | "md"): string {
  const gap = enumProp(props, "gap", ["xs", "sm", "md"], fallback);
  if (gap === "xs") return "gap-1";
  if (gap === "sm") return "gap-2";
  return "gap-3";
}

function densityClass(props: Record<string, unknown>): string {
  return enumProp(props, "density", ["compact", "normal"], "normal") === "compact" ? "text-sm" : "";
}
