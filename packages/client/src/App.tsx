import {
  ArrowUp,
  ArrowLeft,
  Bot,
  ChevronDown,
  CircleDot,
  Clock3,
  Cpu,
  FileText,
  Folder,
  GitBranch,
  Hammer,
  Inbox,
  Layers3,
  Loader2,
  MessageSquare,
  PlayCircle,
  ShieldCheck,
  Settings,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type React from "react";
import type { FormEvent } from "react";
import { getClientState, getTaskDetail, runTurnStream, updateSettings } from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { CardDescription, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { MessageView } from "./message-renderer";
import { createPendingMessage, createTextMessage, messageFromTurnResponse } from "./messages";
import { buildClientTurnProgress } from "./turn-progress";
import type {
  ClientMessage,
  ClientState,
  ClientTurnProgressPhaseId,
  DefaultAgentRuntime,
  DefaultAgentRuntimeKey,
  SikongSettings,
  TaskCard,
  TaskDetailView,
  TaskStageRoundView,
  WorkerRunObservation,
  WorkerRunView,
  Workspace,
} from "./types";

type MainView = "chat" | "task";

export function App() {
  const [state, setState] = useState<ClientState | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>();
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [mainView, setMainView] = useState<MainView>("chat");
  const [mobileWorkOpen, setMobileWorkOpen] = useState(false);
  const [taskDetail, setTaskDetail] = useState<TaskDetailView | null>(null);
  const [taskDetailLoading, setTaskDetailLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messages, setMessages] = useState<ClientMessage[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingTurn, setPendingTurn] = useState<{
    messageId: string;
    startedAt: string;
    phaseId?: ClientTurnProgressPhaseId;
    detail?: string;
  } | null>(null);

  useEffect(() => {
    void refresh(selectedWorkspaceId);
  }, [selectedWorkspaceId]);

  const selectedWorkspace = useMemo(
    () => state?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId),
    [selectedWorkspaceId, state?.workspaces],
  );
  const selectedTask = useMemo(
    () => state?.taskCards.find((task) => task.taskId === selectedTaskId),
    [selectedTaskId, state?.taskCards],
  );
  const terminalCount = useMemo(
    () => state?.taskCards.filter((task) => task.terminal).length ?? 0,
    [state?.taskCards],
  );
  const activeTaskCount = (state?.taskCards.length ?? 0) - terminalCount;

  useEffect(() => {
    if (mainView !== "task" || !selectedTaskId) {
      setTaskDetail(null);
      setTaskDetailLoading(false);
      return;
    }
    let cancelled = false;
    setTaskDetailLoading(true);
    getTaskDetail({ workspaceId: selectedWorkspaceId, taskId: selectedTaskId })
      .then((detail) => {
        if (!cancelled) setTaskDetail(detail);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setTaskDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mainView, selectedTask?.updatedAt, selectedTaskId, selectedWorkspaceId]);

  useEffect(() => {
    if (!pendingTurn) return;
    const currentPendingTurn = pendingTurn;

    function updateProgress() {
      setMessages((items) =>
        items.map((item) =>
          item.id === currentPendingTurn.messageId
            ? {
                ...item,
                pending: true,
                parts: [
                  {
                    type: "progress-card",
                    progress: buildClientTurnProgress({
                      startedAt: currentPendingTurn.startedAt,
                      workspaceName: selectedWorkspace?.name,
                      taskId: selectedTaskId,
                      activePhaseId: currentPendingTurn.phaseId,
                      detail: currentPendingTurn.detail,
                    }),
                  },
                ],
              }
            : item,
        ),
      );
    }

    updateProgress();
    const interval = window.setInterval(updateProgress, 1000);
    return () => window.clearInterval(interval);
  }, [pendingTurn, selectedTaskId, selectedWorkspace?.name]);

  async function refresh(workspaceId?: string) {
    try {
      const next = await getClientState(workspaceId);
      setState(next);
      setSelectedWorkspaceId(next.selectedWorkspaceId);
      setMessages(next.transcript ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitTurn(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || busy) return;
    setMessage("");
    setBusy(true);
    setError(null);
    const userMessage = createTextMessage("user", text);
    const pendingStartedAt = new Date().toISOString();
    const pendingMessage = createPendingMessage(
      buildClientTurnProgress({
        startedAt: pendingStartedAt,
        workspaceName: selectedWorkspace?.name,
        taskId: selectedTaskId,
        activePhaseId: "prepare",
      }),
    );
    setPendingTurn({
      messageId: pendingMessage.id,
      startedAt: pendingStartedAt,
      phaseId: "prepare",
    });
    setMessages((items) => [...items, userMessage, pendingMessage]);
    try {
      const response = await runTurnStream(
        {
          message: text,
          workspaceId: selectedWorkspaceId,
          taskId: selectedTaskId,
        },
        (event) => {
          if (event.type === "turn.started") {
            setPendingTurn({
              messageId: pendingMessage.id,
              startedAt: event.startedAt,
              phaseId: event.phaseId,
              detail: event.detail,
            });
          }
          if (event.type === "turn.progress") {
            setPendingTurn((current) =>
              current?.messageId === pendingMessage.id
                ? {
                    ...current,
                    phaseId: event.phaseId,
                    detail: event.detail,
                  }
                : current,
            );
          }
        },
      );
      const assistantMessage = messageFromTurnResponse(response);
      setMessages((items) =>
        items.map((item) => (item.id === pendingMessage.id ? assistantMessage : item)),
      );
      await refresh(response.context.focus.workspaceId ?? selectedWorkspaceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessages((items) =>
        items.map((item) =>
          item.id === pendingMessage.id
            ? createTextMessage("system", err instanceof Error ? err.message : String(err))
            : item,
        ),
      );
    } finally {
      setPendingTurn(null);
      setBusy(false);
    }
  }

  async function saveSettings(settings: SikongSettings) {
    try {
      setError(null);
      const saved = await updateSettings(settings);
      setState((current) => (current ? { ...current, settings: saved } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  if (!state) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="animate-spin" data-icon="inline-start" />
          Loading Sikong
        </div>
      </main>
    );
  }

  return (
    <main className="sikong-shell min-h-screen text-foreground">
      <div className="grid h-dvh grid-cols-1 lg:min-h-screen lg:grid-cols-[286px_minmax(0,1fr)]">
        <Sidebar
          state={state}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedTaskId={selectedTaskId}
          onSelectWorkspace={(workspaceId) => {
            setSelectedTaskId(undefined);
            setMainView("chat");
            setSelectedWorkspaceId(workspaceId);
          }}
          onSelectTask={(taskId) => {
            setSelectedTaskId(taskId);
            setMainView("task");
          }}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <section className="sikong-pane flex min-h-0 min-w-0 flex-col border-x border-transparent lg:min-h-screen lg:border-l lg:border-border">
          <header className="shrink-0 border-b border-divider bg-bg/95 px-4 py-2 backdrop-blur lg:sticky lg:top-0 lg:z-10">
            <div className="mx-auto flex max-w-[840px] flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="flex size-7 items-center justify-center rounded-[var(--radius-md)] border border-input bg-surface text-foreground lg:hidden">
                      <SquareTerminal />
                    </div>
                    <p className="truncate text-[15px] font-semibold">
                      {selectedWorkspace?.name ?? "No workspace selected"}
                    </p>
                    <Badge variant="outline">{activeTaskCount} active</Badge>
                  </div>
                  <p className="hidden truncate text-[12px] leading-5 text-muted-foreground lg:block">
                    {mainView === "task" && selectedTask
                      ? (selectedTask.request ?? selectedTask.nextAction.type)
                      : "Transcript is interface state. Context comes from source stores and focus."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {mainView === "task" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setMainView("chat")}
                    >
                      <ArrowLeft data-icon="inline-start" />
                      Chat
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="lg:hidden"
                    onClick={() => setMobileWorkOpen(true)}
                  >
                    <Layers3 data-icon="inline-start" />
                    Work
                  </Button>
                </div>
              </div>
              <div className="hidden flex-col gap-2 border-t border-divider pt-2 lg:flex lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="flex size-6 items-center justify-center rounded-[var(--radius-md)] border border-input bg-surface-2 text-primary">
                      <CircleDot />
                    </span>
                    <h2 className="text-[15px] font-semibold">
                      {mainView === "task" ? "Work Detail" : "Activity"}
                    </h2>
                  </div>
                  <p className="max-w-xl text-[12px] leading-5 text-muted-foreground">
                    {mainView === "task"
                      ? "Plan, stage, round, worker, and execution observations for the selected work item."
                      : "One continuous operating thread for workspaces, work items, and durable progress."}
                  </p>
                </div>
                <div className="flex gap-2 text-xs">
                  <Badge variant="secondary">{state.workspaces.length} workspaces</Badge>
                  <Badge variant="secondary">{terminalCount} finished</Badge>
                </div>
              </div>
            </div>
            {error ? (
              <div className="mx-auto mt-2 max-w-[840px]">
                <Badge variant="destructive">{error}</Badge>
              </div>
            ) : null}
          </header>

          {mainView === "task" && selectedTask ? (
            <div className="flex-1 overflow-auto px-3 py-3 scroll-smooth sm:px-4 sm:py-4">
              <TaskDetailMain
                task={selectedTask}
                detail={taskDetail}
                loading={taskDetailLoading}
                onClose={() => setMainView("chat")}
              />
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-auto px-4 py-4 scroll-smooth">
                <ActivityStream
                  messages={messages}
                  state={state}
                  onOpenTask={(taskId) => {
                    setSelectedTaskId(taskId);
                    setMainView("task");
                  }}
                />
              </div>

              <Composer
                busy={busy}
                message={message}
                onMessageChange={setMessage}
                onSubmit={submitTurn}
              />
            </>
          )}
        </section>
      </div>

      <MobileWorkPanel
        open={mobileWorkOpen}
        state={state}
        selectedWorkspaceId={selectedWorkspaceId}
        selectedTaskId={selectedTaskId}
        onClose={() => setMobileWorkOpen(false)}
        onSelectWorkspace={(workspaceId) => {
          setSelectedTaskId(undefined);
          setMainView("chat");
          setSelectedWorkspaceId(workspaceId);
        }}
        onSelectTask={(taskId) => {
          setSelectedTaskId(taskId);
          setMainView("task");
          setMobileWorkOpen(false);
        }}
        onOpenSettings={() => {
          setSettingsOpen(true);
          setMobileWorkOpen(false);
        }}
      />

      <SettingsDialog
        open={settingsOpen}
        settings={state.settings}
        onClose={() => setSettingsOpen(false)}
        onSaveSettings={saveSettings}
      />
    </main>
  );
}

function Sidebar(props: {
  state: ClientState;
  selectedWorkspaceId?: string;
  selectedTaskId?: string;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectTask: (taskId: string) => void;
  onOpenSettings: () => void;
}) {
  return (
    <aside className="hidden border-b border-divider bg-sidebar px-3 py-3 lg:flex lg:min-h-screen lg:flex-col lg:border-b-0 lg:border-r">
      <div className="mb-4 flex shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-[var(--radius-md)] border border-[var(--accent-dim)] bg-[var(--accent-soft)] text-primary">
            <SquareTerminal />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold">Sikong</h1>
            <p className="truncate text-xs text-muted-foreground">Client Agent</p>
          </div>
        </div>
        <Badge variant="outline">{props.state.workspaces.length}</Badge>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <WorkspaceWorkList
          state={props.state}
          selectedWorkspaceId={props.selectedWorkspaceId}
          selectedTaskId={props.selectedTaskId}
          onSelectWorkspace={props.onSelectWorkspace}
          onSelectTask={props.onSelectTask}
        />
      </div>

      <div className="shrink-0 border-t pt-3">
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start px-2"
          onClick={props.onOpenSettings}
        >
          <Settings data-icon="inline-start" />
          Settings
        </Button>
      </div>
    </aside>
  );
}

function WorkspaceWorkList(props: {
  state: ClientState;
  selectedWorkspaceId?: string;
  selectedTaskId?: string;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectTask: (taskId: string) => void;
}) {
  const running = props.state.taskCards.filter((task) => !task.terminal);
  const finished = props.state.taskCards.filter((task) => task.terminal);
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Workspaces
          </p>
          <ChevronDown className="text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-1">
          {props.state.workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={`grid min-w-0 grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 rounded-[var(--radius-md)] border px-2 py-1.5 text-left text-[13px] outline-none transition-[background-color,border-color,color] focus-visible:border-ring ${
                workspace.id === props.selectedWorkspaceId
                  ? "border-border-strong bg-sidebar-accent text-sidebar-accent-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:bg-hover"
              }`}
              onClick={() => props.onSelectWorkspace(workspace.id)}
            >
              <span
                className={`flex size-6 items-center justify-center rounded-[var(--radius-md)] border ${
                  workspace.id === props.selectedWorkspaceId
                    ? "border-[var(--accent-dim)] bg-[var(--accent-soft)] text-primary"
                    : "border-border bg-background text-muted-foreground"
                }`}
              >
                <WorkspaceSourceIcon sourceKind={workspace.sourceKind} />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium leading-5">{workspace.name}</span>
                <span className="block truncate font-mono text-[11px] leading-4 text-muted-foreground">
                  {workspace.id}
                </span>
              </span>
              <span className="flex min-w-7 justify-end">
                {workspace.taskCount ? (
                  <Badge variant={workspace.activeTaskCount ? "info" : "outline"}>
                    {workspace.activeTaskCount || workspace.taskCount}
                  </Badge>
                ) : (
                  <span className="h-5" />
                )}
              </span>
            </button>
          ))}
          {props.state.workspaces.length === 0 ? (
            <EmptyPanel
              className="rounded-md bg-card/45 px-3 py-3"
              icon={<SquareTerminal />}
              title="No workspaces"
              description="No workspace definitions are available yet."
              compact
            />
          ) : null}
        </div>
      </section>

      <section className="min-h-0">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Work Items
          </p>
          <Badge variant="outline">{props.state.taskCards.length}</Badge>
        </div>
        <div className="flex flex-col gap-1.5">
          {running.map((task) => (
            <TaskCardButton
              key={task.taskId}
              task={task}
              selected={task.taskId === props.selectedTaskId}
              onSelect={() => props.onSelectTask(task.taskId)}
            />
          ))}
          {finished.length > 0 ? (
            <div className="mt-2 border-t border-divider pt-2">
              <div className="mb-1.5 flex items-center justify-between px-1">
                <span className="text-[11px] text-muted-foreground">Finished</span>
                <Badge variant="secondary">{finished.length}</Badge>
              </div>
              <div className="flex flex-col gap-1.5">
                {finished.map((task) => (
                  <TaskCardButton
                    key={task.taskId}
                    task={task}
                    selected={task.taskId === props.selectedTaskId}
                    onSelect={() => props.onSelectTask(task.taskId)}
                  />
                ))}
              </div>
            </div>
          ) : null}
          {props.state.taskCards.length === 0 ? (
            <EmptyPanel
              icon={<Inbox />}
              title="No work items"
              description="There are no durable work items in this workspace."
              compact
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function WorkspaceSourceIcon(props: { sourceKind?: Workspace["sourceKind"] }) {
  if (props.sourceKind === "git") return <GitBranch />;
  if (props.sourceKind === "directory") return <Folder />;
  return <SquareTerminal />;
}

function ActivityStream(props: {
  messages: ClientMessage[];
  state: ClientState;
  onOpenTask: (taskId: string) => void;
}) {
  if (props.messages.length === 0) {
    return (
      <div className="mx-auto flex max-w-[840px] justify-center pt-[12dvh]">
        <EmptyPanel
          className="w-full max-w-md p-5 text-center"
          icon={<Bot />}
          title="No activity yet"
          description="Transcript stays separate from agent memory."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[840px] flex-col gap-4">
      {props.messages.map((item) => (
        <MessageView
          key={item.id}
          message={item}
          context={{
            state: props.state,
            onAction: (action) => {
              if (action.type === "focusTask") props.onOpenTask(action.taskId);
            },
          }}
        />
      ))}
    </div>
  );
}

function Composer(props: {
  busy: boolean;
  message: string;
  onMessageChange: (message: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form
      className="sticky bottom-0 border-t border-divider bg-bg/95 px-4 py-3 backdrop-blur lg:static"
      onSubmit={props.onSubmit}
    >
      <div className="mx-auto max-w-[840px] rounded-[var(--radius-lg)] border border-input bg-surface p-1.5 transition-[border-color] focus-within:border-ring">
        <Textarea
          className="min-h-14 border-0 bg-transparent px-2.5 py-2 text-[13px] shadow-none focus-visible:outline-none"
          placeholder="Message Sikong..."
          value={props.message}
          onChange={(event) => props.onMessageChange(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2 border-t border-divider px-1.5 pt-2">
          <p className="text-[11px] text-muted-foreground">
            Bootstrap context + source-store lookup
          </p>
          <Button
            type="submit"
            size="icon"
            className="rounded-[var(--radius-md)] disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100"
            disabled={props.busy || !props.message.trim()}
          >
            {props.busy ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : (
              <ArrowUp data-icon="inline-start" />
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}

function MobileWorkPanel(props: {
  open: boolean;
  state: ClientState;
  selectedWorkspaceId?: string;
  selectedTaskId?: string;
  onClose: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectTask: (taskId: string) => void;
  onOpenSettings: () => void;
}) {
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-20 bg-black/55 lg:hidden" onClick={props.onClose}>
      <aside
        className="absolute inset-x-0 bottom-0 flex max-h-[80dvh] flex-col rounded-t-[var(--radius-xl)] border border-border bg-background shadow-[var(--shadow-sheet)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Work</p>
            <p className="truncate text-xs text-muted-foreground">
              Workspaces and durable work items.
            </p>
          </div>
          <Button type="button" size="icon" variant="ghost" onClick={props.onClose}>
            <X />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <WorkspaceWorkList
            state={props.state}
            selectedWorkspaceId={props.selectedWorkspaceId}
            selectedTaskId={props.selectedTaskId}
            onSelectWorkspace={props.onSelectWorkspace}
            onSelectTask={props.onSelectTask}
          />
          <div className="mt-4 border-t border-divider pt-3">
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start px-2"
              onClick={props.onOpenSettings}
            >
              <Settings data-icon="inline-start" />
              Settings
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function TaskCardButton(props: { task: TaskCard; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`rounded-[var(--radius-lg)] border bg-card p-2.5 text-left text-[13px] outline-none transition-[background-color,border-color,transform] active:translate-y-px focus-visible:border-ring ${
        props.selected
          ? "border-[var(--accent-dim)] bg-[var(--accent-soft)]"
          : "hover:border-ring/25 hover:bg-hover"
      }`}
      onClick={props.onSelect}
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {props.task.taskId}
        </span>
        <TaskStatusBadge task={props.task} />
      </div>
      <p className="line-clamp-2 text-[13px] leading-5 text-muted-foreground">
        {props.task.request ?? props.task.nextAction.type}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant={nextActionBadgeVariant(props.task)}>{nextActionLabel(props.task)}</Badge>
        {props.task.activeRound ? (
          <Badge variant="outline">
            {props.task.activeRound.completedWorkUnits}/{props.task.activeRound.workUnits} work
            units
          </Badge>
        ) : null}
        {props.task.currentStage ? (
          <Badge variant="outline">{props.task.currentStage.title}</Badge>
        ) : null}
      </div>
    </button>
  );
}

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

function TaskDetailMain(props: {
  task: TaskCard;
  detail: TaskDetailView | null;
  loading: boolean;
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
  const observations = props.detail?.observations.flatMap((group) =>
    group.observations.map((observation) => ({ ...observation, runId: group.runId })),
  );
  const round = props.task.activeRound;
  const roundPercent = round
    ? Math.round((round.completedWorkUnits / Math.max(round.workUnits, 1)) * 100)
    : 0;
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

        <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Metric icon={<Bot />} label="Owner" value={currentOperatorLabel(props.task)} />
          <Metric
            icon={<Clock3 />}
            label="Runtime"
            value={`${props.task.runtimeProcesses.running}/${props.task.runtimeProcesses.total}`}
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
          <DetailSection title="Observations" icon={<Wrench />} count={observations?.length ?? 0}>
            {observations && observations.length > 0 ? (
              <div className="flex max-h-[520px] flex-col gap-1.5 overflow-auto pr-1">
                {observations.map((observation) => (
                  <ObservationRow
                    key={`${observation.runId}-${observation.id}`}
                    observation={observation}
                  />
                ))}
              </div>
            ) : (
              <EmptyInline text="No persisted thinking or tool-call observations yet." />
            )}
          </DetailSection>

          <DetailSection title="Runtime" icon={<PlayCircle />} count={runtimeRuns.length}>
            {runtimeRuns.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {runtimeRuns.map((processRun) => (
                  <div
                    key={processRun.processRunId}
                    className="rounded-[var(--radius-md)] border bg-background p-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12px] font-medium">
                        {actionTypeLabel(processRun.actionType)}
                      </span>
                      <Badge variant={processRun.status === "running" ? "info" : "outline"}>
                        {processRun.processStatus ?? processRun.status}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {processRun.processRunId}
                    </p>
                  </div>
                ))}
              </div>
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

function DetailSection(props: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius-lg)] border bg-card/92 p-3">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] border bg-background text-primary">
            {props.icon}
          </span>
          <h3 className="truncate text-[13px] font-semibold">{props.title}</h3>
        </div>
        {props.count !== undefined ? <Badge variant="outline">{props.count}</Badge> : null}
      </div>
      {props.children}
    </section>
  );
}

function RoundDetail(props: { round: TaskStageRoundView; workers: WorkerRunView[] }) {
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

function WorkerRunRow(props: { worker: WorkerRunView; rounds: TaskStageRoundView[] }) {
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

function ObservationRow(props: { observation: WorkerRunObservation & { runId: string } }) {
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

function EmptyInline(props: { text: string }) {
  return (
    <p className="rounded-[var(--radius-md)] border border-dashed bg-background p-2.5 text-[12px] text-muted-foreground">
      {props.text}
    </p>
  );
}

function stageBadgeVariant(detail: TaskDetailView | null, stageId: string): ConsoleBadgeVariant {
  if (!detail) return "outline";
  if (detail.projection.currentStageId === stageId) return "info";
  if (detail.projection.acceptedStageIds.includes(stageId)) return "ok";
  return "outline";
}

function taskStageSummary(task: TaskCard, detail: TaskDetailView | null): string {
  if (task.currentStage) return `${task.currentStage.title} · ${task.currentStage.id}`;
  const stages = detail?.projection.plan?.stages.length ?? task.plan?.stageCount ?? 0;
  const accepted = detail?.projection.acceptedStageIds.length ?? 0;
  if (stages > 0 && accepted >= stages) return "all stages accepted";
  if (task.terminal) return `closed · ${task.terminal.outcome}`;
  return "not started";
}

function stageLabel(detail: TaskDetailView | null, stageId: string, index: number): string {
  if (!detail) return `Stage ${index + 1}`;
  if (detail.projection.currentStageId === stageId) return "current";
  if (detail.projection.acceptedStageIds.includes(stageId)) return "done";
  return `stage ${index + 1}`;
}

function workerStatusVariant(status: WorkerRunView["status"]): ConsoleBadgeVariant {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "budget_exceeded") return "err";
  return "info";
}

function observationVariant(observation: WorkerRunObservation): ConsoleBadgeVariant {
  if (observation.kind === "tool_call") {
    if (observation.status === "failed") return "err";
    if (observation.status === "completed") return "ok";
    return "info";
  }
  if (observation.kind === "thinking") return "accent";
  if (observation.kind === "error") return "err";
  if (observation.kind === "usage") return "neutral";
  return "outline";
}

function observationLabel(observation: WorkerRunObservation): string {
  if (observation.kind === "tool_call") return observation.status ?? "tool";
  if (observation.kind === "round_start") return "round start";
  if (observation.kind === "round_end") return "round end";
  return observation.kind.replaceAll("_", " ");
}

function EmptyPanel(props: {
  title: string;
  description: string;
  icon?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[var(--radius-lg)] border border-dashed bg-card/55 ${props.compact ? "p-3" : "p-4"} ${props.className ?? ""}`}
    >
      {props.icon ? (
        <div
          className={`mb-3 flex ${props.className?.includes("text-center") ? "mx-auto" : ""} size-8 items-center justify-center rounded-[var(--radius-lg)] border bg-background text-primary`}
        >
          {props.icon}
        </div>
      ) : null}
      <p className="text-sm font-semibold tracking-[-0.01em]">{props.title}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.description}</p>
    </div>
  );
}

const agentDefaultLabels: Array<{
  key: DefaultAgentRuntimeKey;
  title: string;
  description: string;
}> = [
  {
    key: "clientAgent",
    title: "Client Agent",
    description: "Interprets chat, reads workspace state, and reports back.",
  },
  {
    key: "lead",
    title: "Lead",
    description: "Turns requirements into specs, accepts plans, and closes decisions.",
  },
  {
    key: "worker",
    title: "Worker",
    description: "Runs implementation and verification work items.",
  },
];

const backendOptions = ["codex", "claude-code", "cursor", "ai-sdk"];
const providerOptions = ["", "deepseek", "anthropic", "openai"];

function SettingsDialog(props: {
  open: boolean;
  settings: SikongSettings;
  onClose: () => void;
  onSaveSettings: (settings: SikongSettings) => Promise<void>;
}) {
  if (!props.open) return null;
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[1px]"
      onClick={props.onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        className="relative flex max-h-[min(760px,calc(100dvh-2rem))] w-full max-w-[640px] flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-background shadow-[var(--shadow-sheet)]"
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-3 top-3 z-10 size-7"
          onClick={props.onClose}
        >
          <X />
        </Button>
        <SettingsForm
          settings={props.settings}
          titleId="settings-dialog-title"
          onSave={props.onSaveSettings}
        />
      </div>
    </div>
  );
}

function SettingsForm(props: {
  settings: SikongSettings;
  titleId?: string;
  onSave: (settings: SikongSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState<SikongSettings>(props.settings);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.settings);

  useEffect(() => {
    setDraft(props.settings);
  }, [props.settings]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSavedAt(null);
    try {
      await props.onSave(draft);
      setSavedAt(new Date().toLocaleTimeString());
    } finally {
      setSaving(false);
    }
  }

  function updateDefault(key: DefaultAgentRuntimeKey, next: DefaultAgentRuntime) {
    setDraft((current) => ({
      version: 1,
      defaults: {
        ...current.defaults,
        [key]: normalizeDraftDefault(next),
      },
    }));
  }

  return (
    <form className="flex min-h-0 flex-col" onSubmit={submit}>
      <div className="shrink-0 border-b border-divider px-4 py-3 pr-12">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-[var(--radius-md)] border border-[var(--accent-dim)] bg-[var(--accent-soft)] text-primary">
            <Settings />
          </span>
          <div className="min-w-0">
            <CardTitle id={props.titleId} className="text-[15px]">
              Settings
            </CardTitle>
            <CardDescription>
              Runtime defaults for chat coordination, lead decisions, and worker execution.
            </CardDescription>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-9">
          <Badge variant="outline">config.yaml</Badge>
          <Badge variant={dirty ? "warn" : "neutral"}>{dirty ? "unsaved" : "current"}</Badge>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <div className="flex flex-col gap-2">
          {agentDefaultLabels.map((item) => (
            <AgentDefaultFields
              key={item.key}
              role={item}
              value={draft.defaults[item.key]}
              onChange={(next) => updateDefault(item.key, next)}
            />
          ))}
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-divider bg-bg/95 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {savedAt
            ? `Saved ${savedAt}`
            : dirty
              ? "Changes are local until saved."
              : "Stored in config.yaml"}
        </p>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(props.settings)}>
            Reset
          </Button>
          <Button type="submit" size="sm" disabled={saving || !dirty}>
            {saving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}

function AgentDefaultFields(props: {
  role: (typeof agentDefaultLabels)[number];
  value: DefaultAgentRuntime;
  onChange: (value: DefaultAgentRuntime) => void;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-card p-3">
      <div className="grid gap-3 lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] border bg-background text-primary">
            <AgentRoleIcon role={props.role.key} />
          </span>
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <p className="truncate text-[13px] font-semibold">{props.role.title}</p>
              <Badge variant="outline">
                {props.value.provider
                  ? `${props.value.backend}/${props.value.provider}`
                  : props.value.backend}
              </Badge>
            </div>
            <p className="text-[12px] leading-5 text-muted-foreground">{props.role.description}</p>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(160px,1.2fr)]">
          <RuntimeField label="Backend">
            <select
              className={settingsSelectClassName}
              value={props.value.backend}
              onChange={(event) =>
                props.onChange({ ...props.value, backend: event.currentTarget.value })
              }
            >
              {backendOptions.map((backend) => (
                <option key={backend} value={backend}>
                  {backend}
                </option>
              ))}
            </select>
          </RuntimeField>
          <RuntimeField label="Provider">
            <select
              className={settingsSelectClassName}
              value={props.value.provider ?? ""}
              onChange={(event) =>
                props.onChange({ ...props.value, provider: event.currentTarget.value })
              }
            >
              {providerOptions.map((provider) => (
                <option key={provider || "native"} value={provider}>
                  {provider || "native"}
                </option>
              ))}
            </select>
          </RuntimeField>
          <RuntimeField label="Model">
            <Input
              value={props.value.model ?? ""}
              placeholder="default"
              onChange={(event) =>
                props.onChange({ ...props.value, model: event.currentTarget.value })
              }
            />
          </RuntimeField>
        </div>
      </div>
    </div>
  );
}

const settingsSelectClassName =
  "h-7 w-full rounded-[var(--radius-md)] border border-input bg-bg-elev px-2 text-[13px] text-foreground outline-none transition-[background-color,border-color,color] focus-visible:border-ring";

function RuntimeField(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {props.label}
      {props.children}
    </label>
  );
}

function AgentRoleIcon(props: { role: DefaultAgentRuntimeKey }) {
  if (props.role === "clientAgent") return <Bot />;
  if (props.role === "lead") return <ShieldCheck />;
  return <Cpu />;
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

function nextActionBadgeVariant(task: TaskCard): ConsoleBadgeVariant {
  if (task.nextAction.type.includes("worker")) return "info";
  if (task.nextAction.type.includes("review")) return "accent";
  if (task.nextAction.type.includes("lead")) return "warn";
  if (task.nextAction.type === "terminal") return statusBadgeVariant(task);
  return "outline";
}

function taskPhaseLabel(task: TaskCard): string {
  if (task.terminal) return task.terminal.outcome;
  if (task.activeRound) return "round active";
  if (task.currentStage) return "stage active";
  if (task.plan?.status) return `plan ${task.plan.status}`;
  return task.status;
}

function currentOperatorLabel(task: TaskCard): string {
  const actionType = task.nextAction.type;
  if (actionType.includes("lead")) return "Lead";
  if (actionType.includes("planning")) return "Planner";
  if (actionType.includes("worker")) return "Worker";
  if (actionType.includes("review")) return "Reviewer";
  if (task.terminal) return "Closed";
  return "Engine";
}

function nextActionLabel(task: TaskCard): string {
  return actionTypeLabel(task.nextAction.type);
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

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function normalizeDraftDefault(value: DefaultAgentRuntime): DefaultAgentRuntime {
  const backend = value.backend.trim() || "codex";
  const provider = value.provider?.trim();
  const model = value.model?.trim();
  return {
    backend,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

function Metric(props: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border bg-background p-2">
      <dt className="mb-1 flex items-center gap-1 text-muted-foreground">
        {props.icon}
        {props.label}
      </dt>
      <dd className="font-medium">{props.value}</dd>
    </div>
  );
}

function FactRow(props: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-2 text-xs">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="truncate text-foreground">{props.value}</span>
    </div>
  );
}

function TaskStatusBadge(props: { task: TaskCard }) {
  return <Badge variant={statusBadgeVariant(props.task)}>{taskPhaseLabel(props.task)}</Badge>;
}
