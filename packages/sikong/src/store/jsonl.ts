import type { Dirent } from "node:fs";
import { mkdir, appendFile, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { matchesChronicle } from "./memory";
import { withFileLock } from "./file-lock";
import { dataFileCandidates, isDataFile, parseDataFile, stringifyYaml, yamlFile } from "../config-file";
import {
  listProjectStateDirs,
  projectDefinitionRoot,
  projectMemoryPath,
  projectStateDir,
  workspaceStateDir,
} from "../workspace-layout";
import type { NewEvent, Task, TaskEvent } from "../workflow/types";
import { DEFAULT_PROJECT, type Project } from "../project";
import type { Worker } from "../worker";
import type {
  ChronicleEntry,
  ChronicleQuery,
  ChronicleStore,
  EventStore,
  ProjectionStore,
  ProjectStore,
  TaskQuery,
  WorkerStore,
} from "./types";

/**
 * Durable, file-backed stores so a separate process (the CLI) can read what the
 * engine wrote. Layout under `dir`:
 *   projects/<id>/project.yaml             — project definitions
 *   projects/<id>/memory.md                — optional project memory
 *   projects/<id>/state/events/<task>.jsonl — append-only event logs
 *   projects/<id>/state/projections/<task>.json — task projections
 *   workers/<id>.yaml                      — worker definitions
 *   state/chronicle.jsonl                  — append-only activity log
 *
 * CONTRACT: exactly ONE writer process per `dir` (the engine daemon); the CLI is
 * read-only. Appends are serialized + `seq` is derived from the max seen seq, so
 * a single writer is correct and crash-tolerant; two concurrent WRITERS over one
 * dir would still race `seq` (needs a dir lock — future hardening).
 */

/** Filenames are taskId-derived; ids are validated upstream (see assertValidTaskId). */
function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function readFirstDataFile<T>(root: string, basename: string): Promise<T | null> {
  for (const file of dataFileCandidates(root, basename)) {
    try {
      return parseDataFile<T>(await readFile(file, "utf8"), file);
    } catch (err) {
      if (isENOENT(err)) continue;
      throw err;
    }
  }
  return null;
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Parse a JSONL file tolerantly: a torn FINAL line (crash mid-append) is
 * dropped; a corrupt line anywhere else throws loudly. ENOENT ⇒ [].
 */
async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  const lines = text.split("\n");
  const out: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (err) {
      const isTornTail = lines.slice(i + 1).every((l) => l.length === 0);
      if (isTornTail) break; // crash left a partial last line — drop it
      throw new Error(`corrupt JSONL at ${file}:${i + 1}: ${(err as Error).message}`);
    }
  }
  return out;
}

function maxSeq(items: readonly { seq: number }[]): number {
  return items.reduce((m, it) => (it.seq > m ? it.seq : m), 0);
}

/** Serializes async writes through a single chain (correctness over throughput). */
class WriteQueue {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class JsonlEventStore implements EventStore {
  private readonly queue = new WriteQueue();

  constructor(
    private readonly dir: string,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private file(taskId: string): string {
    return join(this.dir, "events", `${sanitize(taskId)}.jsonl`);
  }

  append(taskId: string, events: readonly NewEvent[]): Promise<TaskEvent[]> {
    return this.queue.run(async () => {
      const file = this.file(taskId);
      return await withFileLock(file, async () => {
        const base = maxSeq(await readJsonl<TaskEvent>(file));
        const stamped: TaskEvent[] = events.map((e, i) => ({
          ...e,
          taskId,
          seq: base + i + 1,
          ts: this.clock(),
        }));
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, stamped.map((s) => JSON.stringify(s)).join("\n") + "\n");
        return stamped;
      });
    });
  }

  async load(taskId: string, fromSeq = 0): Promise<TaskEvent[]> {
    const events = await readJsonl<TaskEvent>(this.file(taskId));
    return fromSeq > 0 ? events.filter((e) => e.seq > fromSeq) : events;
  }
}

export class JsonProjectionStore implements ProjectionStore {
  private readonly queue = new WriteQueue();

  constructor(private readonly dir: string) {}

