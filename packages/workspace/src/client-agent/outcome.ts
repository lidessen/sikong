import { fail, type CommandResult } from "../commands";

export type ClientTurnOutcomeKind = "report" | "question" | "request";

export interface ClientTurnOutcomeFact {
  label: string;
  value: string;
}

export interface ClientTurnOutcomeRef {
  type: "workspace" | "task" | "transcript" | "other";
  id: string;
}

export interface ClientTurnOutcomeTarget {
  workspaceId?: string;
  taskId?: string;
  planId?: string;
  version?: number;
}

export type ClientTurnOutcome =
  | {
      kind: "report";
      title: string;
      summary: string;
      facts?: ClientTurnOutcomeFact[];
      refs?: ClientTurnOutcomeRef[];
    }
  | {
      kind: "question";
      question: string;
      context?: string;
      options?: string[];
      refs?: ClientTurnOutcomeRef[];
    }
  | {
      kind: "request";
      requestType: "plan_decision" | "final_decision" | "permission" | "clarification" | "other";
      title: string;
      body: string;
      target?: ClientTurnOutcomeTarget;
      refs?: ClientTurnOutcomeRef[];
    };

export interface ClientTurnOutcomeSink {
  outcome?: ClientTurnOutcome;
}

export function parseClientTurnOutcome(
  args: Record<string, unknown>,
): CommandResult<ClientTurnOutcome> {
  const kind = readString(args, "kind");
  if (!kind.ok) return kind;

  if (kind.data === "report") {
    const title = readString(args, "title");
    if (!title.ok) return title;
    const summary = readString(args, "summary");
    if (!summary.ok) return summary;
    return {
      ok: true,
      data: {
        kind: "report",
        title: title.data,
        summary: summary.data,
        ...optionalFacts(args),
        ...optionalRefs(args),
      },
    };
  }

  if (kind.data === "question") {
    const question = readString(args, "question");
    if (!question.ok) return question;
    return {
      ok: true,
      data: {
        kind: "question",
        question: question.data,
        ...optionalString(args, "context"),
        ...optionalStringArray(args, "options"),
        ...optionalRefs(args),
      },
    };
  }

  if (kind.data === "request") {
    const requestType = readString(args, "requestType");
    if (!requestType.ok) return requestType;
    if (!isRequestType(requestType.data)) {
      return fail("invalid_input", "requestType must be a supported client request type.");
    }
    const title = readString(args, "title");
    if (!title.ok) return title;
    const body = readString(args, "body");
    if (!body.ok) return body;
    return {
      ok: true,
      data: {
        kind: "request",
        requestType: requestType.data,
        title: title.data,
        body: body.data,
        ...optionalTarget(args),
        ...optionalRefs(args),
      },
    };
  }

  return fail("invalid_input", "kind must be report, question, or request.");
}

export function formatClientTurnOutcomeText(outcome: ClientTurnOutcome): string {
  if (outcome.kind === "report") {
    const facts = outcome.facts?.map((fact) => `- ${fact.label}: ${fact.value}`).join("\n");
    return facts ? `**${outcome.title}**\n\n${outcome.summary}\n\n${facts}` : outcome.summary;
  }
  if (outcome.kind === "question") {
    const options = outcome.options?.map((option) => `- ${option}`).join("\n");
    const context = outcome.context ? `${outcome.context}\n\n` : "";
    return options
      ? `${context}${outcome.question}\n\n${options}`
      : `${context}${outcome.question}`;
  }
  return `**${outcome.title}**\n\n${outcome.body}`;
}

function readString(args: Record<string, unknown>, key: string): CommandResult<string> {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    return fail("invalid_input", `${key} must be a non-empty string.`);
  }
  return { ok: true, data: value };
}

function optionalString(args: Record<string, unknown>, key: string): { [key: string]: string } {
  const value = args[key];
  return typeof value === "string" && value.trim() ? { [key]: value } : {};
}

function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
): { [key: string]: string[] } {
  const value = args[key];
  if (!Array.isArray(value)) return {};
  const strings = value.filter((item): item is string => typeof item === "string" && !!item.trim());
  return strings.length ? { [key]: strings } : {};
}

function optionalFacts(args: Record<string, unknown>): { facts?: ClientTurnOutcomeFact[] } {
  const value = args.facts;
  if (!Array.isArray(value)) return {};
  const facts = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.label === "string" &&
      record.label.trim() &&
      typeof record.value === "string" &&
      record.value.trim()
      ? [{ label: record.label, value: record.value }]
      : [];
  });
  return facts.length ? { facts } : {};
}

function optionalRefs(args: Record<string, unknown>): { refs?: ClientTurnOutcomeRef[] } {
  const value = args.refs;
  if (!Array.isArray(value)) return {};
  const refs = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return isRefType(record.type) && typeof record.id === "string" && record.id.trim()
      ? [{ type: record.type, id: record.id }]
      : [];
  });
  return refs.length ? { refs } : {};
}

function optionalTarget(args: Record<string, unknown>): { target?: ClientTurnOutcomeTarget } {
  const value = args.target;
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const target: ClientTurnOutcomeTarget = {
    ...(typeof record.workspaceId === "string" && record.workspaceId.trim()
      ? { workspaceId: record.workspaceId }
      : {}),
    ...(typeof record.taskId === "string" && record.taskId.trim() ? { taskId: record.taskId } : {}),
    ...(typeof record.planId === "string" && record.planId.trim() ? { planId: record.planId } : {}),
    ...(typeof record.version === "number" ? { version: record.version } : {}),
  };
  return Object.keys(target).length ? { target } : {};
}

function isRequestType(
  value: string,
): value is Extract<ClientTurnOutcome, { kind: "request" }>["requestType"] {
  return (
    value === "plan_decision" ||
    value === "final_decision" ||
    value === "permission" ||
    value === "clarification" ||
    value === "other"
  );
}

function isRefType(value: unknown): value is ClientTurnOutcomeRef["type"] {
  return value === "workspace" || value === "task" || value === "transcript" || value === "other";
}
