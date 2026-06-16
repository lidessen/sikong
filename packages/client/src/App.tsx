import { ArrowLeft, CircleDot, Layers3, Loader2, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { getClientState, getTaskDetail, runTurnStream, updateSettings } from "./api";
import { ActivityStream, Composer } from "./chat-panel";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { createPendingMessage, createTextMessage, messageFromTurnResponse } from "./messages";
import { SettingsDialog } from "./settings-dialog";
import { TaskDetailMain } from "./task-detail";
import { buildClientTurnProgress } from "./turn-progress";
import { MobileWorkPanel, Sidebar } from "./workspace-nav";
import type {
  ClientMessage,
  ClientState,
  ClientTurnProgressPhaseId,
  SchedulerStatus,
  SikongSettings,
  TaskDetailView,
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

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (busy || pendingTurn) return;
      void refresh(selectedWorkspaceId);
    }, 4000);
    return () => window.clearInterval(interval);
  }, [busy, pendingTurn, selectedWorkspaceId]);

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
                  {state.scheduler ? <SchedulerBadge scheduler={state.scheduler} /> : null}
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
                scheduler={state?.scheduler}
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
