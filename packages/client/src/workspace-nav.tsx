import { ChevronRight, Folder, GitBranch, Inbox, Settings, SquareTerminal, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { EmptyPanel } from "./empty-panel";
import {
  nextActionBadgeVariant,
  nextActionLabel,
  statusBadgeVariant,
  taskPhaseLabel,
} from "./task-labels";
import { taskRequestPreview } from "./task-request";
import type { ClientState, TaskCard, Workspace } from "./types";

export function Sidebar(props: {
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

export function MobileWorkPanel(props: {
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
    <div
      className="fixed inset-0 z-20 bg-black/55 backdrop-blur-[1px] animate-backdrop-in lg:hidden"
      onClick={props.onClose}
    >
      <aside
        className="absolute inset-x-0 bottom-0 flex max-h-[80dvh] flex-col rounded-t-[var(--radius-xl)] border border-border bg-background shadow-[var(--shadow-sheet)] animate-sheet-up"
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

function WorkspaceWorkList(props: {
  state: ClientState;
  selectedWorkspaceId?: string;
  selectedTaskId?: string;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectTask: (taskId: string) => void;
}) {
  const running = props.state.taskCards.filter((task) => !task.terminal);
  const finished = props.state.taskCards.filter((task) => task.terminal);
  const [finishedOpen, setFinishedOpen] = useState(finished.length <= 3);
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Workspaces
          </p>
          <Badge variant="outline">{props.state.workspaces.length}</Badge>
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
              <button
                type="button"
                className="mb-1.5 flex w-full items-center justify-between rounded-[var(--radius-sm)] px-1 py-0.5 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover"
                aria-expanded={finishedOpen}
                onClick={() => setFinishedOpen((open) => !open)}
              >
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <ChevronRight
                    className={`size-3 transition-transform ${finishedOpen ? "rotate-90" : ""}`}
                  />
                  Finished
                </span>
                <Badge variant="secondary">{finished.length}</Badge>
              </button>
              {finishedOpen ? (
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
              ) : null}
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

function TaskCardButton(props: { task: TaskCard; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`rounded-[var(--radius-lg)] border bg-card p-2.5 text-left text-[13px] outline-none transition-[background-color,border-color,transform,box-shadow] active:translate-y-px focus-visible:border-ring ${
        props.selected
          ? "border-[var(--accent-dim)] bg-[var(--accent-soft)] shadow-[inset_0_0_0_1px_var(--accent-dim)]"
          : "hover:border-ring/25 hover:bg-hover"
      }`}
      onClick={props.onSelect}
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <span
          className="truncate font-mono text-[11px] text-muted-foreground"
          title={props.task.taskId}
        >
          {props.task.taskId.length > 22 ? `${props.task.taskId.slice(0, 20)}…` : props.task.taskId}
        </span>
        <TaskStatusBadge task={props.task} />
      </div>
      <p className="line-clamp-2 text-[13px] leading-5 text-foreground/90">
        {taskRequestPreview(props.task.request ?? props.task.nextAction.type, 160)}
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

function TaskStatusBadge(props: { task: TaskCard }) {
  return <Badge variant={statusBadgeVariant(props.task)}>{taskPhaseLabel(props.task)}</Badge>;
}
