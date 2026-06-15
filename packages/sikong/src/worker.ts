import { access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SandboxEscalationConfig } from "agent-loop";
import type { SandboxConfig } from "./config-file";
import type { Project } from "./project";

/**
 * A Worker is a hireable, described agent configuration — the "who/which model"
 * a task is assigned to. It's registerable DATA (like workflows/projects), so the
 * orchestrating agent can list the roster, read each one's description, and hire
 * per task. There are NO builtin workers: the environment varies, so an agent
 * runs `worker discover` (which inspects available providers/runtimes) and
 * creates the workers it wants. A worker carries no secrets — provider keys are
 * auto-discovered from the environment at wake time.
 */

/** Tools-capable runtimes only — a worker must support command tools. */
export type WorkerRuntime = "ai-sdk" | "claude-code";
/** Runtime ids that discovery can report, including runtimes not usable for sikong command-tool workers yet. */
export type DiscoveredRuntime = WorkerRuntime | "codex" | "cursor";
/** Built-in providers we can resolve a loop for. */
export type WorkerProvider = "deepseek" | "anthropic" | "openai";
/** Runtime permission posture. Currently applied by claude-code workers. */
export type WorkerPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

/**
 * Unified worker sandbox configuration — replaces three separate sandbox paths
 * (claude-code permission mode, ai-sdk sandbox escalation, git worktree isolation)
 * with one cohesive type. Each dimension is optional; the engine applies what it
 * can based on the worker's runtime.
 */
export interface WorkerSandbox {
  /**
   * Runtime permission posture. Applied by claude-code workers as the native
   * SDK permission mode; other runtimes map it to their closest equivalent.
   */
  permissionMode?: WorkerPermissionMode;
  /**
   * Sandbox escalation config (ADR 0026). Controls bash tool auto-approval for
   * build/test commands on sandbox-constrained runtimes. Applied by ai-sdk via
   * `createProjectTools` and by claude-code via `createEscalationOnToolUse`.
   */
  escalation?: SandboxConfig;
  /**
   * When true, the task runs in its own isolated workspace (e.g. a git worktree).
   * The engine forwards this to isolateWorkspace/releaseWorkspace at the worker
   * boundary.
   */
  isolate?: boolean;
}

export type { SandboxConfig };

export interface Worker {
  id: string;
  name: string;
  /** What this worker is good at — the orchestrating agent reads this to hire. */
  description: string;
  runtime: WorkerRuntime;
  provider: WorkerProvider;
  model: string;
  /** Per-runtime sandbox posture. Supersedes the older permMode+escalation split. */
  sandbox?: WorkerSandbox;
  /** @deprecated Use sandbox.permissionMode instead. */
  permissionMode?: WorkerPermissionMode;
  /**
   * Capability tags used by sikong to staff a task (e.g. "coding", "general").
   * Staffing metadata only — matched generically against a workflow's `workerRole`;
   * it never tells a worker HOW to work. Unset ⇒ inferred from the runtime.
   */
  roles?: readonly string[];
  // skills?/mcp? — a worker's "specialty" — deferred until skill injection lands.
}

export function isValidWorkerId(id: string): boolean {
  return !!id && id !== "." && id !== ".." && /^[A-Za-z0-9._-]+$/.test(id);
}

// ---- staffing: capability roles + assignment policy (ADR 0008) -------------

/**
 * Default capability tags for a runtime when a worker declares none. A
 * `claude-code` worker carries its own coding interface, so it is coding-capable;
 * a bare `ai-sdk` worker is general-purpose. This is staffing metadata, not
 * coding logic — the engine never reads it.
 */
export function defaultRolesForRuntime(runtime: WorkerRuntime): readonly string[] {
  return runtime === "claude-code" ? ["coding", "general"] : ["general"];
}

export function workerHasRole(worker: Worker, role: string): boolean {
  return (worker.roles ?? defaultRolesForRuntime(worker.runtime)).includes(role);
}

// ── Sandbox escalation → worker permission mode (ADR 0026) ────────────────────

/**
 * Resolve a unified `SandboxEscalationConfig` from a worker's sandbox posture
 * and an optional project-level sandbox config. The resolution order:
 *   1. worker.sandbox.escalation (explicit sandbox escalation on the worker)
 *   2. worker.sandbox.permissionMode → "auto" or "bypassPermissions" enable escalation
 *   3. worker.permissionMode (deprecated flat field, same logic)
 *   4. Project config provides list allow/deny/exclude overrides.
 *
 * Returns undefined when escalation is not enabled (strict mode).
 */
