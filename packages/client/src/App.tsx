import { ArrowLeft, CircleDot, Layers3, Loader2, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  deleteTranscriptMessage,
  getClientState,
  getSettings,
  getTaskDetail,
  resumeTurnStream,
  runTurnStream,
  updateSettings,
} from "./api";
import { readAppUrlState, writeAppUrlState, type AppMainView } from "./app-url";
import { ActivityStream, Composer } from "./chat-panel";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { createPendingMessage, createTextMessage, messageFromTurnResponse } from "./messages";
import { SettingsDialog } from "./settings-dialog";
import { classifyTurnError, SystemDiagnosticsBar } from "./system-diagnostics";
import { TaskDetailMain } from "./task-detail";
import { taskRequestPreview } from "./task-request";
import { buildClientTurnProgress } from "./turn-progress";
import {
  clearActiveTurnState,
  readActiveTurnState,
  writeActiveTurnState,
  type ActiveTurnState,
} from "./turn-resume";
import { MobileWorkPanel, Sidebar } from "./workspace-nav";
import type {
  ClientMessage,
  ClientState,
  ClientTurnActivity,
  ClientTurnProgressPhaseId,
  SchedulerStatus,
  SikongSettings,
  TaskDetailView,
  TurnResponse,
  TurnStreamEvent,
} from "./types";

type MainView = AppMainView;

