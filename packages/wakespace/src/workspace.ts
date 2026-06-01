import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  aiSdkLoop,
  anthropic,
  claudeCodeLoop,
  deepseek,
  openai,
  type AgentLoop,
  type ModelProvider,
} from "agent-loop";
import { WorkflowEngine, type EngineHooks, type LoopFactory, type WakeContext } from "./engine";
import { DEVELOPMENT_WORKFLOW, GENERAL_WORKFLOW } from "./workflow/builtin";
import { assertValidWorkflow } from "./workflow/validate";
import type { WorkflowDef } from "./workflow/types";
import type { Worker } from "./worker";
import {
  JsonProjectStore,
  JsonWorkspaceChronicleStore,
  JsonWorkspaceEventStore,
  JsonWorkspaceProjectionStore,
  JsonWorkerStore,
  MemoryWorkflowRegistry,
} from "./store";
import { dataFileCandidates, isDataFile, parseDataFile, stringifyYaml, yamlFile } from "./config-file";
import type { Project } from "./project";

/** Build the AgentLoop a worker describes (provider key auto-discovered at this point). */
export function resolveWorkerLoop(worker: Worker, opts: { project?: Project } = {}): AgentLoop {
  const provider: ModelProvider =
    worker.provider === "deepseek"
      ? deepseek({ model: worker.model })
      : worker.provider === "anthropic"
        ? anthropic({ model: worker.model })
        : openai({ model: worker.model });
  if (worker.runtime === "ai-sdk") return aiSdkLoop({ provider });
  const project = opts.project;
  return claudeCodeLoop({
    provider,
    ...(project?.root ? { cwd: project.root, allowedPaths: [project.root] } : {}),
    ...(project?.env ? { env: project.env } : {}),
    ...(project?.permissionMode ?? worker.permissionMode
      ? { permissionMode: project?.permissionMode ?? worker.permissionMode }
      : {}),
  });
}

interface WorkspaceConfig {
  defaultWorkerId?: string;
}