export function workerSandboxConfig(
  worker?: { sandbox?: { permissionMode?: string; escalation?: SandboxConfig }; permissionMode?: string },
  projectConfig?: SandboxConfig,
): SandboxEscalationConfig | undefined {
  // Unified sandbox field takes priority; fall back to deprecated flat field.
  const mode = worker?.sandbox?.permissionMode ?? worker?.permissionMode;
  const escalation = worker?.sandbox?.escalation;

  // Only auto and bypassPermissions modes enable sandbox escalation.
  if (mode !== "auto" && mode !== "bypassPermissions" && mode !== undefined) {
    return undefined;
  }

  // Worker-level escalation config, if present, is the primary source.
  if (escalation) {
    const base: SandboxEscalationConfig = {
      allowUnsandboxedCommands: escalation.allowUnsandboxedCommands ?? projectConfig?.allowUnsandboxedCommands ?? true,
    };
    if (escalation.allowList?.length) base.allowList = escalation.allowList;
    else if (projectConfig?.allowList?.length) base.allowList = projectConfig.allowList;
    if (escalation.denyList?.length) base.denyList = escalation.denyList;
    else if (projectConfig?.denyList?.length) base.denyList = projectConfig.denyList;
    if (escalation.excludedCommands?.length) base.excludedCommands = escalation.excludedCommands;
    else if (projectConfig?.excludedCommands?.length) base.excludedCommands = projectConfig.excludedCommands;
    return base;
  }

  // Default: baseline escalation with optional overrides from persisted config.
  const base: SandboxEscalationConfig = {
    allowUnsandboxedCommands: projectConfig?.allowUnsandboxedCommands ?? true,
  };

  if (projectConfig?.allowList?.length) base.allowList = projectConfig.allowList;
  if (projectConfig?.denyList?.length) base.denyList = projectConfig.denyList;
  if (projectConfig?.excludedCommands?.length) base.excludedCommands = projectConfig.excludedCommands;

  // Undefined mode (default) but we got here because the worker was explicitly
  // created — enable escalation.
  if (mode === undefined) {
    base.allowUnsandboxedCommands = true;
  }

  return base;
}

/** Provider default models used for auto-discovered workers (operators override via `worker create`). */
const DISCOVERY_MODEL: Record<WorkerProvider, string> = {
  deepseek: "deepseek-v4-flash",
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.1",
};

/**
 * Build sikong's roster from the environment (the operator only sets provider
 * keys / installs a runtime). One worker per usable runtime × configured provider,
 * ordered coding-capable first so coding tasks staff to a coding agent when present.
 */
