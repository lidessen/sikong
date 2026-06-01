import { access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";

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
/** Runtime ids that discovery can report, including runtimes not usable for wakespace command-tool workers yet. */
export type DiscoveredRuntime = WorkerRuntime | "codex" | "cursor";
/** Built-in providers we can resolve a loop for. */
export type WorkerProvider = "deepseek" | "anthropic" | "openai";
/** Runtime permission posture. Currently applied by claude-code workers. */
export type WorkerPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

export interface Worker {
  id: string;
  name: string;
  /** What this worker is good at — the orchestrating agent reads this to hire. */
  description: string;
  runtime: WorkerRuntime;
  provider: WorkerProvider;
  model: string;
  permissionMode?: WorkerPermissionMode;
  // skills?/mcp? — a worker's "specialty" — deferred until skill injection lands.
}

export function isValidWorkerId(id: string): boolean {
  return !!id && id !== "." && id !== ".." && /^[A-Za-z0-9._-]+$/.test(id);
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
    switch (provider) {
      case "deepseek":
        await import("@ai-sdk/deepseek");
        return true;
      case "anthropic":
        await import("@ai-sdk/anthropic");
        return true;
      case "openai":
        await import("@ai-sdk/openai");
        return true;
    }
  } catch {
    return false;
  }
}

async function hasCursorSdk(): Promise<boolean> {
  if (await hasPackage("@cursor/sdk")) return true;
  try {
    await import("@cursor/sdk");
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
      reason: "codex lacks the tools capability required by wakespace command tools",
    });
  }
  if (process.env.CURSOR_API_KEY || (await hasCursorSdk())) {
    runtimeDetails.push({
      id: "cursor",
      usableAsWorker: false,
      reason: "cursor lacks the tools capability required by wakespace command tools",
    });
  }

  const compatibility: RuntimeCompatibility[] = runnableWorkers.map((runtime) => ({
    runtime,
    providers: COMPATIBLE[runtime],
  }));

  return { providers, providerDetails, runtimes: runtimeDetails.map((r) => r.id), runtimeDetails, compatibility };
}
