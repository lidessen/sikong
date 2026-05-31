import { mkdir, appendFile, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { matchesChronicle } from "./memory";
import { dataFileCandidates, isDataFile, parseDataFile, stringifyYaml, yamlFile } from "../config-file";
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
 *   events/<taskId>.jsonl      — append-only event log (system of record)
 *   projections/<taskId>.json  — current task projection (read side, written atomically)
 *   projects/<id>.yaml         — project definitions
 *   workers/<id>.yaml          — worker definitions
 *   chronicle.jsonl            — append-only activity log
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
  private readonly seqCache = new Map<string, number>();

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
      let base = this.seqCache.get(file);
      if (base === undefined) base = maxSeq(await readJsonl<TaskEvent>(file));
      const stamped: TaskEvent[] = events.map((e, i) => ({
        ...e,
        taskId,
        seq: base + i + 1,
        ts: this.clock(),
      }));
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, stamped.map((s) => JSON.stringify(s)).join("\n") + "\n");
      this.seqCache.set(file, base + events.length);
      return stamped;
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
      const tmp = `${file}.${process.pid}.tmp`;
      // Atomic: a concurrent reader sees the whole old or whole new file, never torn.
      await writeFile(tmp, JSON.stringify(task, null, 2));
      await rename(tmp, file);
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

/** Durable `ProjectStore` (projects/<id>.yaml, atomic writes). The builtin `default` is always available. */
export class JsonProjectStore implements ProjectStore {
  private readonly queue = new WriteQueue();

  constructor(private readonly dir: string) {}

  private get root(): string {
    return join(this.dir, "projects");
  }
  private file(id: string): string {
    return yamlFile(this.root, sanitize(id));
  }

  async get(id: string): Promise<Project | null> {
    return (await readFirstDataFile<Project>(this.root, sanitize(id))) ?? (id === DEFAULT_PROJECT.id ? DEFAULT_PROJECT : null);
  }

  put(project: Project): Promise<void> {
    return this.queue.run(async () => {
      await mkdir(this.root, { recursive: true });
      const file = this.file(project.id);
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, stringifyYaml(project));
      await rename(tmp, file);
    });
  }

  async list(): Promise<Project[]> {
    const out = new Map<string, Project>([[DEFAULT_PROJECT.id, DEFAULT_PROJECT]]);
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (err) {
      if (isENOENT(err)) return [...out.values()];
      throw err;
    }
    for (const name of names) {
      if (!isDataFile(name)) continue;
      try {
        const file = join(this.root, name);
        const p = parseDataFile<Project>(await readFile(file, "utf8"), file);
        out.set(p.id, p);
      } catch {
        // skip a torn/invalid project file
      }
    }
    return [...out.values()];
  }
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
  private seqCache: number | undefined;

  constructor(
    private readonly dir: string,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private get file(): string {
    return join(this.dir, "chronicle.jsonl");
  }

  append(entry: Omit<ChronicleEntry, "seq" | "ts">): Promise<ChronicleEntry> {
    return this.queue.run(async () => {
      if (this.seqCache === undefined) this.seqCache = maxSeq(await readJsonl<ChronicleEntry>(this.file));
      const full: ChronicleEntry = { ...entry, seq: this.seqCache + 1, ts: this.clock() };
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.file, JSON.stringify(full) + "\n");
      this.seqCache = full.seq;
      return full;
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
