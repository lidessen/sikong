import {
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  Inbox,
  Layers3,
  Loader2,
  PanelRight,
  Settings,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type React from "react";
import type { FormEvent } from "react";
import {
  driveTask,
  getClientState,
  runTurnStream,
  submitPlanDecision,
  updateSettings,
} from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
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
} from "./types";

type InspectorMode = "tasks" | "memory";

export function App() {
  const [state, setState] = useState<ClientState | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>();
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("tasks");
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messages, setMessages] = useState<ClientMessage[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [taskActionBusy, setTaskActionBusy] = useState<string | null>(null);
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

  async function decidePlan(task: TaskCard, decision: "accept" | "reject") {
    const planId = typeof task.nextAction.planId === "string" ? task.nextAction.planId : "";
    const version =
      typeof task.nextAction.version === "number" && Number.isSafeInteger(task.nextAction.version)
        ? task.nextAction.version
        : undefined;
    if (!planId || version === undefined) return;
    setTaskActionBusy(`${decision}:${task.taskId}`);
    setError(null);
    try {
      await submitPlanDecision({
        workspaceId: task.workspaceId,
        taskId: task.taskId,
        planId,
        version,
        decision,
      });
      await refresh(task.workspaceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTaskActionBusy(null);
    }
  }

  async function runTaskNext(task: TaskCard) {
    setTaskActionBusy(`drive:${task.taskId}`);
    setError(null);
    try {
      await driveTask({ workspaceId: task.workspaceId, taskId: task.taskId });
      await refresh(task.workspaceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refresh(task.workspaceId);
    } finally {
      setTaskActionBusy(null);
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
      <div className="grid h-dvh grid-cols-1 lg:min-h-screen lg:grid-cols-[286px_minmax(0,1fr)_340px]">
        <Sidebar
          state={state}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={(workspaceId) => {
            setSelectedTaskId(undefined);
            setSelectedWorkspaceId(workspaceId);
          }}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <section className="sikong-pane flex min-h-0 min-w-0 flex-col border-x border-transparent lg:min-h-screen lg:border-border">
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
                    Transcript is interface state. Context comes from work log and focus.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="lg:hidden"
                  onClick={() => setMobileContextOpen(true)}
                >
                  <PanelRight data-icon="inline-start" />
                  Context
                </Button>
              </div>
              <div className="hidden flex-col gap-2 border-t border-divider pt-2 lg:flex lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="flex size-6 items-center justify-center rounded-[var(--radius-md)] border border-input bg-surface-2 text-primary">
                      <CircleDot />
                    </span>
                    <h2 className="text-[15px] font-semibold">Activity</h2>
                  </div>
                  <p className="max-w-xl text-[12px] leading-5 text-muted-foreground">
                    One continuous operating thread for workspaces, work items, and durable
                    progress.
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

          <div className="flex-1 overflow-auto px-4 py-4 scroll-smooth">
            <ActivityStream messages={messages} state={state} />
          </div>

          <Composer
            busy={busy}
            message={message}
            onMessageChange={setMessage}
            onSubmit={submitTurn}
          />
        </section>

        <div className="hidden lg:block">
          <Inspector
            state={state}
            selectedTask={selectedTask}
            selectedTaskId={selectedTaskId}
            inspectorMode={inspectorMode}
            onSelectTask={(taskId) => {
              setSelectedTaskId(taskId);
              setInspectorMode("tasks");
            }}
            taskActionBusy={taskActionBusy}
            onPlanDecision={decidePlan}
            onRunTaskNext={runTaskNext}
            onModeChange={setInspectorMode}
            showHeader
          />
        </div>
      </div>

      <MobileContextPanel
        open={mobileContextOpen}
        state={state}
        selectedWorkspaceId={selectedWorkspaceId}
        selectedTask={selectedTask}
        selectedTaskId={selectedTaskId}
        inspectorMode={inspectorMode}
        onClose={() => setMobileContextOpen(false)}
        onModeChange={setInspectorMode}
        onSelectWorkspace={(workspaceId) => {
          setSelectedTaskId(undefined);
          setSelectedWorkspaceId(workspaceId);
          setMobileContextOpen(false);
        }}
        onSelectTask={(taskId) => {
          setSelectedTaskId(taskId);
          setInspectorMode("tasks");
          setMobileContextOpen(false);
        }}
        taskActionBusy={taskActionBusy}
        onPlanDecision={decidePlan}
        onRunTaskNext={runTaskNext}
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
  onSelectWorkspace: (workspaceId: string) => void;
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

      <div className="min-h-0 flex-1">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Workspaces
          </p>
          <ChevronDown className="text-muted-foreground" />
        </div>
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
          {props.state.workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={`flex min-w-40 shrink-0 items-center justify-between gap-2 rounded-[var(--radius-md)] border px-2 py-1.5 text-left text-[13px] outline-none transition-[background-color,border-color,color] focus-visible:border-ring lg:min-w-0 lg:shrink ${
                workspace.id === props.selectedWorkspaceId
                  ? "border-border-strong bg-sidebar-accent text-sidebar-accent-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:bg-hover"
              }`}
              onClick={() => props.onSelectWorkspace(workspace.id)}
            >
              <span className="truncate">{workspace.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{workspace.id}</span>
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

function ActivityStream(props: { messages: ClientMessage[]; state: ClientState }) {
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
        <MessageView key={item.id} message={item} context={{ state: props.state }} />
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
          <p className="text-[11px] text-muted-foreground">Work log + focused work-item context</p>
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

function Inspector(props: {
  state: ClientState;
  selectedTask?: TaskCard;
  selectedTaskId?: string;
  inspectorMode: InspectorMode;
  onSelectTask: (taskId: string) => void;
  onModeChange: (mode: InspectorMode) => void;
  taskActionBusy: string | null;
  onPlanDecision: (task: TaskCard, decision: "accept" | "reject") => void;
  onRunTaskNext: (task: TaskCard) => void;
  showHeader?: boolean;
}) {
  return (
    <aside className="border-t border-divider bg-sidebar p-3 lg:min-h-screen lg:border-l lg:border-t-0">
      {props.showHeader ? (
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold">Context</p>
            <p className="truncate text-xs text-muted-foreground">Current workspace signals</p>
          </div>
          <Badge variant="outline">{props.state.taskCards.length}</Badge>
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-1 rounded-[var(--radius-md)] border border-border bg-bg p-1">
        <button
          type="button"
          className={`flex h-5 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] px-1.5 text-[12px] font-medium outline-none transition-[background-color,color] focus-visible:outline-ring ${
            props.inspectorMode === "tasks"
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground hover:bg-hover"
          }`}
          onClick={() => props.onModeChange("tasks")}
        >
          <Layers3 />
          Work
        </button>
        <button
          type="button"
          className={`flex h-5 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] px-1.5 text-[12px] font-medium outline-none transition-[background-color,color] focus-visible:outline-ring ${
            props.inspectorMode === "memory"
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground hover:bg-hover"
          }`}
          onClick={() => props.onModeChange("memory")}
        >
          <Bot />
          Log
        </button>
      </div>

      {props.inspectorMode === "tasks" ? (
        <TaskInspector
          tasks={props.state.taskCards}
          selectedTask={props.selectedTask}
          selectedTaskId={props.selectedTaskId}
          onSelectTask={props.onSelectTask}
          taskActionBusy={props.taskActionBusy}
          onPlanDecision={props.onPlanDecision}
          onRunTaskNext={props.onRunTaskNext}
        />
      ) : (
        <MemoryInspector state={props.state} />
      )}
    </aside>
  );
}

function MobileContextPanel(props: {
  open: boolean;
  state: ClientState;
  selectedWorkspaceId?: string;
  selectedTask?: TaskCard;
  selectedTaskId?: string;
  inspectorMode: InspectorMode;
  onClose: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectTask: (taskId: string) => void;
  onModeChange: (mode: InspectorMode) => void;
  taskActionBusy: string | null;
  onPlanDecision: (task: TaskCard, decision: "accept" | "reject") => void;
  onRunTaskNext: (task: TaskCard) => void;
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
            <p className="text-sm font-semibold">Context</p>
            <p className="truncate text-xs text-muted-foreground">
              Workspaces, work items, and work log.
            </p>
          </div>
          <Button type="button" size="icon" variant="ghost" onClick={props.onClose}>
            <X />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <section className="mb-3">
            <div className="mb-2 flex items-center justify-between px-1">
              <p className="text-xs font-medium text-muted-foreground">Workspaces</p>
              <Badge variant="outline">{props.state.workspaces.length}</Badge>
            </div>
            <div className="flex flex-col gap-1">
              {props.state.workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className={`flex items-center justify-between gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left text-[13px] outline-none transition-[background-color,color] focus-visible:outline-ring ${
                    workspace.id === props.selectedWorkspaceId
                      ? "border border-[var(--accent-dim)] bg-[var(--accent-soft)] text-foreground"
                      : "text-muted-foreground hover:bg-hover"
                  }`}
                  onClick={() => props.onSelectWorkspace(workspace.id)}
                >
                  <span className="truncate">{workspace.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {workspace.id}
                  </span>
                </button>
              ))}
              {props.state.workspaces.length === 0 ? (
                <EmptyPanel
                  icon={<SquareTerminal />}
                  title="No workspaces"
                  description="No workspace definitions are available yet."
                  compact
                />
              ) : null}
            </div>
          </section>

          <Inspector
            state={props.state}
            selectedTask={props.selectedTask}
            selectedTaskId={props.selectedTaskId}
            inspectorMode={props.inspectorMode}
            onSelectTask={props.onSelectTask}
            taskActionBusy={props.taskActionBusy}
            onPlanDecision={props.onPlanDecision}
            onRunTaskNext={props.onRunTaskNext}
            onModeChange={props.onModeChange}
          />
        </div>
      </aside>
    </div>
  );
}

function TaskInspector(props: {
  tasks: TaskCard[];
  selectedTask?: TaskCard;
  selectedTaskId?: string;
  onSelectTask: (taskId: string) => void;
  taskActionBusy: string | null;
  onPlanDecision: (task: TaskCard, decision: "accept" | "reject") => void;
  onRunTaskNext: (task: TaskCard) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-muted-foreground">Work Items</p>
        <Badge variant="outline">{props.tasks.length}</Badge>
      </div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:flex lg:flex-col">
        {props.tasks.map((task) => (
          <TaskCardButton
            key={task.taskId}
            task={task}
            selected={task.taskId === props.selectedTaskId}
            onSelect={() => props.onSelectTask(task.taskId)}
          />
        ))}
        {props.tasks.length === 0 ? (
          <EmptyPanel
            icon={<Inbox />}
            title="No work items"
            description="There are no durable work items in this workspace."
          />
        ) : null}
      </div>

      {props.selectedTask ? (
        <TaskDetail
          task={props.selectedTask}
          actionBusy={props.taskActionBusy}
          onPlanDecision={props.onPlanDecision}
          onRunTaskNext={props.onRunTaskNext}
        />
      ) : null}
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

function TaskDetail(props: {
  task: TaskCard;
  actionBusy: string | null;
  onPlanDecision: (task: TaskCard, decision: "accept" | "reject") => void;
  onRunTaskNext: (task: TaskCard) => void;
}) {
  const canDecidePlan = props.task.nextAction.type === "await_plan_decision";
  const canRunNext =
    !props.task.terminal &&
    typeof props.task.nextAction.type === "string" &&
    (props.task.nextAction.type.startsWith("start_") ||
      (props.task.nextAction.type === "await_worker_results" &&
        props.task.runtimeProcesses.running === 0));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-sm">{props.task.taskId}</CardTitle>
        <CardDescription>{props.task.request ?? props.task.nextAction.type}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <Metric
            icon={<Clock3 />}
            label="Worker runs"
            value={`${props.task.runtimeProcesses.running} running`}
          />
          <Metric
            icon={<CheckCircle2 />}
            label="Lead wait"
            value={props.task.waitingForLead ? "yes" : "no"}
          />
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          {canDecidePlan ? (
            <>
              <Button
                type="button"
                size="sm"
                disabled={props.actionBusy !== null}
                onClick={() => props.onPlanDecision(props.task, "accept")}
              >
                {props.actionBusy === `accept:${props.task.taskId}` ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <CheckCircle2 data-icon="inline-start" />
                )}
                Accept plan
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={props.actionBusy !== null}
                onClick={() => props.onPlanDecision(props.task, "reject")}
              >
                Reject
              </Button>
            </>
          ) : null}
          {canRunNext ? (
            <Button
              type="button"
              size="sm"
              variant={canDecidePlan ? "outline" : "default"}
              disabled={props.actionBusy !== null}
              onClick={() => props.onRunTaskNext(props.task)}
            >
              {props.actionBusy === `drive:${props.task.taskId}` ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <ArrowUp data-icon="inline-start" />
              )}
              Run next
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function MemoryInspector(props: { state: ClientState }) {
  return (
    <Card className="rounded-lg">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Client Work Log</CardTitle>
        <CardDescription>Durable memory for future turns.</CardDescription>
      </CardHeader>
      <CardContent className="flex max-h-[520px] flex-col gap-2 overflow-auto">
        {props.state.workLog.map((entry) => (
          <div key={entry.id} className="rounded-lg border bg-background p-3 text-sm">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <Badge variant="outline">{entry.kind}</Badge>
              <span className="text-xs text-muted-foreground">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="leading-relaxed">{entry.summary}</p>
          </div>
        ))}
        {props.state.workLog.length === 0 ? (
          <EmptyPanel
            icon={<Bot />}
            title="No work log"
            description="Future client-agent summaries appear here."
          />
        ) : null}
      </CardContent>
    </Card>
  );
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

const agentDefaultLabels: Array<{ key: DefaultAgentRuntimeKey; title: string }> = [
  { key: "clientAgent", title: "Client Agent" },
  { key: "lead", title: "Lead" },
  { key: "worker", title: "Worker" },
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
        className="relative max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-[420px] overflow-auto rounded-[var(--radius-xl)] border border-border bg-background p-2.5 shadow-[var(--shadow-sheet)]"
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-3 top-3 size-7"
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
    <form className="flex flex-col gap-2.5" onSubmit={submit}>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle id={props.titleId} className="text-sm">
            Settings
          </CardTitle>
          <CardDescription>Default runtime backend, provider, and model selection.</CardDescription>
        </CardHeader>
      </Card>

      <div className="flex flex-col gap-2">
        {agentDefaultLabels.map((item) => (
          <AgentDefaultFields
            key={item.key}
            title={item.title}
            value={draft.defaults[item.key]}
            onChange={(next) => updateDefault(item.key, next)}
          />
        ))}
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {savedAt ? `Saved ${savedAt}` : "Stored in config.yaml"}
        </p>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
          Save
        </Button>
      </div>
    </form>
  );
}

function AgentDefaultFields(props: {
  title: string;
  value: DefaultAgentRuntime;
  onChange: (value: DefaultAgentRuntime) => void;
}) {
  return (
    <div className="rounded-[var(--radius-md)] border bg-card p-2.5">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <p className="text-sm font-medium tracking-[-0.01em]">{props.title}</p>
        <Badge variant="outline">
          {props.value.provider
            ? `${props.value.backend}/${props.value.provider}`
            : props.value.backend}
        </Badge>
      </div>
      <div className="grid gap-2">
        <label className="grid gap-1 text-xs text-muted-foreground">
          Backend
          <select
            className="h-7 rounded-[var(--radius-md)] border border-input bg-bg-elev px-2 text-[13px] text-foreground outline-none transition-colors focus-visible:border-ring"
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
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Provider
          <select
            className="h-7 rounded-[var(--radius-md)] border border-input bg-bg-elev px-2 text-[13px] text-foreground outline-none transition-colors focus-visible:border-ring"
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
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Model
          <Input
            value={props.value.model ?? ""}
            placeholder="default"
            onChange={(event) =>
              props.onChange({ ...props.value, model: event.currentTarget.value })
            }
          />
        </label>
      </div>
    </div>
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

function TaskStatusBadge(props: { task: TaskCard }) {
  if (props.task.terminal) {
    return <Badge variant={statusBadgeVariant(props.task)}>{props.task.terminal.outcome}</Badge>;
  }
  if (props.task.waitingForLead) return <Badge variant="warn">lead wait</Badge>;
  if (props.task.runtimeProcesses.running > 0) return <Badge variant="info">running</Badge>;
  return <Badge variant={statusBadgeVariant(props.task)}>{props.task.status}</Badge>;
}
