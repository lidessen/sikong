import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SteerMailboxEntry {
  id: string;
  taskId: string;
  message: string;
  createdAt: number;
  source: "lead";
}

export interface SteerMailbox {
  submit(taskId: string, message: string): Promise<SteerMailboxEntry>;
  list(taskId: string): Promise<SteerMailboxEntry[]>;
  remove(taskId: string, id: string): Promise<void>;
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isEntry(value: unknown): value is SteerMailboxEntry {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as SteerMailboxEntry).id === "string" &&
    typeof (value as SteerMailboxEntry).taskId === "string" &&
    typeof (value as SteerMailboxEntry).message === "string" &&
    typeof (value as SteerMailboxEntry).createdAt === "number"
  );
}

export class JsonSteerMailbox implements SteerMailbox {
  constructor(private readonly dir: string) {}

  private taskDir(taskId: string): string {
    return join(this.dir, "state", "steer", sanitize(taskId));
  }

  async submit(taskId: string, message: string): Promise<SteerMailboxEntry> {
    const entry: SteerMailboxEntry = {
      id: randomUUID(),
      taskId,
      message,
      createdAt: Date.now(),
      source: "lead",
    };
    const root = this.taskDir(taskId);
    await mkdir(root, { recursive: true });
    const tmp = join(root, `${entry.id}.tmp`);
    const file = join(root, `${entry.id}.json`);
    await writeFile(tmp, `${JSON.stringify(entry)}\n`, "utf8");
    await rename(tmp, file);
    return entry;
  }

  async list(taskId: string): Promise<SteerMailboxEntry[]> {
    const root = this.taskDir(taskId);
    let names: string[];
    try {
      names = await readdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const entries: SteerMailboxEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(root, name), "utf8")) as unknown;
        if (isEntry(parsed)) entries.push(parsed);
      } catch {
        // Ignore a corrupt mailbox file for this poll; the next operator action
        // can remove it without endangering the task event log.
      }
    }
    return entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async remove(taskId: string, id: string): Promise<void> {
    await rm(join(this.taskDir(taskId), `${sanitize(id)}.json`), { force: true });
  }
}