export async function discoveredRoster(): Promise<Worker[]> {
  const d = await discoverWorkers();
  const configured = new Set(d.providers);
  const out: Worker[] = [];
  for (const c of d.compatibility) {
    for (const provider of c.providers) {
      if (!configured.has(provider)) continue;
      out.push({
        id: `${c.runtime}-${provider}`,
        name: `${c.runtime} · ${provider}`,
        description: `auto-discovered ${c.runtime} worker on ${provider}`,
        runtime: c.runtime,
        provider,
        model: DISCOVERY_MODEL[provider],
        roles: defaultRolesForRuntime(c.runtime),
        // A claude-code worker runs headless and cannot answer permission prompts,
        // yet an autonomous dev worker must both edit files AND run project checks
        // (typecheck/tests/build) during verify. So default discovered claude-code
        // workers to bypassPermissions. File tools are still jailed to the project
        // root (cwd + allowedPaths); pair this with the create-time guardrail below
        // so a write-class workflow isn't pointed at the wrong directory. Run teams
        // against a project you're willing to let an agent modify.
        sandbox: c.runtime === "claude-code"
          ? { permissionMode: "bypassPermissions" as const }
          : undefined,
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Worker pool — reuse AgentLoop instances across consecutive wakes           */
/* -------------------------------------------------------------------------- */

import type { AgentLoop } from "agent-loop";

/**
 * A pooled entry wrapping a cached `AgentLoop`. Returned to the pool on
 * `release()`, or discarded on `discard()`.
 */
export interface PooledLoop {
  loop: AgentLoop;
  /** Return the loop to the pool for reuse. */
  release: () => void;
  /** Discard this loop (close its resources, don't reuse). */
  discard: () => void;
}

export interface WorkerPoolOptions {
  /** Max idle loops per (workerId, projectId) key. Default 1. */
  maxIdlePerKey?: number;
  /** Idle timeout ms — a loop unused this long is disposed. Default 5 min. */
  idleTimeoutMs?: number;
  /** Optional periodic cleanup interval. Default 60s. */
  cleanupIntervalMs?: number;
}

const DEFAULT_POOL_OPTIONS: Required<WorkerPoolOptions> = {
  maxIdlePerKey: 1,
  idleTimeoutMs: 300_000,
  cleanupIntervalMs: 60_000,
};

interface PoolEntry {
  loop: AgentLoop;
  key: string;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * A pool of reusable `AgentLoop` instances. Because adapter construction
 * (especially claude-code subprocess) is expensive, the pool keeps warm loops
 * for reuse across consecutive wakes by the same worker+project combination.
 *
 * Thread-safety: single-writer (the engine's wake loop is Promise-concurrent,
 * not thread-concurrent), so no mutex is needed.
 */
export class WorkerPool {
  private readonly idle = new Map<string, PoolEntry[]>();
  private readonly all = new Map<string, PoolEntry>();
  private readonly opts: Required<WorkerPoolOptions>;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly loopFactory: (worker: Worker, project?: Project) => AgentLoop,
    opts?: WorkerPoolOptions,
  ) {
    this.opts = { ...DEFAULT_POOL_OPTIONS, ...opts };
    this.startCleanup();
  }

  /**
   * Acquire a loop for `worker` + `project`. Returns a cached idle loop when
   * available, or creates a fresh one via the factory.
   */
  async acquire(worker: Worker, project?: Project): Promise<PooledLoop> {
    const key = `${worker.id}::${project?.root ?? "."}`;
    // Reuse an idle loop if one exists
    const pool = this.idle.get(key);
    if (pool && pool.length > 0) {
      const entry = pool.pop()!;
      if (pool.length === 0) this.idle.delete(key);
      entry.lastUsed = Date.now();
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      return this.wrapEntry(entry);
    }
    // Create a fresh loop
    const loop = this.loopFactory(worker, project);
    const entry: PoolEntry = { loop, key, lastUsed: Date.now(), timer: null };
    this.all.set(`${key}::${loop.id}`, entry);
    return this.wrapEntry(entry);
  }

  /** Dispose all idle loops. Call before engine shutdown. */
  async dispose(): Promise<void> {
    this.stopCleanup();
    for (const [, pool] of this.idle) {
      for (const entry of pool) {
        this.all.delete(`${entry.key}::${entry.loop.id}`);
        await entry.loop.dispose().catch(() => {});
      }
    }
    this.idle.clear();
    // Also dispose any acquired (non-idle) loops — best effort.
    for (const [, entry] of this.all) {
      await entry.loop.dispose().catch(() => {});
    }
    this.all.clear();
  }

  private wrapEntry(entry: PoolEntry): PooledLoop {
    return {
      loop: entry.loop,
      release: () => {
        if (this.all.has(`${entry.key}::${entry.loop.id}`)) {
          this.returnToPool(entry);
        }
      },
      discard: () => {
        this.all.delete(`${entry.key}::${entry.loop.id}`);
        entry.loop.dispose().catch(() => {});
      },
    };
  }

  private returnToPool(entry: PoolEntry): void {
    entry.lastUsed = Date.now();
    const pool = this.idle.get(entry.key) ?? [];
    if (pool.length >= this.opts.maxIdlePerKey) {
      // Pool is full for this key — discard the oldest or the current one.
      const oldest = pool.shift();
      if (oldest) {
        this.all.delete(`${oldest.key}::${oldest.loop.id}`);
        oldest.loop.dispose().catch(() => {});
      }
    }
    pool.push(entry);
    this.idle.set(entry.key, pool);
    // Schedule disposal if this entry goes unused
    entry.timer = setTimeout(() => {
      const idx = this.idle.get(entry.key)?.indexOf(entry) ?? -1;
      if (idx >= 0) {
        this.idle.get(entry.key)!.splice(idx, 1);
        if (this.idle.get(entry.key)!.length === 0) this.idle.delete(entry.key);
      }
      this.all.delete(`${entry.key}::${entry.loop.id}`);
      entry.loop.dispose().catch(() => {});
    }, this.opts.idleTimeoutMs);
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, pool] of this.idle) {
        const alive = pool.filter((entry) => {
          const age = now - entry.lastUsed;
          if (age < this.opts.idleTimeoutMs) return true;
          this.all.delete(`${entry.key}::${entry.loop.id}`);
          entry.loop.dispose().catch(() => {});
          return false;
        });
        if (alive.length > 0) this.idle.set(key, alive);
        else this.idle.delete(key);
      }
    }, this.opts.cleanupIntervalMs);
  }

  private stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Worker health tracking — per-worker circuit breaker                        */
/* -------------------------------------------------------------------------- */

export interface WorkerHealthConfig {
  maxConsecutiveFailures?: number;
  errorRateThreshold?: number;
  errorRateWindow?: number;
  cooldownMs?: number;
}

interface HealthRecord {
  workerId: string;
  consecutiveFailures: number;
  recentResults: boolean[];
  degradedUntil: number;
}

const DEFAULT_HEALTH_CONFIG: Required<WorkerHealthConfig> = {
  maxConsecutiveFailures: 2,
  errorRateThreshold: 0.5,
  errorRateWindow: 5,
  cooldownMs: 120_000,
};

export class WorkerHealth {
  private readonly records = new Map<string, HealthRecord>();
  private readonly config: Required<WorkerHealthConfig>;

  constructor(config?: WorkerHealthConfig) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
  }

  recordSuccess(id: string): void {
    const r = this.getOrCreate(id);
    r.consecutiveFailures = 0;
    r.recentResults.push(true);
    if (r.recentResults.length > this.config.errorRateWindow) r.recentResults.shift();
    if (r.degradedUntil > 0 && Date.now() >= r.degradedUntil) r.degradedUntil = 0;
  }

  recordFailure(id: string): void {
    const r = this.getOrCreate(id);
    r.consecutiveFailures++;
    r.recentResults.push(false);
    if (r.recentResults.length > this.config.errorRateWindow) r.recentResults.shift();
    if (r.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      r.degradedUntil = Date.now() + this.config.cooldownMs;
      return;
    }
    const failures = r.recentResults.filter((x) => !x).length;
    const rate = failures / r.recentResults.length;
    if (rate >= this.config.errorRateThreshold) {
      r.degradedUntil = Date.now() + this.config.cooldownMs;
    }
  }

  isHealthy(id: string): boolean {
    const r = this.records.get(id);
    if (!r) return true;
    if (r.degradedUntil === 0) return true;
    if (Date.now() >= r.degradedUntil) {
      r.degradedUntil = 0;
      return true;
    }
    return false;
  }

  getRecord(id: string): Readonly<HealthRecord> | undefined {
    return this.records.get(id);
  }

  private getOrCreate(id: string): HealthRecord {
    let r = this.records.get(id);
    if (!r) {
      r = { workerId: id, consecutiveFailures: 0, recentResults: [], degradedUntil: 0 };
      this.records.set(id, r);
    }
    return r;
  }
}

/**
 * project default, or workspace default) always wins; otherwise prefer a worker
 * whose roles include the workflow's `workerRole`, falling back to any available
 * worker. Deterministic over roster order. Throws when no worker can be hired.
 */
export function selectWorker(
  roster: readonly Worker[],
  req: { workerId?: string; projectDefault?: string; workspaceDefault?: string; workerRole?: string } = {},
  health?: { isHealthy(id: string): boolean },
): Worker {
  const pinnedId = req.workerId ?? req.projectDefault ?? req.workspaceDefault;
  if (pinnedId) {
    const w = roster.find((x) => x.id === pinnedId);
    if (!w)
      throw new Error(
        `worker "${pinnedId}" is not in the roster (create it with \`worker create\`, or drop the pin to auto-assign)`,
      );
    return w;
  }
  if (roster.length === 0)
    throw new Error(
      "no worker available to hire: set a provider key (e.g. DEEPSEEK_API_KEY or ANTHROPIC_API_KEY) and/or install `claude`, then retry (or `worker create` an explicit one)",
    );
  // Filter out degraded workers (skip unhealthy unless pinned)
  const healthy = health ? roster.filter((w) => health.isHealthy(w.id)) : roster;
  if (healthy.length === 0) {
    // All workers degraded — fall back to roster; the wake will likely fail,
    // but the operator can intervene via the chronicle.
    const matched = req.workerRole ? roster.filter((w) => workerHasRole(w, req.workerRole!)) : [];
    return (matched[0] ?? roster[0])!;
  }
  const matched = req.workerRole ? healthy.filter((w) => workerHasRole(w, req.workerRole!)) : [];
  return (matched[0] ?? healthy[0])!;
}

// ---- discovery: inspect the environment + suggest workers -----------------

export interface RuntimeDiscovery {
  id: DiscoveredRuntime;
  usableAsWorker: boolean;
  reason?: string;
}

export interface ProviderDiscovery {
  id: WorkerProvider;
  configured: boolean;
  env: readonly string[];
  aiSdkAvailable: boolean;
}

export interface RuntimeCompatibility {
  runtime: WorkerRuntime;
  providers: readonly WorkerProvider[];
}

export interface Discovery {
  providers: WorkerProvider[];
  providerDetails: ProviderDiscovery[];
  runtimes: DiscoveredRuntime[];
  runtimeDetails: RuntimeDiscovery[];
  compatibility: RuntimeCompatibility[];
}

const PROVIDER_ENV: Record<WorkerProvider, readonly string[]> = {
  deepseek: ["DEEPSEEK_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
};
// runtime ⊥ provider compatibility (claude-code is Anthropic-wire; not OpenAI).
const COMPATIBLE: Record<WorkerRuntime, readonly WorkerProvider[]> = {
  "ai-sdk": ["deepseek", "anthropic", "openai"],
  "claude-code": ["deepseek", "anthropic"],
};

async function onPath(binary: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      await access(join(dir, binary), constants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

async function hasPackage(pkg: string): Promise<boolean> {
  let dir = process.cwd();
  for (;;) {
    try {
      await access(join(dir, "node_modules", pkg, "package.json"));
      return true;
    } catch {
      /* keep walking up */
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

async function hasAiSdkProvider(provider: WorkerProvider): Promise<boolean> {
  if (await hasPackage(`@ai-sdk/${provider}`)) return true;
  try {
    // Non-literal specifier on purpose: these provider SDKs are OPTIONAL (probed,
    // not depended on), and a literal `import("@ai-sdk/openai")` makes tsc resolve
    // a module that may not be installed (CI) → TS2307. A template specifier keeps
    // the runtime probe without compile-time resolution.
    await import(`@ai-sdk/${provider}`);
    return true;
  } catch {
    return false;
  }
}

async function hasCursorSdk(): Promise<boolean> {
  if (await hasPackage("@cursor/sdk")) return true;
  try {
    const spec: string = "@cursor/sdk"; // string-typed → non-literal import (see hasAiSdkProvider)
    await import(spec);
    return true;
  } catch {
    return false;
  }
}

/** Inspect the environment for usable providers/runtimes and suggest workers to create. */
export async function discoverWorkers(): Promise<Discovery> {
  const providers = (Object.keys(PROVIDER_ENV) as WorkerProvider[]).filter((p) =>
    PROVIDER_ENV[p].some((v) => process.env[v]),
  );

  const aiSdkProviderAvailable = new Map<WorkerProvider, boolean>();
  for (const provider of Object.keys(PROVIDER_ENV) as WorkerProvider[]) {
    aiSdkProviderAvailable.set(provider, await hasAiSdkProvider(provider));
  }
  const providerDetails: ProviderDiscovery[] = (Object.keys(PROVIDER_ENV) as WorkerProvider[]).map((provider) => ({
    id: provider,
    configured: providers.includes(provider),
    env: PROVIDER_ENV[provider],
    aiSdkAvailable: aiSdkProviderAvailable.get(provider) ?? false,
  }));

  const runtimeDetails: RuntimeDiscovery[] = [];
  const runnableWorkers: WorkerRuntime[] = [];
  if (await onPath("claude")) {
    runtimeDetails.push({ id: "claude-code", usableAsWorker: true });
    runnableWorkers.push("claude-code");
  }
  // In the published CLI, these providers may be compiled into the binary rather
  // than present as files under node_modules.
  if ([...aiSdkProviderAvailable.values()].some(Boolean)) {
    runtimeDetails.push({ id: "ai-sdk", usableAsWorker: true });
    runnableWorkers.push("ai-sdk");
  }
  if (await onPath("codex")) {
    runtimeDetails.push({
      id: "codex",
      usableAsWorker: false,
      reason: "codex lacks the tools capability required by sikong command tools",
    });
  }
  if (process.env.CURSOR_API_KEY || (await hasCursorSdk())) {
    runtimeDetails.push({
      id: "cursor",
      usableAsWorker: false,
      reason: "cursor lacks the tools capability required by sikong command tools",
    });
  }

  const compatibility: RuntimeCompatibility[] = runnableWorkers.map((runtime) => ({
    runtime,
    providers: COMPATIBLE[runtime],
  }));

  return { providers, providerDetails, runtimes: runtimeDetails.map((r) => r.id), runtimeDetails, compatibility };
}