  private get root(): string {
    return join(this.dir, "projections");
  }
  private file(taskId: string): string {
    return join(this.root, `${sanitize(taskId)}.json`);
  }

  async get(taskId: string): Promise<Task | null> {
    try {
      return JSON.parse(await readFile(this.file(taskId), "utf8")) as Task;
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  put(task: Task): Promise<void> {
    return this.queue.run(async () => {
      await mkdir(this.root, { recursive: true });
      const file = this.file(task.id);
      await withFileLock(file, async () => {
        const tmp = `${file}.${process.pid}.tmp`;
        // Atomic: a concurrent reader sees the whole old or whole new file, never torn.
        await writeFile(tmp, JSON.stringify(task, null, 2));
        await rename(tmp, file);
      });
    });
  }

  async query(filter: TaskQuery = {}): Promise<Task[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (err) {
      if (isENOENT(err)) return [];
      throw err;
    }
    const status = filter.status
      ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
      : undefined;
    const tasks: Task[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue; // skips .tmp and non-task files
      try {
        tasks.push(JSON.parse(await readFile(join(this.root, name), "utf8")) as Task);
      } catch {
        // skip a torn/invalid file rather than failing the whole listing
      }
    }
    return tasks.filter(
      (t) =>
        (filter.projectId === undefined || t.projectId === filter.projectId) &&
        (filter.workflowId === undefined || t.workflowId === filter.workflowId) &&
        (filter.parentId === undefined || t.parentId === filter.parentId) &&
        (status === undefined || status.has(t.status)),
    );
  }
}

/** Durable `ProjectStore` (projects/<id>/project.yaml + memory.md, atomic writes). The builtin `default` is always available. */
export class JsonProjectStore implements ProjectStore {
  private readonly queue = new WriteQueue();
  static readonly MEMORY_LIMIT_CHARS = 12_000;

  constructor(private readonly dir: string) {}

  private get root(): string {
    return join(this.dir, "projects");
  }
  private definitionRoot(id: string): string {
    return projectDefinitionRoot(this.dir, sanitize(id));
  }
  private file(id: string): string {
    return yamlFile(this.definitionRoot(id), "project");
  }
  memoryPath(id: string): string {
    return projectMemoryPath(this.dir, sanitize(id));
  }
  private legacyMemoryPath(id: string): string {
    return join(this.root, `${sanitize(id)}.md`);
  }

  private async attachMemory(project: Project): Promise<Project> {
    try {
      const memory = await readFile(this.memoryPath(project.id), "utf8");
      return { ...project, memory: limitProjectMemory(memory) };
    } catch (err) {
      if (!isENOENT(err)) throw err;
    }
    try {
      const memory = await readFile(this.legacyMemoryPath(project.id), "utf8");
      return { ...project, memory: limitProjectMemory(memory) };
    } catch (err) {
      if (isENOENT(err)) return project;
      throw err;
    }
  }

  async get(id: string): Promise<Project | null> {
    const project =
      (await readFirstDataFile<Project>(this.definitionRoot(id), "project")) ??
      (await readFirstDataFile<Project>(this.root, sanitize(id))) ??
      (id === DEFAULT_PROJECT.id ? DEFAULT_PROJECT : null);
    return project ? await this.attachMemory(project) : null;
  }

  put(project: Project): Promise<void> {
    return this.queue.run(async () => {
      const file = this.file(project.id);
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      const { memory: _memory, ...definition } = project;
      await writeFile(tmp, stringifyYaml(definition));
      await rename(tmp, file);
    });
  }

  async getMemory(id: string): Promise<string> {
    try {
      return limitProjectMemory(await readFile(this.memoryPath(id), "utf8"));
    } catch (err) {
      if (!isENOENT(err)) throw err;
    }
    try {
      return limitProjectMemory(await readFile(this.legacyMemoryPath(id), "utf8"));
    } catch (err) {
      if (isENOENT(err)) return "";
      throw err;
    }
  }

  putMemory(id: string, memory: string): Promise<void> {
    return this.queue.run(async () => {
      const file = this.memoryPath(id);
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, memory);
      await rename(tmp, file);
    });
  }

  async list(): Promise<Project[]> {
    const out = new Map<string, Project>([[DEFAULT_PROJECT.id, DEFAULT_PROJECT]]);
    let entries: Dirent[];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (err) {
      if (isENOENT(err)) return [...out.values()];
      throw err;
    }
    for (const entry of entries) {
      try {
        if (entry.isDirectory()) {
          const p = await readFirstDataFile<Project>(join(this.root, entry.name), "project");
          if (p) out.set(p.id, await this.attachMemory(p));
        } else if (isDataFile(entry.name)) {
          const file = join(this.root, entry.name);
          const p = parseDataFile<Project>(await readFile(file, "utf8"), file);
          out.set(p.id, await this.attachMemory(p));
        }
      } catch {
        // skip a torn/invalid project file
      }
    }
    return await Promise.all([...out.values()].map((p) => this.attachMemory(p)));
  }
}

function limitProjectMemory(memory: string): string {
  if (memory.length <= JsonProjectStore.MEMORY_LIMIT_CHARS) return memory;
  return `${memory.slice(0, JsonProjectStore.MEMORY_LIMIT_CHARS)}\n\n[project memory truncated]`;
}

/** Durable `WorkerStore` (workers/<id>.yaml, atomic writes). No builtins. */
export class JsonWorkerStore implements WorkerStore {
  private readonly queue = new WriteQueue();
  constructor(private readonly dir: string) {}
  private get root(): string {
    return join(this.dir, "workers");
  }
  private file(id: string): string {
    return yamlFile(this.root, sanitize(id));
  }
  async get(id: string): Promise<Worker | null> {
    return await readFirstDataFile<Worker>(this.root, sanitize(id));
  }
  put(worker: Worker): Promise<void> {
    return this.queue.run(async () => {
      await mkdir(this.root, { recursive: true });
      const file = this.file(worker.id);
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, stringifyYaml(worker));
      await rename(tmp, file);
    });
  }
  async list(): Promise<Worker[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (err) {
      if (isENOENT(err)) return [];
      throw err;
    }
    const out = new Map<string, Worker>();
    for (const name of names) {
      if (!isDataFile(name)) continue;
      try {
        const file = join(this.root, name);
        const worker = parseDataFile<Worker>(await readFile(file, "utf8"), file);
        out.set(worker.id, worker);
      } catch {
        /* skip torn/invalid */
      }
    }
    return [...out.values()];
  }
}

export class JsonlChronicleStore implements ChronicleStore {
  private readonly queue = new WriteQueue();

