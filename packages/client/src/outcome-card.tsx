import { AlertTriangle, CircleHelp, ClipboardList, MessageSquareQuote } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { MarkdownMessage } from "./markdown-message";
import type { ClientTurnOutcome } from "./types";

export function TurnOutcomeCard(props: {
  outcome: ClientTurnOutcome;
  onOpenTask?: (taskId: string) => void;
  onSendMessage?: (text: string) => void;
}) {
  if (props.outcome.kind === "report") {
    return (
      <div className="rounded-[var(--radius-lg)] border bg-background p-3">
        <div className="mb-2 flex items-start gap-2">
          <ClipboardList className="mt-0.5 shrink-0 text-info" />
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="info">Report</Badge>
              <p className="text-[13px] font-medium">{props.outcome.title}</p>
            </div>
            <MarkdownMessage compact text={props.outcome.summary} />
          </div>
        </div>
        {props.outcome.facts?.length ? (
          <dl className="mt-2 grid gap-1.5 border-t border-border-soft pt-2">
            {props.outcome.facts.map((fact) => (
              <div
                key={fact.label}
                className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 text-[12px]"
              >
                <dt className="text-muted-foreground">{fact.label}</dt>
                <dd className="break-words">{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <OutcomeRefs refs={props.outcome.refs} onOpenTask={props.onOpenTask} />
      </div>
    );
  }

  if (props.outcome.kind === "question") {
    return (
      <div className="rounded-[var(--radius-lg)] border border-warn/25 bg-[var(--warn-soft)]/40 p-3">
        <div className="mb-2 flex items-start gap-2">
          <CircleHelp className="mt-0.5 shrink-0 text-warn" />
          <div className="min-w-0">
            <Badge variant="warn" className="mb-1.5">
              Question
            </Badge>
            {props.outcome.context ? (
              <p className="mb-2 text-[12px] leading-5 text-muted-foreground">
                {props.outcome.context}
              </p>
            ) : null}
            <MarkdownMessage compact text={props.outcome.question} />
          </div>
        </div>
        {props.outcome.options?.length ? (
          <ul className="mt-2 space-y-1 border-t border-border-soft pt-2 text-[12px]">
            {props.outcome.options.map((option) => (
              <li
                key={option}
                className="rounded-[var(--radius-sm)] border bg-background px-2 py-1.5"
              >
                {option}
              </li>
            ))}
          </ul>
        ) : null}
        <OutcomeRefs refs={props.outcome.refs} onOpenTask={props.onOpenTask} />
      </div>
    );
  }

  const requestLabel =
    props.outcome.requestType === "plan_decision"
      ? "Plan decision"
      : props.outcome.requestType === "final_decision"
        ? "Final decision"
        : props.outcome.requestType === "permission"
          ? "Permission"
          : props.outcome.requestType === "clarification"
            ? "Clarification"
            : "Request";

  const suggestedReply = leadDecisionReply(props.outcome);

  return (
    <div className="rounded-[var(--radius-lg)] border border-accent/25 bg-[var(--accent-soft)]/35 p-3">
      <div className="mb-2 flex items-start gap-2">
        <MessageSquareQuote className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="accent">{requestLabel}</Badge>
            <p className="text-[13px] font-medium">{props.outcome.title}</p>
          </div>
          <MarkdownMessage compact text={props.outcome.body} />
        </div>
      </div>
      {suggestedReply && props.onSendMessage ? (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-border-soft pt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => props.onSendMessage?.(suggestedReply.accept)}
          >
            Accept
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => props.onSendMessage?.(suggestedReply.reject)}
          >
            Reject with reason
          </Button>
        </div>
      ) : null}
      <OutcomeRefs refs={props.outcome.refs} onOpenTask={props.onOpenTask} />
    </div>
  );
}

function OutcomeRefs(props: {
  refs?: ClientTurnOutcome["refs"];
  onOpenTask?: (taskId: string) => void;
}) {
  if (!props.refs?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border-soft pt-2">
      {props.refs.map((ref) =>
        ref.type === "task" && props.onOpenTask ? (
          <Button
            key={`${ref.type}-${ref.id}`}
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={() => props.onOpenTask?.(ref.id)}
          >
            Open task {ref.id.slice(0, 12)}
          </Button>
        ) : (
          <Badge key={`${ref.type}-${ref.id}`} variant="outline">
            {ref.type} · {ref.id.slice(0, 16)}
          </Badge>
        ),
      )}
    </div>
  );
}

function leadDecisionReply(
  outcome: Extract<ClientTurnOutcome, { kind: "request" }>,
): { accept: string; reject: string } | undefined {
  if (outcome.requestType === "plan_decision") {
    return {
      accept: "Accept the submitted plan for this task.",
      reject: "Reject the submitted plan. Request changes: ",
    };
  }
  if (outcome.requestType === "final_decision") {
    return {
      accept: "Accept the final task result.",
      reject: "Reject the final task result. Reason: ",
    };
  }
  return undefined;
}

export function LeadDecisionPendingCard(props: {
  taskId: string;
  nextActionType: string;
  planStatus?: string;
  report?: string;
  onSendMessage?: (text: string) => void;
}) {
  const kind = leadPendingKind(props.nextActionType);
  if (!kind) return null;

  return (
    <div className="rounded-[var(--radius-lg)] border border-warn/30 bg-[var(--warn-soft)]/30 p-3">
      <div className="mb-2 flex items-start gap-2">
        <AlertTriangle className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0">
          <Badge variant="warn" className="mb-1.5">
            Lead decision pending
          </Badge>
          <p className="text-[13px] font-medium">{kind.title}</p>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{kind.detail}</p>
        </div>
      </div>
      {props.report ? (
        <div className="mb-2 rounded-[var(--radius-md)] border bg-background/80 p-2.5">
          <MarkdownMessage compact text={props.report} />
        </div>
      ) : null}
      {props.onSendMessage ? (
        <div className="flex flex-wrap gap-2">
          {kind.prompts.map((prompt) => (
            <Button
              key={prompt.label}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => props.onSendMessage?.(prompt.text)}
            >
              {prompt.label}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">
          Switch to Chat and tell the Client Agent your decision.
        </p>
      )}
    </div>
  );
}

function leadPendingKind(
  nextActionType: string,
): { title: string; detail: string; prompts: { label: string; text: string }[] } | undefined {
  if (nextActionType === "start_lead_plan_decision") {
    return {
      title: "Plan review required",
      detail: "A planner submitted a plan. Accept or reject it through the Client Agent.",
      prompts: [
        { label: "Accept plan", text: "Accept the submitted plan for this task." },
        { label: "Reject plan", text: "Reject the submitted plan. Request changes: " },
      ],
    };
  }
  if (nextActionType === "start_lead_final_decision") {
    return {
      title: "Final review required",
      detail: "Reviewers finished. Accept or reject the final task outcome in chat.",
      prompts: [
        { label: "Accept result", text: "Accept the final task result." },
        { label: "Reject result", text: "Reject the final task result. Reason: " },
      ],
    };
  }
  if (nextActionType === "start_lead_requirement_spec") {
    return {
      title: "Requirement spec required",
      detail: "Lead needs a requirement spec before planning can continue.",
      prompts: [{ label: "Provide spec", text: "Here is the requirement spec for this task: " }],
    };
  }
  if (nextActionType === "start_lead_round_planning") {
    return {
      title: "Round planning required",
      detail: "Lead needs to plan the next stage round before workers can continue.",
      prompts: [{ label: "Plan round", text: "Plan the next stage round for this task." }],
    };
  }
  return undefined;
}
