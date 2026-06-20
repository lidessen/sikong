/**
 * Runtime ⊥ Provider.
 *
 * A `ModelProvider` is orthogonal to the runtime (the loop engine). It holds the
 * credentials + endpoint facts for an LLM and knows how to translate itself into
 * the launch configuration each runtime needs. The same provider (e.g. one
 * DeepSeek key) can therefore drive multiple runtimes — claude-code via an
 * Anthropic-wire endpoint, ai-sdk in-process, etc. — each with the right env
 * vars / config, and without ever mutating `process.env` (so many providers can
 * run concurrently on one host).
 */

export type RuntimeType = "claude-code" | "codex" | "ai-sdk" | "cursor";

/**
 * Claude Code runtime: an Anthropic-wire endpoint injected purely via the
 * spawned child's environment. The adapter merges `env` into the SDK's
 * `Options.env` (which REPLACES the child env, so the adapter also spreads
 * process.env to keep PATH/HOME). Some Anthropic-wire providers, such as Kimi
 * Code, intentionally do not pass a model override and let Claude Code keep its
 * normal model label while the base URL routes the request.
 */
export interface ClaudeRuntimeConfig {
  runtime: "claude-code";
  /** Child-process env: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, ... */
  env: Record<string, string>;
  /** Optional model id for `Options.model`. */
  model?: string;
}

/**
 * Codex runtime: a custom provider defined + selected via `-c` overrides at
 * `codex app-server` launch, with the API key supplied on the spawned child's
 * env (the var named by the provider's `env_key`).
 */
export interface CodexRuntimeConfig {
  runtime: "codex";
  /** `-c key=value` pairs defining + selecting the provider. */
  configOverrides: string[];
  /** Child-process env holding the api key (the var named by env_key). */
  env: Record<string, string>;
  model: string;
}

/**
 * Plain-data description of the AI SDK model to build. No `ai`/`@ai-sdk/*`
 * import here so importing a provider factory never pulls the AI SDK; the
 * ai-sdk adapter resolves this to a `LanguageModel` lazily.
 */
export type AiSdkProviderSpec =
  | {
      kind: "openai-compatible";
      name: string;
      baseURL: string;
      apiKey: string;
      model: string;
      headers?: Record<string, string>;
    }
  | {
      kind: "moonshotai";
      apiKey: string;
      baseURL?: string;
      model: string;
      headers?: Record<string, string>;
    }
  | { kind: "deepseek"; apiKey: string; baseURL?: string; model: string }
  | { kind: "anthropic"; apiKey: string; baseURL?: string; model: string }
  | { kind: "openai"; apiKey: string; baseURL?: string; model: string }
  | { kind: "gateway"; apiKey?: string; model: string };

/** AI SDK runtime: an in-process LanguageModel, described by `spec`. */
export interface AiSdkRuntimeConfig {
  runtime: "ai-sdk";
  spec: AiSdkProviderSpec;
}

/** Cursor is native: the only credential is the Cursor cloud key. */
export interface CursorRuntimeConfig {
  runtime: "cursor";
  apiKey?: string;
  model?: string;
}

export type RuntimeConfig =
  | ClaudeRuntimeConfig
  | CodexRuntimeConfig
  | AiSdkRuntimeConfig
  | CursorRuntimeConfig;

/** Map a runtime type to its config variant. */
export type RuntimeConfigFor<R extends RuntimeType> = Extract<RuntimeConfig, { runtime: R }>;

/**
 * Per-model price, USD per 1,000,000 tokens. Cache rates are optional — only the
 * providers/models that bill cache separately set them. These are defaults
 * shipped with the library (prices change); a consumer may override them.
 */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Price for cache-read (hit) input tokens, if the provider bills them apart. */
  cacheReadPer1M?: number;
  /** Price for cache-creation/write input tokens, if billed apart. */
  cacheWritePer1M?: number;
}

/**
 * A credential/endpoint bundle, orthogonal to the runtime. Declares which
 * runtimes it can drive and produces each runtime's launch config on demand.
 */
export interface ModelProvider {
  /** Unique id, e.g. "openai", "anthropic", "deepseek". */
  id: string;
  /** Runtimes this provider can drive. */
  supportedRuntimes: RuntimeType[];
  /** Produce the launch config for a runtime. Throws if unsupported. */
  configureFor(runtime: RuntimeType): RuntimeConfig;
  /**
   * Best-known list price for a model id, or undefined when unknown (never
   * guessed — an unknown price means cost is reported as n/a, not zero). The
   * provider owns this because it knows its own model catalogue.
   */
  pricing?(modelId: string): ModelPricing | undefined;
}

export class ProviderRuntimeError extends Error {
  constructor(
    readonly providerId: string,
    readonly runtime: RuntimeType,
    readonly supported: RuntimeType[],
    detail?: string,
  ) {
    super(
      `Provider "${providerId}" does not support the "${runtime}" runtime ` +
        `(supports: ${supported.join(", ") || "none"}).` +
        (detail ? ` ${detail}` : ""),
    );
    this.name = "ProviderRuntimeError";
  }
}

/**
 * Validate `provider` can drive `runtime`, then return its type-narrowed config.
 * Throws `ProviderRuntimeError` on an unsupported combination.
 */
export function resolveRuntimeConfig<R extends RuntimeType>(
  provider: ModelProvider,
  runtime: R,
): RuntimeConfigFor<R> {
  if (!provider.supportedRuntimes.includes(runtime)) {
    throw new ProviderRuntimeError(provider.id, runtime, provider.supportedRuntimes);
  }
  const cfg = provider.configureFor(runtime);
  if (cfg.runtime !== runtime) {
    throw new Error(
      `Provider "${provider.id}".configureFor("${runtime}") returned a "${cfg.runtime}" config.`,
    );
  }
  return cfg as RuntimeConfigFor<R>;
}

/**
 * Build the `-c` override list that defines + selects a custom OpenAI-wire model
 * provider for `codex app-server`. The key itself is NOT placed here — it is
 * supplied on the child env under `envKey`.
 */
export function codexProviderOverrides(args: {
  id: string;
  name: string;
  baseURL: string;
  envKey: string;
  model: string;
  /** OpenAI's own API uses "responses"; most OpenAI-compatible endpoints "chat". */
  wireApi?: "chat" | "responses";
}): string[] {
  const { id, name, baseURL, envKey, model, wireApi = "responses" } = args;
  return [
    "-c",
    `model_provider="${id}"`,
    "-c",
    `model="${model}"`,
    "-c",
    `model_providers.${id}.name="${name}"`,
    "-c",
    `model_providers.${id}.base_url="${baseURL}"`,
    "-c",
    `model_providers.${id}.env_key="${envKey}"`,
    "-c",
    `model_providers.${id}.wire_api="${wireApi}"`,
  ];
}