  constructor(
    private readonly dir: string,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private get file(): string {
    return join(this.dir, "chronicle.jsonl");
  }

  append(entry: Omit<ChronicleEntry, "seq" | "ts">): Promise<ChronicleEntry> {
    return this.queue.run(async () => {
      return await withFileLock(this.file, async () => {
        const base = maxSeq(await readJsonl<ChronicleEntry>(this.file));
        const full: ChronicleEntry = { ...entry, seq: base + 1, ts: this.clock() };
        await mkdir(this.dir, { recursive: true });
        await appendFile(this.file, JSON.stringify(full) + "\n");
        return full;
      });
    });
  }

  async recent(query: ChronicleQuery = {}): Promise<ChronicleEntry[]> {
    const limit = query.limit ?? 50;
    const all = await readJsonl<ChronicleEntry>(this.file);
    return all
      .filter((e) => matchesChronicle(e, query))
      .sort((a, b) => b.seq - a.seq || b.ts - a.ts)
      .slice(0, limit);
  }
}

type TaskLocation = { stateDir: string; projectId?: string };

function projectIdFromCreated(events: readonly TaskEvent[] | readonly NewEvent[]): string | undefined {
  const created = events.find((e) => e.type === "task.created");
  const projectId = created?.payload.projectId;
  return typeof projectId === "string" ? projectId : undefined;
}

async function taskExistsInState(stateDir: string, taskId: string): Promise<TaskLocation | null> {
  const events = await new JsonlEventStore(stateDir).load(taskId);
  if (events.length === 0) return null;
  return { stateDir, projectId: projectIdFromCreated(events) };
}

/**
 * Workspace-level task event store that writes new task timelines under
 * projects/<projectId>/state while still reading legacy root-level timelines.
 */
export class JsonWorkspaceEventStore implements EventStore {
  private readonly stores = new Map<string, JsonlEventStore>();
  private readonly taskLocations = new Map<string, TaskLocation>();

