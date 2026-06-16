import { ArrowUp, Bot, Loader2 } from "lucide-react";
import type { FormEvent } from "react";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { EmptyPanel } from "./empty-panel";
import { MessageView } from "./message-renderer";
import type { ClientMessage, ClientState } from "./types";

export function ActivityStream(props: {
  messages: ClientMessage[];
  state: ClientState;
  onOpenTask: (taskId: string) => void;
  onDeleteMessage: (messageId: string) => void;
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
          onDelete={props.onDeleteMessage}
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

export function Composer(props: {
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