export function App() {
  const initialUrl = useMemo(() => readAppUrlState(), []);
  const [state, setState] = useState<ClientState | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>(
    initialUrl.workspaceId,
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(initialUrl.taskId);
  const [mainView, setMainView] = useState<MainView>(initialUrl.view);
  const [mobileWorkOpen, setMobileWorkOpen] = useState(false);
  const [taskDetail, setTaskDetail] = useState<TaskDetailView | null>(null);
  const [taskDetailLoading, setTaskDetailLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messages, setMessages] = useState<ClientMessage[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnAbortController, setTurnAbortController] = useState<AbortController | null>(null);
  const [pendingTurn, setPendingTurn] = useState<{
    messageId: string;
    startedAt: string;
    phaseId?: ClientTurnProgressPhaseId;
    detail?: string;
    activities: ClientTurnActivity[];
  } | null>(null);

  useEffect(() => {
    void refresh(selectedWorkspaceId);
    const activeTurn = readActiveTurnState();
    if (activeTurn) {
      void resumeInterruptedTurn(activeTurn);
    }
  }, []);

  useEffect(() => {
    if (!mobileWorkOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileWorkOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileWorkOpen]);

  useEffect(() => {
    writeAppUrlState({
      workspaceId: selectedWorkspaceId,
      taskId: selectedTaskId,
      view: mainView,
    });
  }, [mainView, selectedTaskId, selectedWorkspaceId]);

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
    const intervalMs = activeTaskCount > 0 ? 2000 : 10000;
    const interval = window.setInterval(() => {
      if (busy || pendingTurn) return;
      void refresh(selectedWorkspaceId);
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [activeTaskCount, busy, pendingTurn, selectedWorkspaceId]);

  useEffect(() => {
    if (!settingsOpen) return;
    void loadSettingsOptions();
  }, [settingsOpen]);

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

  function updatePendingMessageProgress(input: {
    messageId: string;
    startedAt: string;
    phaseId?: ClientTurnProgressPhaseId;
    detail?: string;
    activities: ClientTurnActivity[];
  }) {
    setMessages((items) =>
      items.map((item) =>
        item.id === input.messageId
          ? {
              ...item,
              pending: true,
              parts: [
                {
                  type: "progress-card",
                  progress: buildClientTurnProgress({
                    startedAt: input.startedAt,
                    workspaceName: selectedWorkspace?.name,
                    taskId: selectedTaskId,
                    activePhaseId: input.phaseId,
                    detail: input.detail,
                    activities: input.activities,
                  }),
                },
              ],
            }
          : item,
      ),
    );
  }

  async function loadSettingsOptions() {
    try {
      const settings = await getSettings();
      setState((current) =>
        current
          ? {
              ...current,
              settings,
              settingsOptions: settings.options ?? current.settingsOptions,
            }
          : current,
      );
    } catch (err) {
      setError(classifyTurnError(err instanceof Error ? err.message : String(err)));
    }
  }

  async function refresh(workspaceId?: string) {
    try {
      const next = await getClientState(workspaceId ?? selectedWorkspaceId);
      setState(next);
      const url = readAppUrlState();
      const workspace = url.workspaceId ?? next.selectedWorkspaceId;
      setSelectedWorkspaceId(workspace);
      if (
        url.taskId &&
        next.taskCards.some((task) => task.taskId === url.taskId && task.workspaceId === workspace)
      ) {
        setSelectedTaskId(url.taskId);
        setMainView(url.view);
      } else if (url.taskId) {
        setSelectedTaskId(undefined);
        setMainView("chat");
      }
      setMessages(next.transcript ?? []);
    } catch (err) {
      setError(classifyTurnError(err instanceof Error ? err.message : String(err)));
    }
  }

  function navigateToChat() {
    setMainView("chat");
    setSelectedTaskId(undefined);
  }

  function navigateToTask(taskId: string) {
    setSelectedTaskId(taskId);
    setMainView("task");
  }

  function navigateToWorkspace(workspaceId: string) {
    setSelectedTaskId(undefined);
    setMainView("chat");
    setSelectedWorkspaceId(workspaceId);
    void refresh(workspaceId);
  }

  function queueComposerMessage(text: string) {
    navigateToChat();
    setMessage(text);
  }

  function cancelTurn() {
    clearActiveTurnState();
    turnAbortController?.abort();
  }

  async function resumeInterruptedTurn(active: ActiveTurnState) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const abortController = new AbortController();
    setTurnAbortController(abortController);
    const turnState = {
      messageId: active.messageId,
      startedAt: active.startedAt,
      phaseId: "prepare" as ClientTurnProgressPhaseId | undefined,
      detail: "Reconnecting to in-flight turn…",
      activities: [] as ClientTurnActivity[],
    };
    setPendingTurn({ ...turnState, activities: [] });
    setMessages((items) => {
      if (items.some((item) => item.id === active.messageId)) return items;
      return [
        ...items,
        {
          ...createPendingMessage(
            buildClientTurnProgress({
              startedAt: active.startedAt,
              workspaceName: selectedWorkspace?.name,
              taskId: selectedTaskId,
              activePhaseId: "prepare",
              detail: turnState.detail,
            }),
          ),
          id: active.messageId,
        },
      ];
    });
    let cancelledByEvent = false;
    try {
      const response = await resumeTurnStream(
        active.turnId,
        active.lastEventIndex,
        (event, eventIndex) => {
          processTurnStreamEvent({
            event,
            eventIndex,
            turnState,
            pendingMessageId: active.messageId,
            onCancelled: () => {
              cancelledByEvent = true;
            },
          });
        },
        abortController.signal,
      );
      await finalizeTurnResponse(response, active.messageId, cancelledByEvent);
    } catch (err) {
      if (err instanceof Error && err.message.includes("no longer active")) {
        clearActiveTurnState();
        return;
      }
      handleTurnFailure(err, active.messageId, cancelledByEvent);
    } finally {
      clearActiveTurnState();
      setTurnAbortController(null);
      setPendingTurn(null);
      setBusy(false);
    }
  }

  function processTurnStreamEvent(input: {
    event: TurnStreamEvent;
    eventIndex: number;
    turnState: {
      messageId: string;
      startedAt: string;
      phaseId?: ClientTurnProgressPhaseId;
      detail?: string;
      activities: ClientTurnActivity[];
    };
    pendingMessageId: string;
    onCancelled: () => void;
  }) {
    const { event, eventIndex, turnState, pendingMessageId, onCancelled } = input;
    if ("turnId" in event) {
      writeActiveTurnState({
        turnId: event.turnId,
        messageId: turnState.messageId,
        startedAt: turnState.startedAt,
        lastEventIndex: eventIndex,
      });
    }
    if (event.type === "turn.started") {
      turnState.startedAt = event.startedAt;
      turnState.phaseId = event.phaseId;
      turnState.detail = event.detail;
      turnState.activities = [];
      setPendingTurn({ ...turnState });
      updatePendingMessageProgress({ ...turnState });
    }
    if (event.type === "turn.progress") {
      turnState.phaseId = event.phaseId;
      turnState.detail = event.detail;
      setPendingTurn({ ...turnState });
      updatePendingMessageProgress({ ...turnState });
    }
    if (event.type === "turn.activity") {
      turnState.activities = mergeTurnActivity(turnState.activities, event.activity);
      setPendingTurn({ ...turnState });
      updatePendingMessageProgress({ ...turnState });
    }
    if (event.type === "turn.cancelled") {
      onCancelled();
      setPendingTurn(null);
      setMessages((items) =>
        items.map((item) =>
          item.id === pendingMessageId
            ? createTextMessage(
                "system",
                `Turn was ${event.reason === "timeout" ? "timed out" : "cancelled"}.`,
              )
            : item,
        ),
      );
    }
  }

  async function finalizeTurnResponse(
    response: TurnResponse,
    pendingMessageId: string,
    cancelledByEvent: boolean,
  ) {
    if (response.status !== "cancelled") {
      const assistantMessage = messageFromTurnResponse(response);
      setMessages((items) =>
        items.map((item) => (item.id === pendingMessageId ? assistantMessage : item)),
      );
      if (response.schedulerWake && !response.schedulerWake.ok) {
        setError(
          classifyTurnError(
            response.schedulerWake.error ??
              "Turn completed but the background scheduler could not be woken.",
          ),
        );
      }
    }
    await refresh(response.context.focus.workspaceId ?? selectedWorkspaceId);
    if (cancelledByEvent) return;
  }

  function handleTurnFailure(err: unknown, pendingMessageId: string, cancelledByEvent: boolean) {
    if (err instanceof DOMException && err.name === "AbortError") {
      if (!cancelledByEvent) {
        setMessages((items) =>
          items.map((item) =>
            item.id === pendingMessageId
              ? createTextMessage("system", "Turn was cancelled.")
              : item,
          ),
        );
      }
      return;
    }
    setError(classifyTurnError(err instanceof Error ? err.message : String(err)));
    setMessages((items) =>
      items.map((item) =>
        item.id === pendingMessageId
          ? createTextMessage(
              "system",
              classifyTurnError(err instanceof Error ? err.message : String(err)),
            )
          : item,
      ),
    );
  }

  async function submitTurn(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || busy) return;
    setMessage("");
    setBusy(true);
    setError(null);
    const abortController = new AbortController();
    setTurnAbortController(abortController);
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
      activities: [],
    });
    setMessages((items) => [...items, userMessage, pendingMessage]);
    const turnState = {
      messageId: pendingMessage.id,
      startedAt: pendingStartedAt,
      phaseId: "prepare" as ClientTurnProgressPhaseId | undefined,
      detail: undefined as string | undefined,
      activities: [] as ClientTurnActivity[],
    };
    let cancelledByEvent = false;
    try {
      const response = await runTurnStream(
        {
          message: text,
          workspaceId: selectedWorkspaceId,
          taskId: selectedTaskId,
        },
        (event, eventIndex) => {
          processTurnStreamEvent({
            event,
            eventIndex,
            turnState,
            pendingMessageId: pendingMessage.id,
            onCancelled: () => {
              cancelledByEvent = true;
            },
          });
        },
        abortController.signal,
      );
      await finalizeTurnResponse(response, pendingMessage.id, cancelledByEvent);
    } catch (err) {
      handleTurnFailure(err, pendingMessage.id, cancelledByEvent);
    } finally {
      clearActiveTurnState();
      setTurnAbortController(null);
      setPendingTurn(null);
      setBusy(false);
    }
  }

  function mergeTurnActivity(
    current: ClientTurnActivity[],
    next: ClientTurnActivity,
  ): ClientTurnActivity[] {
    const index = current.findIndex((item) => item.id === next.id);
    const merged =
      index >= 0
        ? current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item))
        : [...current, next];
    return merged.slice(-18);
  }

  async function deleteMessage(messageId: string) {
    const target = messages.find((item) => item.id === messageId);
    if (!target || target.pending) return;
    if (!window.confirm("Delete this message from history?")) return;

    const previous = messages;
    setError(null);
    setMessages((items) => items.filter((item) => item.id !== messageId));
    try {
      const next = await deleteTranscriptMessage(messageId);
      setMessages(next);
    } catch (err) {
      setMessages(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveSettings(settings: SikongSettings) {
    try {
      setError(null);
      const saved = await updateSettings(settings);
      setState((current) =>
        current ? { ...current, settings: saved, settingsOptions: saved.options } : current,
      );
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
          onSelectWorkspace={navigateToWorkspace}
          onSelectTask={navigateToTask}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <section className="sikong-pane flex min-h-0 min-w-0 flex-col border-x border-transparent lg:min-h-screen lg:border-l lg:border-border">
          <header className="shrink-0 border-b border-divider bg-bg/95 backdrop-blur lg:sticky lg:top-0 lg:z-10">
            <div className="mx-auto flex max-w-[840px] flex-col gap-2 px-4 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="flex size-7 items-center justify-center rounded-[var(--radius-md)] border border-input bg-surface text-foreground lg:hidden">
                      <SquareTerminal />
                    </div>
                    <p className="truncate text-[15px] font-semibold">
                      {mainView === "task" && selectedTask
                        ? taskRequestPreview(
                            selectedTask.request ?? selectedTask.nextAction.type,
                            48,
                          )
                        : (selectedWorkspace?.name ?? "No workspace selected")}
                    </p>
                    {mainView !== "task" ? (
                      <Badge variant="outline">{activeTaskCount} active</Badge>
                    ) : selectedTask ? (
                      <Badge variant={selectedTask.terminal ? "secondary" : "info"}>
                        {selectedTask.terminal ? "Finished" : "In progress"}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-[12px] leading-5 text-muted-foreground">
                    {mainView === "task" && selectedTask
                      ? selectedTask.taskId
                      : "Chat with the Client Agent to manage workspaces and work items."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {mainView === "task" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => navigateToChat()}
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

              <div className="hidden items-center justify-between gap-3 border-t border-divider pt-2 lg:flex">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-[var(--radius-md)] border border-input bg-surface-2 text-primary">
                    <CircleDot />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-[13px] font-semibold">
                      {mainView === "task" ? "Work Detail" : "Activity"}
                    </h2>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {mainView === "task"
                        ? "Plan, stages, workers, and execution observations."
                        : "Your conversation thread with the Client Agent."}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  {state.scheduler ? <SchedulerBadge scheduler={state.scheduler} /> : null}
                  <Badge variant="secondary">{state.workspaces.length} workspaces</Badge>
                  {terminalCount > 0 ? (
                    <Badge variant="secondary">{terminalCount} finished</Badge>
                  ) : null}
                </div>
              </div>
            </div>

            {error ? (
              <div className="mx-auto flex max-w-[840px] items-start gap-2 px-4 pb-2">
                <Badge
                  variant="destructive"
                  className="h-auto min-h-[18px] max-w-full py-1 whitespace-normal"
                >
                  {error}
                </Badge>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-6 shrink-0 text-muted-foreground"
                  aria-label="Dismiss error"
                  onClick={() => setError(null)}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ) : null}
            <SystemDiagnosticsBar diagnostics={state.diagnostics} scheduler={state.scheduler} />
          </header>

          {mainView === "task" && selectedTask ? (
            <div className="flex-1 overflow-auto px-3 py-3 scroll-smooth sm:px-4 sm:py-4">
              <TaskDetailMain
                task={selectedTask}
                detail={taskDetail}
                loading={taskDetailLoading}
                scheduler={state?.scheduler}
                onClose={navigateToChat}
                onSendMessage={queueComposerMessage}
              />
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-auto px-4 py-4 scroll-smooth" data-activity-scroll>
                <ActivityStream
                  messages={messages}
                  state={state}
                  onDeleteMessage={(messageId) => {
                    void deleteMessage(messageId);
                  }}
                  onOpenTask={navigateToTask}
                  onSendMessage={queueComposerMessage}
                />
              </div>

              <Composer
                busy={busy}
                message={message}
                onMessageChange={setMessage}
                onSubmit={submitTurn}
                onCancel={cancelTurn}
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
        onSelectWorkspace={navigateToWorkspace}
        onSelectTask={(taskId) => {
          navigateToTask(taskId);
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
        options={state.settingsOptions ?? state.settings.options}
        onClose={() => setSettingsOpen(false)}
        onSaveSettings={saveSettings}
      />
    </main>
  );
}

function SchedulerBadge(props: { scheduler: SchedulerStatus }) {
  if (!props.scheduler.enabled) {
    return <Badge variant="destructive">Scheduler unavailable</Badge>;
  }
  if (props.scheduler.lastError) {
    return <Badge variant="destructive">Scheduler error</Badge>;
  }
  if (props.scheduler.paused) {
    return <Badge variant="outline">Scheduler paused</Badge>;
  }
  if ((props.scheduler.active ?? 0) > 0) {
    return <Badge variant="secondary">{props.scheduler.active} running</Badge>;
  }
  if ((props.scheduler.runnableSeen ?? 0) > 0) {
    return <Badge variant="outline">{props.scheduler.runnableSeen} queued</Badge>;
  }
  return <Badge variant="outline">Scheduler watching</Badge>;
}