async function readConfig(dir: string): Promise<WorkspaceConfig> {
  for (const file of dataFileCandidates(dir, "config")) {
    try {
      return parseDataFile(await readFile(file, "utf8"), file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw err;
    }
  }
  return {};
}

/** Set the workspace-wide default worker (the global "hire X by default" preference). */
export async function setDefaultWorker(dir: string, workerId: string): Promise<void> {
  const cfg = await readConfig(dir);
  cfg.defaultWorkerId = workerId;
  await mkdir(dir, { recursive: true });
  await writeFile(yamlFile(dir, "config"), stringifyYaml(cfg));
}

export async function getDefaultWorker(dir: string): Promise<string | undefined> {
  return (await readConfig(dir)).defaultWorkerId;
}

export interface OpenWorkspaceOptions {
  /** Worker loop factory. Default: deepseek-v4-flash over ai-sdk. Inject mocks in tests. */
  loop?: LoopFactory;
  /** Intake-router loop factory. Default: resolves the workspace default worker. */
  intakeLoop?: () => AgentLoop;
  /** Extra workflows to register beyond GENERAL + those persisted under the dir. */
  extraWorkflows?: readonly WorkflowDef[];
  /** Engine hooks (e.g. the CLI collects wake errors here to set its exit code). */
  hooks?: EngineHooks;
  wakeTimeoutMs?: number;
}

export interface Workspace {
  engine: WorkflowEngine;
  events: JsonWorkspaceEventStore;
  projections: JsonWorkspaceProjectionStore;
  chronicle: JsonWorkspaceChronicleStore;
  registry: MemoryWorkflowRegistry;
  projects: JsonProjectStore;
  workers: JsonWorkerStore;
}

/**
 * Open a durable workspace at `dir`: JSONL event stores, YAML definition stores + a registry seeded with
 * GENERAL, any workflows persisted under `dir/workflows/`, and `extraWorkflows`,
 * plus an engine wired to DeepSeek worker + intake loops by default. This is the
 * shared wiring used by the CLI (and tests, via injected mock loops). The default
 * loops are lazy — they only reach the network when a wake actually runs, so
 * read/`submit`/`register` paths need no credentials.
 */
export async function openWorkspace(dir: string, opts: OpenWorkspaceOptions = {}): Promise<Workspace> {
  const events = new JsonWorkspaceEventStore(dir);
  const projections = new JsonWorkspaceProjectionStore(dir);
  const chronicle = new JsonWorkspaceChronicleStore(dir);
  const projects = new JsonProjectStore(dir);
  const workers = new JsonWorkerStore(dir);

  const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
  registry.register(DEVELOPMENT_WORKFLOW);
  for (const wf of await loadWorkflows(dir)) registry.register(wf);
  for (const wf of opts.extraWorkflows ?? []) registry.register(wf);
  registry.register(DEVELOPMENT_WORKFLOW); // builtin development workflow wins over persisted definitions
  registry.register(GENERAL_WORKFLOW); // builtin fallback always wins over a persisted "general"

  // Resolve the hired worker per wake: task override → project default → workspace
  // default. Still creds-lazy: resolveWorkerLoop builds the provider (and resolves
  // its key) only when invoked at wake time, so read/submit/register need no creds.
  const roster = new Map((await workers.list()).map((w) => [w.id, w] as const));
  const defaultWorkerId = (await readConfig(dir)).defaultWorkerId;
  const hire = (workerId: string | undefined, taskId: string): Worker => {
    const id = workerId ?? defaultWorkerId;
    if (!id)
      throw new Error(
        `no worker hired for task ${taskId}: run \`worker discover\`, \`worker create …\`, then \`worker default <id>\` (or pass --worker)`,
      );
    const w = roster.get(id);
    if (!w) throw new Error(`worker "${id}" is not in the roster (create it with \`worker create\`)`);
    return w;
  };
  const defaultLoop: LoopFactory = (ctx) =>
    resolveWorkerLoop(hire(ctx.task.workerId ?? ctx.project?.defaultWorker, ctx.task.id), {
      ...(ctx.project ? { project: ctx.project } : {}),
    });
  const defaultIntakeLoop = () => resolveWorkerLoop(hire(undefined, "intake"));
  const loop: LoopFactory = opts.loop ?? defaultLoop;
  const intakeLoop = opts.intakeLoop ?? defaultIntakeLoop;

  const engine = new WorkflowEngine({
    events,
    projections,
    registry,
    chronicle,
    projects,
    loop,
    intakeLoop,
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    wakeTimeoutMs: opts.wakeTimeoutMs ?? 90_000,
  });
  return { engine, events, projections, chronicle, registry, projects, workers };
}

/** Load valid workflow defs persisted under `dir/workflows/*.{yaml,yml,json}` (skips invalid). */
export async function loadWorkflows(dir: string): Promise<WorkflowDef[]> {
  const root = join(dir, "workflows");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const out: WorkflowDef[] = [];
  for (const name of names) {
    if (!isDataFile(name)) continue;
    try {
      const file = join(root, name);
      const def = parseDataFile<WorkflowDef>(await readFile(file, "utf8"), file);
      assertValidWorkflow(def);
      out.push(def);
    } catch (err) {
      // don't let one bad file break startup, but make it observable
      console.warn(`wakespace: skipping invalid workflow file "${name}": ${(err as Error).message}`);
    }
  }
  return out;
}

/** Validate + persist a workflow def under `dir/workflows/` (an agent registering a workflow). */
export async function saveWorkflow(dir: string, def: WorkflowDef): Promise<void> {
  assertValidWorkflow(def);
  const root = join(dir, "workflows");
  await mkdir(root, { recursive: true });
  await writeFile(yamlFile(root, `${def.id}@${def.version}`), stringifyYaml(def));
}

export interface WorkspaceLock {
  path: string;
  release: () => Promise<void>;
}

const LOCK_STALE_MS = 5 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Acquire an exclusive write lock on the workspace dir, so two concurrent writers
 * can't violate the one-writer-per-dir contract (which would corrupt the event
 * log's seq). Throws if a live writer holds it; reclaims a stale lock (dead pid or
 * older than 5 min). Reads don't lock.
 */
export async function acquireLock(dir: string): Promise<WorkspaceLock> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, "wx"); // exclusive create
      await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
      await fh.close();
      return {
        path,
        release: async () => {
          try {
            await rm(path, { force: true });
          } catch {
            /* ignore */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: { pid: number; ts: number } | null = null;
      try {
        holder = JSON.parse(await readFile(path, "utf8"));
      } catch {
        /* unreadable lock */
      }
      const stale = !holder || Date.now() - holder.ts > LOCK_STALE_MS || !pidAlive(holder.pid);
      if (stale && attempt === 0) {
        await rm(path, { force: true });
        continue;
      }
      throw new Error(
        `workspace "${dir}" is busy (write-locked${holder ? ` by pid ${holder.pid}` : ""}); retry after the other command finishes`,
      );
    }
  }
  throw new Error(`workspace "${dir}": could not acquire write lock`);
}