  constructor(
    private readonly dir: string,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private store(stateDir: string): JsonlEventStore {
    let store = this.stores.get(stateDir);
    if (!store) {
      store = new JsonlEventStore(stateDir, this.clock);
      this.stores.set(stateDir, store);
    }
    return store;
  }

  private async locate(taskId: string): Promise<TaskLocation | null> {
    const cached = this.taskLocations.get(taskId);
    if (cached) return cached;

    for (const stateDir of await listProjectStateDirs(this.dir)) {
      const found = await taskExistsInState(stateDir, taskId);
      if (found) {
        this.taskLocations.set(taskId, found);
        return found;
      }
    }

    const legacy = await taskExistsInState(this.dir, taskId);
    if (legacy) {
      this.taskLocations.set(taskId, legacy);
      return legacy;
    }
    return null;
  }

  async append(taskId: string, events: readonly NewEvent[]): Promise<TaskEvent[]> {
    let location = await this.locate(taskId);
    if (!location) {
      const projectId = projectIdFromCreated(events);
      if (!projectId) throw new Error(`cannot route events for new task ${taskId}: missing task.created projectId`);
      location = { stateDir: projectStateDir(this.dir, projectId), projectId };
      this.taskLocations.set(taskId, location);
    }
    return this.store(location.stateDir).append(taskId, events);
  }

  async load(taskId: string, fromSeq = 0): Promise<TaskEvent[]> {
    const location = await this.locate(taskId);
    return location ? this.store(location.stateDir).load(taskId, fromSeq) : [];
  }
}

/** Projection store companion for JsonWorkspaceEventStore. */
export class JsonWorkspaceProjectionStore implements ProjectionStore {
  private readonly stores = new Map<string, JsonProjectionStore>();

  constructor(private readonly dir: string) {}

  private store(stateDir: string): JsonProjectionStore {
    let store = this.stores.get(stateDir);
    if (!store) {
      store = new JsonProjectionStore(stateDir);
      this.stores.set(stateDir, store);
    }
    return store;
  }

  async get(taskId: string): Promise<Task | null> {
    for (const stateDir of await listProjectStateDirs(this.dir)) {
      const task = await this.store(stateDir).get(taskId);
      if (task) return task;
    }
    return await this.store(this.dir).get(taskId);
  }

  async put(task: Task): Promise<void> {
    await this.store(projectStateDir(this.dir, task.projectId)).put(task);
  }

  async query(filter: TaskQuery = {}): Promise<Task[]> {
    const byId = new Map<string, Task>();
    for (const stateDir of await listProjectStateDirs(this.dir)) {
      for (const task of await this.store(stateDir).query(filter)) byId.set(task.id, task);
    }
    for (const task of await this.store(this.dir).query(filter)) {
      if (!byId.has(task.id)) byId.set(task.id, task);
    }
    return [...byId.values()];
  }
}

/** Workspace chronicle root for the global home layout; reads legacy root chronicles during migration. */
export class JsonWorkspaceChronicleStore implements ChronicleStore {
  private readonly current: JsonlChronicleStore;
  private readonly legacy: JsonlChronicleStore;

  constructor(dir: string, clock: () => number = () => Date.now()) {
    this.current = new JsonlChronicleStore(workspaceStateDir(dir), clock);
    this.legacy = new JsonlChronicleStore(dir, clock);
  }

  append(entry: Omit<ChronicleEntry, "seq" | "ts">): Promise<ChronicleEntry> {
    return this.current.append(entry);
  }

  async recent(query: ChronicleQuery = {}): Promise<ChronicleEntry[]> {
    const limit = query.limit ?? 50;
    const scan = { ...query, limit };
    const entries = [...(await this.current.recent(scan)), ...(await this.legacy.recent(scan))];
    return entries
      .filter((e) => matchesChronicle(e, query))
      .sort((a, b) => b.ts - a.ts || b.seq - a.seq)
      .slice(0, limit);
  }
}
