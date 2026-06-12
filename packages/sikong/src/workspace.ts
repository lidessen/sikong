import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  aiSdkLoop,
  anthropic,
  claudeCodeLoop,
  createEscalationOnToolUse,
  createProjectTools,
  deepseek,
  openai,
  type AgentLoop,
  type Hooks,
  type ModelProvider,
  type SandboxEscalationConfig,
  type ToolSet,
} from "agent-loop";
import { buildDesignTools } from "./tools";
import { WorkflowEngine, type EngineHooks, type LoopFactory, type WakeContext } from "./engine";
import { JsonSteerMailbox } from "./engine/steer-mailbox";
import { _DESIGN_WORKFLOW_V4, _DEVELOPMENT_LEAD_WORKFLOW_V1, DESIGN_WORKFLOW, DEVELOPMENT_LEAD_WORKFLOW, DEVELOPMENT_WORKFLOW, GENERAL_WORKFLOW, RELEASE_WORKFLOW, VISUAL_DESIGN_WORKFLOW } from "./workflow/builtin";
import { assertValidWorkflow } from "./workflow/validate";
import type { WorkflowDef } from "./workflow/types";
import { discoveredRoster, selectWorker, workerSandboxConfig, type Worker } from "./worker";
import { ensureWorktree, gcWorktrees, isGitRepo, releaseWorktree, retainedTaskIds } from "./worktree";
import {
  JsonProjectStore,
  JsonWorkspaceChronicleStore,
  JsonWorkspaceEventStore,
  JsonWorkspaceProjectionStore,
  JsonWorkerStore,
  MemoryWorkflowRegistry,
} from "./store";
import { dataFileCandidates, isDataFile, parseDataFile, stringifyYaml, yamlFile, type SandboxConfig } from "./config-file";
import type { Project } from "./project";

/**
 * Map a sikong worker permission mode to a claude-code SDK permission mode. The
 * sikong vocabulary is a superset: `auto` (auto-accept edits + auto-approve
 * allow-listed build/test bash via the ADR 0026 escalation hook) maps to the
 * SDK's `acceptEdits` base posture; `dontAsk` maps to `bypassPermissions`. The
 * bash auto-approval for `auto` is delivered by the onToolUse escalation hook,
 * not the SDK mode.
 */
