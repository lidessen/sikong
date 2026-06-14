import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nextId } from "../commands/ids";
import { commandNow, type CommandContext } from "../commands/types";

export type ClientWorkLogEntryKind =
  | "task_summary"
  | "decision"
  | "user_preference"
  | "project_status";

export interface ClientWorkLogEntry {
  id: string;
  kind: ClientWorkLogEntryKind;
  summary: string;
  workspaceId?: string;
  relatedTaskIds?: string[];
  createdAt: string;
}

export interface AppendClientWorkLogEntryInput {
  kind: ClientWorkLogEntryKind;
  summary: string;
  workspaceId?: string;
  relatedTaskIds?: string[];
}

export interface ClientWorkLogReadOptions {
  limit?: number;
}

export interface ClientWorkLog {
  append(ctx: CommandContext, input: AppendClientWorkLogEntryInput): Promise<ClientWorkLogEntry>;
  list(options?: ClientWorkLogReadOptions): Promise<ClientWorkLogEntry[]>;
}

export class FileClientWorkLog implements ClientWorkLog {
  constructor(private readonly dataDir: string) {}

  async append(
    ctx: CommandContext,
    input: AppendClientWorkLogEntryInput,
  ): Promise<ClientWorkLogEntry> {
    if (!input.summary.trim()) throw new Error("client work-log summary must be non-empty");
    const entry: ClientWorkLogEntry = {
      id: nextId("client_log", ctx.id),
      kind: input.kind,
      summary: input.summary.trim(),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.relatedTaskIds?.length ? { relatedTaskIds: [...input.relatedTaskIds] } : {}),
      createdAt: commandNow(ctx),
    };
    const file = clientWorkLogFile(this.dataDir);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  async list(options: ClientWorkLogReadOptions = {}): Promise<ClientWorkLogEntry[]> {
    let text: string;
    try {
      text = await readFile(clientWorkLogFile(this.dataDir), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const entries = text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ClientWorkLogEntry);
    const limit = options.limit ?? entries.length;
    return entries.slice(Math.max(0, entries.length - limit));
  }
}

export function clientWorkLogFile(dataDir: string): string {
  return join(dataDir, "client", "work-log.jsonl");
}
