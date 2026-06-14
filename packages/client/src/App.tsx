import {
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  Layers3,
  Loader2,
  MessageSquare,
  PanelRight,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type React from "react";
import type { FormEvent } from "react";
import { getClientState, runTurn } from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Textarea } from "./components/ui/textarea";
import { MessageView } from "./message-renderer";
import { createTextMessage, messageFromTurnResponse } from "./messages";
import type { ClientMessage, ClientState, TaskCard } from "./types";

type InspectorMode = "tasks" | "memory";

export function App() {
  const [state, setState] = useState<ClientState | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>();
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("tasks");
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [messages, setMessages] = useState<ClientMessage[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function refresh(workspaceId?: string) {
    try {
      const next = await getClientState(workspaceId);
      setState(next);
      setSelectedWorkspaceId(next.selectedWorkspaceId);
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
    setMessages((items) => [...items, createTextMessage("user", text)]);
    try {
      const response = await runTurn({
        message: text,
        workspaceId: selectedWorkspaceId,
        taskId: selectedTaskId,
      });
      setMessages((items) => [...items, messageFromTurnResponse(response)]);
      await refresh(response.context.focus.workspaceId ?? selectedWorkspaceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid h-dvh grid-cols-1 lg:min-h-screen lg:grid-cols-[244px_minmax(0,1fr)_360px]">
        <Sidebar
          state={state}
          selectedWorkspaceId={selectedWorkspaceId}
          inspectorMode={inspectorMode}
          onModeChange={setInspectorMode}
          onSelectWorkspace={(workspaceId) => {
            setSelectedTaskId(undefined);
            setSelectedWorkspaceId(workspaceId);
          }}
        />

        <section className="flex min-h-0 min-w-0 flex-col border-x border-transparent lg:min-h-screen lg:border-border/70">
          <header className="shrink-0 border-b bg-background/95 px-4 py-2 backdrop-blur lg:sticky lg:top-0 lg:z-10 lg:py-3">
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="flex size-7 items-center justify-center rounded-md border bg-background text-foreground lg:hidden">
                      <SquareTerminal />
                    </div>
                    <p className="truncate text-sm font-medium">
                      {selectedWorkspace?.name ?? "No workspace selected"}
                    </p>
                    <Badge variant="outline">{activeTaskCount} active</Badge>
                  </div>
                  <p className="hidden truncate text-xs text-muted-foreground lg:block">
                    Transcript is interface state. Context comes from work log and focus.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="hidden lg:inline-flex"
                  onClick={() => setInspectorMode(inspectorMode === "tasks" ? "memory" : "tasks")}
                >
                  <PanelRight data-icon="inline-start" />
                  Inspector
                </Button>
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
              <div className="hidden flex-col gap-2 border-t pt-3 lg:flex lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                  <div className="mb-1 flex items-center gap-2">
                    <CircleDot className="text-muted-foreground" />
                    <h2 className="text-lg font-semibold tracking-normal">Activity</h2>
                  </div>
                  <p className="max-w-xl text-sm text-muted-foreground">
                    One continuous operating thread for workspaces, tasks, and durable progress.
                  </p>
                </div>
                <div className="flex gap-2 text-xs">
                  <Badge variant="secondary">{state.workspaces.length} workspaces</Badge>
                  <Badge variant="secondary">{terminalCount} finished</Badge>
                </div>
              </div>
            </div>
            {error ? (
              <div className="mx-auto mt-2 max-w-3xl">
                <Badge variant="destructive">{error}</Badge>
              </div>
            ) : null}
          </header>

          <div className="flex-1 overflow-auto px-4 py-4 lg:py-6">
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
            onModeChange={setInspectorMode}
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
      />
    </main>
  );
}

function Sidebar(props: {
  state: ClientState;
  selectedWorkspaceId?: string;
  inspectorMode: InspectorMode;
  onModeChange: (mode: InspectorMode) => void;
  onSelectWorkspace: (workspaceId: string) => void;
}) {
  return (
    <aside className="hidden border-b bg-sidebar/70 px-3 py-3 lg:block lg:border-b-0 lg:border-r">
      <div className="mb-4 flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md border bg-background text-foreground">
            <SquareTerminal />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Sikong</h1>
            <p className="truncate text-xs text-muted-foreground">Client Agent</p>
          </div>
        </div>
        <Badge variant="outline">{props.state.workspaces.length}</Badge>
      </div>

      <nav className="mb-4 grid grid-cols-3 gap-1 lg:flex lg:flex-col">
        <NavItem icon={<MessageSquare />} label="Activity" active />
        <NavItem
          icon={<Layers3 />}
          label="Tasks"
          active={props.inspectorMode === "tasks"}
          onClick={() => props.onModeChange("tasks")}
        />
        <NavItem
          icon={<Bot />}
          label="Memory"
          active={props.inspectorMode === "memory"}
          onClick={() => props.onModeChange("memory")}
        />
      </nav>

      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between px-1">
          <p className="text-xs font-medium text-muted-foreground">Workspaces</p>
          <ChevronDown />
        </div>
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
          {props.state.workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={`flex min-w-40 shrink-0 items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm lg:min-w-0 lg:shrink ${
                workspace.id === props.selectedWorkspaceId
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/70"
              }`}
              onClick={() => props.onSelectWorkspace(workspace.id)}
            >
              <span className="truncate">{workspace.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{workspace.id}</span>
            </button>
          ))}
          {props.state.workspaces.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted-foreground">No workspaces yet.</p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function NavItem(props: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex items-center justify-center gap-2 rounded-md px-2 py-2 text-sm lg:justify-start ${
        props.active ? "bg-background text-foreground shadow-xs" : "text-muted-foreground"
      }`}
      onClick={props.onClick}
    >
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function ActivityStream(props: { messages: ClientMessage[]; state: ClientState }) {
  const streamItems =
    props.messages.length > 0
      ? props.messages
      : [
          createTextMessage(
            "assistant",
            "No activity yet. The visible transcript stays separate from agent memory.",
          ),
        ];
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      {streamItems.map((item) => (
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
      className="sticky bottom-0 border-t bg-background/95 px-4 py-3 backdrop-blur lg:static"
      onSubmit={props.onSubmit}
    >
      <div className="mx-auto max-w-3xl rounded-xl border bg-card p-2 shadow-sm">
        <Textarea
          className="min-h-16 border-0 px-2 shadow-none focus-visible:ring-0"
          placeholder="Message Sikong..."
          value={props.message}
          onChange={(event) => props.onMessageChange(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2 px-1 pt-2">
          <p className="text-xs text-muted-foreground">Uses work log + focused task context</p>
          <Button
            type="submit"
            size="icon"
            className="size-9 rounded-full disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
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
}) {
  return (
    <aside className="border-t bg-muted/20 p-3 lg:border-l lg:border-t-0">
      <div className="mb-3 flex rounded-lg border bg-card p-1">
        <button
          type="button"
          className={`flex flex-1 items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm ${
            props.inspectorMode === "tasks"
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground"
          }`}
          onClick={() => props.onModeChange("tasks")}
        >
          <Layers3 />
          Tasks
        </button>
        <button
          type="button"
          className={`flex flex-1 items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm ${
            props.inspectorMode === "memory"
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground"
          }`}
          onClick={() => props.onModeChange("memory")}
        >
          <Bot />
          Work Log
        </button>
      </div>

      {props.inspectorMode === "tasks" ? (
        <TaskInspector
          tasks={props.state.taskCards}
          selectedTask={props.selectedTask}
          selectedTaskId={props.selectedTaskId}
          onSelectTask={props.onSelectTask}
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
}) {
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-20 bg-foreground/20 lg:hidden" onClick={props.onClose}>
      <aside
        className="absolute inset-x-0 bottom-0 flex max-h-[78dvh] flex-col rounded-t-2xl border bg-background shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">Context</p>
            <p className="truncate text-xs text-muted-foreground">
              Workspaces, tasks, and durable work log.
            </p>
          </div>
          <Button type="button" size="icon" variant="ghost" onClick={props.onClose}>
            <X />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <section className="mb-4">
            <div className="mb-2 flex items-center justify-between px-1">
              <p className="text-xs font-medium text-muted-foreground">Workspaces</p>
              <Badge variant="outline">{props.state.workspaces.length}</Badge>
            </div>
            <div className="flex flex-col gap-1">
              {props.state.workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className={`flex items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm ${
                    workspace.id === props.selectedWorkspaceId
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground"
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
                <p className="rounded-lg border border-dashed bg-card p-3 text-sm text-muted-foreground">
                  No workspaces yet.
                </p>
              ) : null}
            </div>
          </section>

          <Inspector
            state={props.state}
            selectedTask={props.selectedTask}
            selectedTaskId={props.selectedTaskId}
            inspectorMode={props.inspectorMode}
            onSelectTask={props.onSelectTask}
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
}) {
  return (
    <div className="flex flex-col gap-3">
      <Card className="shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Tasks</CardTitle>
          <CardDescription>Current durable work for the selected workspace.</CardDescription>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:flex-col">
        {props.tasks.map((task) => (
          <TaskCardButton
            key={task.taskId}
            task={task}
            selected={task.taskId === props.selectedTaskId}
            onSelect={() => props.onSelectTask(task.taskId)}
          />
        ))}
        {props.tasks.length === 0 ? (
          <p className="rounded-lg border border-dashed bg-card p-3 text-sm text-muted-foreground">
            No task cards in this workspace.
          </p>
        ) : null}
      </div>

      {props.selectedTask ? <TaskDetail task={props.selectedTask} /> : null}
    </div>
  );
}

function TaskCardButton(props: { task: TaskCard; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`rounded-lg border bg-card p-3 text-left text-sm shadow-xs transition-colors ${
        props.selected ? "ring-[3px] ring-ring/35" : "hover:bg-accent"
      }`}
      onClick={props.onSelect}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <span className="truncate font-mono text-xs">{props.task.taskId}</span>
        <TaskStatusBadge task={props.task} />
      </div>
      <p className="line-clamp-2 text-muted-foreground">
        {props.task.request ?? props.task.nextAction.type}
      </p>
    </button>
  );
}

function TaskDetail(props: { task: TaskCard }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-sm">{props.task.taskId}</CardTitle>
        <CardDescription>{props.task.request ?? props.task.nextAction.type}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <Metric
            icon={<Clock3 />}
            label="Runtime"
            value={`${props.task.runtimeProcesses.running} running`}
          />
          <Metric
            icon={<CheckCircle2 />}
            label="Lead wait"
            value={props.task.waitingForLead ? "yes" : "no"}
          />
        </dl>
      </CardContent>
    </Card>
  );
}

function MemoryInspector(props: { state: ClientState }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Client Work Log</CardTitle>
        <CardDescription>Durable memory for future turns.</CardDescription>
      </CardHeader>
      <CardContent className="flex max-h-[520px] flex-col gap-2 overflow-auto">
        {props.state.workLog.map((entry) => (
          <div key={entry.id} className="rounded-lg border bg-background p-3 text-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Badge variant="outline">{entry.kind}</Badge>
              <span className="text-xs text-muted-foreground">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="leading-relaxed">{entry.summary}</p>
          </div>
        ))}
        {props.state.workLog.length === 0 ? (
          <p className="text-sm text-muted-foreground">No client work-log entries.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Metric(props: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background p-2">
      <dt className="mb-1 flex items-center gap-1 text-muted-foreground">
        {props.icon}
        {props.label}
      </dt>
      <dd className="font-medium">{props.value}</dd>
    </div>
  );
}

function TaskStatusBadge(props: { task: TaskCard }) {
  if (props.task.terminal) return <Badge variant="secondary">{props.task.terminal.outcome}</Badge>;
  if (props.task.waitingForLead) return <Badge variant="outline">lead</Badge>;
  return <Badge variant="secondary">{props.task.status}</Badge>;
}