function toClaudePermissionMode(
  mode: string | undefined,
): "default" | "acceptEdits" | "bypassPermissions" | "plan" | undefined {
  switch (mode) {
    case "auto":
      return "acceptEdits";
    case "dontAsk":
      return "bypassPermissions";
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
      return mode;
    default:
      return undefined;
  }
}

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
    ...(() => {
      const pm = toClaudePermissionMode(project?.permissionMode ?? worker.permissionMode);
      return pm ? { permissionMode: pm } : {};
    })(),
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
  const steerMailbox = new JsonSteerMailbox(dir);
  const projects = new JsonProjectStore(dir);
  const workers = new JsonWorkerStore(dir);

  const registry = new MemoryWorkflowRegistry(GENERAL_WORKFLOW);
  registry.register(VISUAL_DESIGN_WORKFLOW); // visual-design@v3, the UI/visual design workflow
  registry.register(_DESIGN_WORKFLOW_V4); // backward compat for design@v4 (pre-ADR 0031 technical design)
  registry.register(DESIGN_WORKFLOW); // design@v5, the generic technical blueprint workflow
  registry.register(DEVELOPMENT_WORKFLOW);
  registry.register(DEVELOPMENT_LEAD_WORKFLOW);
  registry.register(_DEVELOPMENT_LEAD_WORKFLOW_V1); // backward compat for development-lead@v1 (one transition release)
  registry.register(RELEASE_WORKFLOW);
  for (const wf of await loadWorkflows(dir)) registry.register(wf);
  for (const wf of opts.extraWorkflows ?? []) registry.register(wf);
  registry.register(DEVELOPMENT_WORKFLOW); // builtin development workflow wins over persisted definitions
  registry.register(DEVELOPMENT_LEAD_WORKFLOW); // builtin lead alias wins over persisted definitions
  registry.register(_DEVELOPMENT_LEAD_WORKFLOW_V1); // backward compat (stale-pin recovery)
  registry.register(VISUAL_DESIGN_WORKFLOW); // builtin visual-design@v3 wins over persisted definitions
  registry.register(_DESIGN_WORKFLOW_V4); // backward compat for design@v4 (stale-pin recovery; must be before v5)
  registry.register(DESIGN_WORKFLOW); // builtin design workflow (v5) wins over persisted definitions
  registry.register(GENERAL_WORKFLOW); // builtin fallback always wins over a persisted "general"

  // Sikong staffs each task itself (ADR 0008): the operator only provisions the
  // workforce (provider keys / an installed runtime); per-task hiring is internal.
  // The roster is the explicitly-created workers, or — when none exist — the
  // environment-discovered workers. selectWorker honours an explicit pin (task /
  // project / workspace default) and otherwise matches the workflow's `workerRole`.
  // Still creds-lazy: resolveWorkerLoop builds the provider only at wake time.
  const explicit = await workers.list();
  const roster = explicit.length ? explicit : await discoveredRoster();
  const defaultWorkerId = (await readConfig(dir)).defaultWorkerId;
  const selectArgs = (ctx: WakeContext) => ({
    ...(ctx.task.workerId ? { workerId: ctx.task.workerId } : {}),
    ...(ctx.project?.defaultWorker ? { projectDefault: ctx.project.defaultWorker } : {}),
    ...(defaultWorkerId ? { workspaceDefault: defaultWorkerId } : {}),
    ...(ctx.workflow.workerRole ? { workerRole: ctx.workflow.workerRole } : {}),
  });
  // "strong" tier escalates DeepSeek to its pro model — reserved for retries where
  // the fast model failed (per public evals, pro's edge is long-horizon/stuck work).
  // Other providers keep their default model.
  const escalateModel = (w: Worker, tier?: "fast" | "strong"): string =>
    tier === "strong" && w.provider === "deepseek" ? "deepseek-v4-pro" : w.model;
  const defaultLoop: LoopFactory = (ctx) => {
    const w = selectWorker(roster, selectArgs(ctx));
    return resolveWorkerLoop(
      { ...w, model: escalateModel(w, ctx.modelTier) },
      { ...(ctx.project ? { project: ctx.project } : {}) },
    );
  };
  const defaultIntakeLoop = () =>
    resolveWorkerLoop(selectWorker(roster, defaultWorkerId ? { workspaceDefault: defaultWorkerId } : {}));
  const loop: LoopFactory = opts.loop ?? defaultLoop;
  const intakeLoop = opts.intakeLoop ?? defaultIntakeLoop;

  // Resolve sandbox-escalation policy (ADR 0026) from the hired worker's
  // permission mode and the project's sandbox config — shared by the worker-tool
  // boundary (ai-sdk: host retry) and the worker-hook boundary (claude-code:
  // onToolUse auto-approve).
  const resolveSandboxConfig = (ctx: WakeContext): SandboxEscalationConfig | undefined => {
    try {
      return workerSandboxConfig(selectWorker(roster, selectArgs(ctx)), ctx.project?.sandbox);
    } catch {
      return workerSandboxConfig(undefined, ctx.project?.sandbox);
    }
  };

  const engine = new WorkflowEngine({
    events,
    projections,
    registry,
    chronicle,
    steerMailbox,
    projects,
    loop,
    // The worker boundary: a bare ai-sdk worker gets generic file/shell tools from
    // agent-loop (the agent's interior). A coding-agent runtime carries its own
    // interface, so it needs none. The engine never references coding tools.
    workerTools: async (ctx: WakeContext, workerLoop: AgentLoop): Promise<ToolSet> => {
      const tools: ToolSet = {};
      // ai-sdk bare worker gets generic file/shell project tools
      const proj = ctx.project;
      if (workerLoop.id === "ai-sdk" && proj?.root) {
        // ai-sdk workers use the agent-loop project bash, which escalates
        // sandbox-constrained build/test commands to the host (ADR 0026).
        const sandboxConfig = resolveSandboxConfig(ctx);
        Object.assign(tools, await createProjectTools({
          cwd: proj.root,
          ...(proj.env ? { env: proj.env } : {}),
          ...(sandboxConfig ? { sandboxEscalation: sandboxConfig } : {}),
        }));
      }
      // Visual design workflow injects preview + deliver tools (ADR 0022, reused from ADR 0017)
      if (ctx.workflow.id === "visual-design" && proj?.root) {
        Object.assign(tools, buildDesignTools({ projectRoot: proj.root }).tools);
      }
      return tools;
    },
    // The worker-hook boundary: a claude-code worker carries its own native bash
    // (gated by its permission mode). Apply sandbox-escalation policy (ADR 0026)
    // via onToolUse so allow-listed build/test commands are auto-approved and the
    // worker can self-verify (`swift build`, `go test`, `bun run test`) even in
    // acceptEdits. ai-sdk gets the equivalent at the tool level (workerTools).
    workerHooks: (ctx: WakeContext, workerLoop: AgentLoop): Hooks | undefined => {
      if (workerLoop.id !== "claude-code") return undefined;
      const sandboxConfig = resolveSandboxConfig(ctx);
      if (!sandboxConfig) return undefined;
      return { onToolUse: createEscalationOnToolUse(sandboxConfig) };
    },
    // Record which worker a wake hires (model/provider) so the usage report can
    // cost it. Same selection as defaultLoop. billingMode is "token" — discovered
    // workers authenticate by API key; OAuth/subscription detection is deferred.
    describeWorker: (ctx: WakeContext) => {
      try {
        const w = selectWorker(roster, selectArgs(ctx));
        return { model: escalateModel(w, ctx.modelTier), provider: w.provider, billingMode: "token" as const };
      } catch {
        return undefined;
      }
    },
    // Isolation (ADR 0010) lives entirely here, off git only. The engine forwards
    // `isolate` tasks opaquely; we give them their own git worktree and reclaim it
    // on terminal. Non-git projects are a no-op (the task just shares the root).
    isolateWorkspace: async (ctx, project) => {
      if (!project.root || !(await isGitRepo(project.root))) return project;
      const wt = await ensureWorktree(dir, project.root, ctx.task.id);
      return { ...project, root: wt };
    },
    releaseWorkspace: async (task, project) => {
      if (!project.root || !(await isGitRepo(project.root))) return;
      await releaseWorktree(dir, project.root, task.id, task.status);
    },
    intakeLoop,
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    // Default depth cap of 2 (lead + workers) bounds all fan-out, including
    // design, release, and user-registered workflows without explicit maxTeamDepth.
    maxTeamDepth: 2,
    ...(opts.wakeTimeoutMs !== undefined ? { wakeTimeoutMs: opts.wakeTimeoutMs } : {}),
  });
  return { engine, events, projections, chronicle, registry, projects, workers };
}

/**
 * Reclaim leftover isolation worktrees/branches (ADR 0010) — a safety net beyond
 * the per-task release on terminal, for runs that crashed mid-wake. Removes any
 * worktree whose task is no longer live and deletes merged `sikong/*` branches.
 * Cheap; the CLI calls it after `run` settles.
 */
export async function reconcileWorktrees(ws: Workspace, dir: string): Promise<void> {
  const tasks = await ws.projections.query();
  const retain = retainedTaskIds(tasks);
  const roots = [
    ...new Set((await ws.projects.list()).map((p) => p.root).filter((r): r is string => !!r && r !== ".")),
  ];
  await gcWorktrees(dir, roots, retain);
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
      console.warn(`sikong: skipping invalid workflow file "${name}": ${(err as Error).message}`);
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
