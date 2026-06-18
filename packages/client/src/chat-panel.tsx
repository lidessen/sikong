import { ArrowUp, Bot, Sparkles, Square } from "lucide-react";
import { useCallback, useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { EmptyPanel } from "./empty-panel";
import { MessageView } from "./message-renderer";
import { taskRequestPreview } from "./task-request";
import type { ClientMessage, ClientState, TaskCard } from "./types";

const SUGGESTED_PROMPTS = [
  "Create a workspace for a new project",
  "Show active work items and their status",
  "What can you help me with?",
];

function isSameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function formatDateSeparator(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(value, today.toISOString())) return "Today";
  if (isSameDay(value, yesterday.toISOString())) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function ActivityStream(props: {
  messages: ClientMessage[];
  state: ClientState;
  onOpenTask: (taskId: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onSendMessage?: (text: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldStickRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current?.closest("[data-activity-scroll]");
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldStickRef.current = distanceFromBottom < 120;
  }, []);

  useEffect(() => {
    const el = containerRef.current?.closest("[data-activity-scroll]");
    el?.addEventListener("scroll", handleScroll, { passive: true });
    return () => el?.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    if (!shouldStickRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [props.messages]);

  if (props.messages.length === 0) {
    return (
      <div className="mx-auto flex max-w-[840px] flex-col items-center justify-center px-2 pt-[10dvh] pb-8">
        <EmptyPanel
          className="w-full max-w-md p-6 text-center"
          icon={<Bot />}
          title="Start a conversation"
          description="Ask Sikong to create workspaces, submit work items, or check on running tasks."
        />
        {props.onSendMessage ? (
          <div className="mt-5 flex w-full max-w-md flex-col gap-2">
            <p className="flex items-center justify-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
              <Sparkles className="size-3" />
              Try asking
            </p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="rounded-[var(--radius-md)] border border-border-soft bg-surface px-3 py-2 text-left text-[13px] text-muted-foreground outline-none transition-[background-color,border-color,color] hover:border-ring/30 hover:bg-hover hover:text-foreground focus-visible:border-ring"
                  onClick={() => props.onSendMessage?.(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="mx-auto flex max-w-[840px] flex-col gap-4">
      <WorkOverviewStrip state={props.state} onOpenTask={props.onOpenTask} />
      {props.messages.map((item, index) => {
        const prev = index > 0 ? props.messages[index - 1] : undefined;
        const showDate = !prev || !isSameDay(prev.createdAt, item.createdAt);
        return (
          <div key={item.id}>
            {showDate ? (
              <div className="mb-4 flex items-center gap-3">
                <div className="h-px flex-1 bg-divider" />
                <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
                  {formatDateSeparator(item.createdAt)}
                </span>
                <div className="h-px flex-1 bg-divider" />
              </div>
            ) : null}
            <MessageView
              message={item}
              onDelete={props.onDeleteMessage}
              context={{
                state: props.state,
                onAction: (action) => {
                  if (action.type === "focusTask") props.onOpenTask(action.taskId);
                },
                onSendMessage: props.onSendMessage,
              }}
            />
          </div>
        );
      })}
      <div ref={bottomRef} className="h-px shrink-0" aria-hidden="true" />
    </div>
  );
}

function WorkOverviewStrip(props: { state: ClientState; onOpenTask: (taskId: string) => void }) {
  const needsDecision = props.state.taskCards.filter((task) => task.waitingForLead);
  const running = props.state.taskCards.filter((task) => !task.terminal && !task.waitingForLead);
  const issues = props.state.taskCards.filter(
    (task) =>
      task.terminal?.outcome === "rejected" ||
      task.latestWorkerResult?.status === "failed" ||
      task.latestWorkerResult?.status === "budget_exceeded",
  );
  const completed = props.state.taskCards.filter((task) => task.terminal?.outcome === "accepted");
  return (
    <section className="border-b border-divider pb-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 shrink-0 text-[11px] font-medium text-muted-foreground">
          Work summary
        </span>
        <OverviewChip
          label="Needs decision"
          count={needsDecision.length}
          variant={needsDecision.length ? "warn" : "outline"}
          task={needsDecision[0]}
          onOpenTask={props.onOpenTask}
        />
        <OverviewChip
          label="Running"
          count={running.length}
          variant={running.length ? "info" : "outline"}
          task={running[0]}
          onOpenTask={props.onOpenTask}
        />
        <OverviewChip
          label="Issues"
          count={issues.length}
          variant={issues.length ? "err" : "outline"}
          task={issues[0]}
          onOpenTask={props.onOpenTask}
        />
        <OverviewChip
          label="Completed"
          count={completed.length}
          variant={completed.length ? "ok" : "outline"}
          task={completed[0]}
          onOpenTask={props.onOpenTask}
        />
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {props.state.taskCards.length} total
        </span>
      </div>
    </section>
  );
}

function OverviewChip(props: {
  label: string;
  count: number;
  variant: "warn" | "info" | "err" | "ok" | "outline";
  task?: TaskCard;
  onOpenTask: (taskId: string) => void;
}) {
  const content = (
    <>
      <span className="text-[11px] text-muted-foreground">{props.label}</span>
      <Badge variant={props.variant}>{props.count}</Badge>
      {props.task ? (
        <span className="hidden max-w-[180px] truncate text-[11px] font-medium text-foreground md:inline">
          {taskRequestPreview(props.task.request ?? props.task.nextAction.type, 32)}
        </span>
      ) : null}
    </>
  );
  if (!props.task) {
    return (
      <div className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-md)] border border-border-soft bg-background/45 px-2">
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-[var(--radius-md)] border border-border-soft bg-background/45 px-2 text-left outline-none transition-[background-color,border-color] hover:border-border-strong hover:bg-hover focus-visible:border-ring"
      onClick={() => props.onOpenTask(props.task!.taskId)}
    >
      {content}
    </button>
  );
}

export function Composer(props: {
  busy: boolean;
  message: string;
  onMessageChange: (message: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [props.message]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      if (props.busy) return;
      event.preventDefault();
      if (props.message.trim()) props.onSubmit(event as unknown as FormEvent);
    }
  }

  return (
    <form
      className="sticky bottom-0 border-t border-divider bg-bg/95 px-4 py-3 backdrop-blur lg:static"
      onSubmit={props.onSubmit}
    >
      <div className="mx-auto max-w-[840px] rounded-[var(--radius-lg)] border border-input bg-surface p-1.5 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.35)] transition-[border-color,box-shadow] focus-within:border-ring focus-within:shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.35),0_0_0_1px_color-mix(in_srgb,var(--accent)_25%,transparent)]">
        <Textarea
          ref={textareaRef}
          className="min-h-11 max-h-40 border-0 bg-transparent px-2.5 py-2 text-[13px] shadow-none focus-visible:outline-none"
          placeholder="Ask Sikong to plan, check progress, unblock work, or summarize results…"
          rows={1}
          value={props.message}
          onChange={(event) => props.onMessageChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="flex items-center justify-between gap-2 border-t border-divider px-1.5 pt-2">
          {props.busy ? (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-info" aria-hidden="true" />
              Turn running
            </p>
          ) : (
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              <kbd className="rounded-[var(--radius-sm)] border border-border-soft bg-background px-1 py-px font-mono text-[10px]">
                Enter
              </kbd>{" "}
              to send ·{" "}
              <kbd className="rounded-[var(--radius-sm)] border border-border-soft bg-background px-1 py-px font-mono text-[10px]">
                Shift+Enter
              </kbd>{" "}
              for newline
            </p>
          )}
          <div className="ml-auto flex items-center gap-2">
            {props.busy && props.onCancel ? (
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="rounded-[var(--radius-md)] text-destructive hover:bg-destructive/10"
                onClick={props.onCancel}
                aria-label="Cancel current turn"
              >
                <Square data-icon="inline-start" />
              </Button>
            ) : null}
            <Button
              type="submit"
              size="icon"
              variant="primary"
              className="rounded-[var(--radius-md)] disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100"
              disabled={props.busy || !props.message.trim()}
              aria-label={props.busy ? "Wait for current turn to finish" : "Send message"}
            >
              <ArrowUp data-icon="inline-start" />
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
