import { stageById } from "../workflow/reducer";
import type { Command, TaskEvent } from "../workflow/types";
import type { SteerMailboxEntry } from "./steer-mailbox";

export function isStageCommitSignal(command: Command, stage: ReturnType<typeof stageById>): boolean {
  switch (command.kind) {
    case "request_transition":
    case "block":
    case "cancel":
    case "create_subtask":
      return true;
    case "set_field":
      return !stage?.outputFields?.length || stage.outputFields.includes(command.field);
    default:
      return false;
  }
}

export function closesCurrentRun(command: Command): boolean {
  switch (command.kind) {
    case "request_transition":
    case "block":
    case "cancel":
      return true;
    default:
      return false;
  }
}

export function ackedLeadMessageIds(commands: readonly Command[]): Set<string> {
  const ids = new Set<string>();
  for (const command of commands) {
    if (command.kind !== "ack_lead_messages") continue;
    for (const id of command.ids) {
      const normalized = id.trim();
      if (normalized) ids.add(normalized);
    }
  }
  return ids;
}

export function summarizeLeadMessage(entry: SteerMailboxEntry): Record<string, unknown> {
  return {
    id: entry.id,
    kind: entry.kind,
    source: entry.source,
    createdAt: entry.createdAt,
    message: entry.message,
  };
}

export function stopReasonFromEvent(event: TaskEvent): string | undefined {
  if (event.source !== "lead" && event.source !== "engine") return undefined;
  if (event.type !== "task.cancelled" && event.type !== "task.blocked") return undefined;
  const reason = typeof event.payload.reason === "string" ? event.payload.reason : event.type;
  return `sikong ${event.type}: ${reason}`;
}

/** Task ids become filenames in the durable stores — keep them collision- and traversal-safe. */
export function assertValidTaskId(id: string): void {
  if (!id || id === "." || id === ".." || !/^[A-Za-z0-9._-]+$/.test(id))
    throw new Error(`invalid task id "${id}": must match [A-Za-z0-9._-]+ and not be "." or ".."`);
}
