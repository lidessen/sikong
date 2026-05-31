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
/** Built-in providers we can resolve a loop for. */
export type WorkerProvider = "deepseek" | "anthropic" | "openai";

export interface Worker {
  id: string;
  name: string;
  /** What this worker is good at — the orchestrating agent reads this to hire. */
  description: string;
  runtime: WorkerRuntime;
  provider: WorkerProvider;
  model: string;
  // skills?/mcp? — a worker's "specialty" — deferred until skill injection lands.
}

export function isValidWorkerId(id: string): boolean {
  return !!id && id !== "." && id !== ".." && /^[A-Za-z0-9._-]+$/.test(id);
}

// ---- discovery: inspect the environment + suggest workers -----------------

export interface WorkerSuggestion {
  id: string;
  runtime: WorkerRuntime;
  provider: WorkerProvider;
  model: string;
  description: string;
}

export interface Discovery {
  providers: WorkerProvider[];
  runtimes: WorkerRuntime[];
  suggestions: WorkerSuggestion[];
}

const PROVIDER_ENV: Record<WorkerProvider, readonly string[]> = {
  deepseek: ["DEEPSEEK_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
};
const MODEL_HINT: Record<WorkerProvider, string> = {
  deepseek: "deepseek-v4-flash",
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.1",
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

/** Inspect the environment for usable providers/runtimes and suggest workers to create. */
export async function discoverWorkers(): Promise<Discovery> {
  const providers = (Object.keys(PROVIDER_ENV) as WorkerProvider[]).filter((p) =>
    PROVIDER_ENV[p].some((v) => process.env[v]),
  );

  const runtimes: WorkerRuntime[] = [];
  if (await onPath("claude")) runtimes.push("claude-code");
  // ai-sdk needs the @ai-sdk/<provider> package for at least one available provider.
  if ((await Promise.all(providers.map((p) => hasPackage(`@ai-sdk/${p}`)))).some(Boolean))
    runtimes.push("ai-sdk");

  const suggestions: WorkerSuggestion[] = [];
  for (const runtime of runtimes)
    for (const provider of COMPATIBLE[runtime])
      if (providers.includes(provider) && (runtime !== "ai-sdk" || (await hasPackage(`@ai-sdk/${provider}`))))
        suggestions.push({
          id: `${provider}-${runtime === "ai-sdk" ? "sdk" : "cc"}`,
          runtime,
          provider,
          model: MODEL_HINT[provider],
          description: `${provider} via ${runtime} (confirm the model)`,
        });

  return { providers, runtimes, suggestions };
}
