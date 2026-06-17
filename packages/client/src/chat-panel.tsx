import { ArrowUp, Bot, Loader2, Sparkles, SquareX } from "lucide-react";
import { useCallback, useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { EmptyPanel } from "./empty-panel";
import { MessageView } from "./message-renderer";
import type { ClientMessage, ClientState } from "./types";

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
      {props.messages.map((item, index) => {
        const prev = index > 0 ? props.messages[index - 1] : undefined;
        const showDate =
          !prev || !isSameDay(prev.createdAt, item.createdAt);
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
      event.preventDefault();
      if (!props.busy && props.message.trim()) {
        props.onSubmit(event as unknown as FormEvent);
      }
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
          placeholder="Message Sikong…"
          rows={1}
          value={props.message}
          onChange={(event) => props.onMessageChange(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={props.busy}
        />
        <div className="flex items-center justify-between gap-2 border-t border-divider px-1.5 pt-2">
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
          <div className="ml-auto flex items-center gap-2">
            {props.busy && props.onCancel ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-[var(--radius-md)] text-destructive hover:bg-destructive/10"
                onClick={props.onCancel}
              >
                <SquareX data-icon="inline-start" />
                Cancel
              </Button>
            ) : null}
            <Button
              type="submit"
              size="icon"
              variant="primary"
              className="rounded-[var(--radius-md)] disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100"
              disabled={props.busy || !props.message.trim()}
              aria-label={props.busy ? "Sending…" : "Send message"}
            >
              {props.busy ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <ArrowUp data-icon="inline-start" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
