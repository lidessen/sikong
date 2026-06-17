import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { taskEventsFile, taskEventsLockFile, taskProjectionFile, touchSchedulerSignal, withFileLock } from "../data-dir";
import { applyTaskEvent, reduceTaskEvents } from "./reducer";
import type { TaskEvent, TaskProjection } from "./types";

export interface TaskEventStore {
  append(event: TaskEvent): Promise<void>;
  appendMany(events: readonly TaskEvent[]): Promise<void>;
  read(workspaceId: string, taskId: string): Promise<TaskEvent[]>;
}

export interface TaskProjectionStore {
  read(workspaceId: string, taskId: string): Promise<TaskProjection | null>;
  write(projection: TaskProjection): Promise<void>;
  rebuild(
    workspaceId: string,
    taskId: string,
    events: readonly TaskEvent[],
  ): Promise<TaskProjection | null>;
}

export class FileTaskEventStore implements TaskEventStore {
  constructor(private readonly dataDir: string) {}

  async append(event: TaskEvent): Promise<void> {
    await this.appendMany([event]);
  }

  async appendMany(events: readonly TaskEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.withTaskEventsLock(events, async () => {
      await appendEventsFile(this.dataDir, events);
    });
  }

  async appendManyAndRebuildProjection(
    events: readonly TaskEvent[],
  ): Promise<TaskProjection | null> {
    if (events.length === 0) return null;
    return await this.withTaskEventsLock(events, async (workspaceId, taskId) => {
      await appendEventsFile(this.dataDir, events);
      const allEvents = await readEventsFile(this.dataDir, workspaceId, taskId);
      const existing = await readProjectionFile(this.dataDir, workspaceId, taskId);
      if (existing && existing.eventCount + events.length === allEvents.length) {
        let projection = existing;
        for (const event of events) {
          projection = applyTaskEvent(projection, event);
        }
        if (projection.eventCount === allEvents.length) {
          await writeProjectionFile(this.dataDir, projection);
          return projection;
        }
      }
      const projection = reduceTaskEvents(allEvents);
      if (!projection) return null;
      await writeProjectionFile(this.dataDir, projection);
      return projection;
    });
  }

  async read(workspaceId: string, taskId: string): Promise<TaskEvent[]> {
    return await readEventsFile(this.dataDir, workspaceId, taskId);
  }

  private async withTaskEventsLock<T>(
    events: readonly TaskEvent[],
    fn: (workspaceId: string, taskId: string) => Promise<T>,
  ): Promise<T> {
    const first = events[0];
    if (!first) throw new Error("task event batch must be non-empty");
    for (const event of events) {
      if (event.workspaceId !== first.workspaceId || event.taskId !== first.taskId) {
        throw new Error("cannot append events for multiple tasks in one batch");
      }
    }

    return await withFileLock(
      taskEventsLockFile(this.dataDir, first.workspaceId, first.taskId),
      () => fn(first.workspaceId, first.taskId),
    );
  }
}

export class FileTaskProjectionStore implements TaskProjectionStore {
  constructor(private readonly dataDir: string) {}

  async read(workspaceId: string, taskId: string): Promise<TaskProjection | null> {
    const file = taskProjectionFile(this.dataDir, workspaceId, taskId);
    try {
      return JSON.parse(await readFile(file, "utf8")) as TaskProjection;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(projection: TaskProjection): Promise<void> {
    await writeProjectionFile(this.dataDir, projection);
  }

  async rebuild(
    workspaceId: string,
    taskId: string,
    events: readonly TaskEvent[],
  ): Promise<TaskProjection | null> {
    const projection = reduceTaskEvents(events);
    if (!projection) return null;
    if (projection.workspaceId !== workspaceId || projection.taskId !== taskId) {
      throw new Error("rebuilt projection does not match requested task");
    }
    await this.write(projection);
    return projection;
  }
}

async function appendEventsFile(dataDir: string, events: readonly TaskEvent[]): Promise<void> {
  if (events.length === 0) return;
  const first = events[0];
  if (!first) return;
  const file = taskEventsFile(dataDir, first.workspaceId, first.taskId);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

async function readEventsFile(
  dataDir: string,
  workspaceId: string,
  taskId: string,
): Promise<TaskEvent[]> {
  const file = taskEventsFile(dataDir, workspaceId, taskId);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  return text
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TaskEvent];
      } catch {
        return [];
      }
    });
}

async function readProjectionFile(
  dataDir: string,
  workspaceId: string,
  taskId: string,
): Promise<TaskProjection | null> {
  const file = taskProjectionFile(dataDir, workspaceId, taskId);
  try {
    return JSON.parse(await readFile(file, "utf8")) as TaskProjection;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeProjectionFile(dataDir: string, projection: TaskProjection): Promise<void> {
  const file = taskProjectionFile(dataDir, projection.workspaceId, projection.taskId);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(projection, null, 2)}\n`);
  await rename(tmp, file);
  await touchSchedulerSignal(dataDir);
}
