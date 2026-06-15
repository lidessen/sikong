import { AlertTriangle, Bot, CheckCircle2, CircleDot, Loader2, Sparkles } from "lucide-react";
import type React from "react";
import { Badge } from "./components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { MarkdownMessage } from "./markdown-message";
import type {
  ClientMessage,
  ClientState,
  ClientTurnProgress,
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
}

export function MessageView(props: { message: ClientMessage; context: MessageRenderContext }) {
  const isUser = props.message.role === "user";
  return (
    <article className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
      <div
        className={`mt-0.5 flex size-7 items-center justify-center rounded-[var(--radius-lg)] border ${
          isUser
            ? "border-[var(--accent-dim)] bg-[var(--accent-soft)] text-primary"
            : "bg-card text-primary"
        }`}
      >
        {props.message.pending ? (
          <Loader2 className="animate-spin" />
        ) : isUser ? (
          <Sparkles />
        ) : (
          <Bot />
        )}
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center gap-2">
          <p className="text-[13px] font-medium tracking-[-0.01em]">
            {messageLabel(props.message)}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {new Date(props.message.createdAt).toLocaleTimeString()}
          </p>
        </div>
        <div className="flex flex-col gap-2 rounded-[var(--radius-lg)] border bg-card/92 px-3 py-2.5 text-[13px] leading-5">
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

function MessagePartView(props: { part: MessagePart; context: MessageRenderContext }) {
  switch (props.part.type) {
    case "text":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <MarkdownMessage text={props.part.text} />
        </div>
      );
    case "progress-card":
      return <TurnProgressCard progress={props.part.progress} />;
    case "task-card":
      return <TaskCardPart task={findTask(props.context.state.taskCards, props.part.taskId)} />;
    case "work-log-summary":
      return <WorkLogSummary entries={props.part.entries} />;
    case "ui":
      return <SikongUIRenderer spec={props.part.spec} context={props.context} />;
  }
}

function TurnProgressCard(props: { progress: ClientTurnProgress }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-background p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[13px] font-medium">
            <Loader2 className="animate-spin text-info" data-icon="inline-start" />
            {props.progress.title}
          </p>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
            {props.progress.detail}
          </p>
        </div>
        <Badge variant="info">{formatElapsed(props.progress.elapsedMs)}</Badge>
      </div>

      <div className="flex flex-col gap-2">
        {props.progress.phases.map((phase) => (
          <div
            key={phase.id}
            className={`rounded-[var(--radius-md)] border p-2.5 ${
              phase.status === "running"
                ? "border-[var(--info)] bg-[var(--info-soft)]"
                : "border-border bg-card/80"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 gap-2">
                <ProgressStatusIcon status={phase.status} />
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{phase.title}</p>
                  <p className="text-[12px] leading-5 text-muted-foreground">{phase.detail}</p>
                </div>
              </div>
              <Badge variant={progressBadgeVariant(phase.status)}>{phase.status}</Badge>
            </div>

            <div className="mt-2 grid gap-1 pl-6">
              {phase.substeps.map((substep) => (
                <div
                  key={substep.label}
                  className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground"
                >
                  <ProgressStatusIcon status={substep.status} compact />
                  <span className="truncate">{substep.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProgressStatusIcon(props: { status: ClientTurnProgressStatus; compact?: boolean }) {
  const className = `${props.compact ? "opacity-80" : "mt-0.5"} ${
    props.status === "done"
      ? "text-ok"
      : props.status === "running"
        ? "text-info"
        : "text-muted-foreground"
  }`;
  if (props.status === "done") return <CheckCircle2 className={className} />;
  if (props.status === "running") return <Loader2 className={`${className} animate-spin`} />;
  return <CircleDot className={className} />;
}

function progressBadgeVariant(status: ClientTurnProgressStatus): ConsoleBadgeVariant {
  if (status === "done") return "ok";
  if (status === "running") return "info";
  return "neutral";
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
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
      return <TaskCardPart task={findTask(context.state.taskCards, stringProp(props, "taskId"))} />;
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

function TaskCardPart(props: { task?: TaskCard }) {
  if (!props.task) return <UnsupportedElement reason="Work item not found" />;
  return (
    <div className="rounded-[var(--radius-lg)] border bg-background p-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {props.task.taskId}
          </p>
          <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
            {props.task.request ?? props.task.nextAction.type}
          </p>
        </div>
        <TaskStatusBadge task={props.task} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{props.task.nextAction.type}</Badge>
        <Badge variant="outline">{props.task.runtimeProcesses.running} worker runs</Badge>
      </div>
    </div>
  );
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
        No work-log entries.
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
  if (!props.task?.currentStage)
    return <p className="text-sm text-muted-foreground">No current stage.</p>;
  return (
    <div className="rounded-[var(--radius-lg)] border bg-background p-3">
      <p className="text-xs text-muted-foreground">Current stage</p>
      <p className="mt-1 font-medium">{props.task.currentStage.title}</p>
      <p className="font-mono text-xs text-muted-foreground">{props.task.currentStage.id}</p>
    </div>
  );
}

function RuntimeProcessList(props: { task?: TaskCard }) {
  if (!props.task) return <UnsupportedElement reason="Work item not found" />;
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <div className="rounded-[var(--radius-md)] border bg-background p-2">
        <p className="text-muted-foreground">Total</p>
        <p className="font-medium">{props.task.runtimeProcesses.total}</p>
      </div>
      <div className="rounded-[var(--radius-md)] border bg-background p-2">
        <p className="text-muted-foreground">Running</p>
        <p className="font-medium">{props.task.runtimeProcesses.running}</p>
      </div>
    </div>
  );
}

function ReviewResult(props: { props: Record<string, unknown> }) {
  return (
    <div className="rounded-[var(--radius-lg)] border bg-background p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="font-medium">{stringProp(props.props, "title") || "Review result"}</p>
        <Badge variant="secondary">{stringProp(props.props, "outcome") || "pending"}</Badge>
      </div>
      <p className="text-[13px] leading-5 text-muted-foreground">
        {stringProp(props.props, "report") || "No report."}
      </p>
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
  if (props.task.terminal) {
    return <Badge variant={statusBadgeVariant(props.task)}>{props.task.terminal.outcome}</Badge>;
  }
  if (props.task.waitingForLead) return <Badge variant="warn">lead wait</Badge>;
  if (props.task.runtimeProcesses.running > 0) return <Badge variant="info">running</Badge>;
  return <Badge variant={statusBadgeVariant(props.task)}>{props.task.status}</Badge>;
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
  if (task.runtimeProcesses.running > 0) return "info";
  if (task.waitingForLead) return "warn";
  if (task.status === "planning" || task.nextAction.type.includes("plan")) return "warn";
  if (task.status === "running") return "info";
  return "neutral";
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
