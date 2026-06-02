import { resolveApiKey } from "../core/credentials";
import {
  codexProviderOverrides,
  ProviderRuntimeError,
  type ModelPricing,
  type ModelProvider,
  type RuntimeConfig,
  type RuntimeType,
} from "../core/provider";
import { MODEL_PRICES } from "./prices.generated";

/**
 * Built-in providers. Each is pure data describing an endpoint + credential and
 * how to translate itself into each runtime it supports. No `ai`/`@ai-sdk/*`
 * imports here — the AI SDK is loaded lazily by the ai-sdk adapter only.
 *
 *   import { deepseek, claudeCodeLoop, aiSdkLoop } from "agent-loop";
 *   const provider = deepseek();              // auto-discovers DEEPSEEK_API_KEY
 *   const provider = deepseek({ apiKey });    // …or pass it explicitly
 *   claudeCodeLoop({ provider });             // drives claude-code (Anthropic wire)
 *   aiSdkLoop({ provider });                  // …and ai-sdk (in-process)
 *
 * `apiKey` is optional: explicit value wins, else it's auto-discovered from the
 * conventional env var (disable with `configureProviders({ autoDiscover: false })`).
 * A provider with no key available throws `MissingCredentialError` at call time.
 *
 * Runtime ⊥ provider: a provider declares which runtimes it can actually drive
 * via `supportedRuntimes`; an unsupported combination throws ProviderRuntimeError.
 */

const DEEPSEEK_ANTHROPIC = "https://api.deepseek.com/anthropic";
const DEEPSEEK_OPENAI = "https://api.deepseek.com/v1";
const ANTHROPIC_BASE = "https://api.anthropic.com";
const OPENAI_BASE = "https://api.openai.com/v1";

function unsupported(
  id: string,
  runtime: RuntimeType,
  supported: RuntimeType[],
  detail?: string,
): never {
  throw new ProviderRuntimeError(id, runtime, supported, detail);
}

/** Derive a conventional env var name from a provider id, e.g. "my-llm" -> "MY_LLM_API_KEY". */
function envVarFor(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/**
 * List prices come from the vendored LiteLLM snapshot
 * (src/providers/prices.generated.ts; refresh with scripts/refresh-prices.ts —
 * we do not hand-maintain prices). Matched by exact model id, else the snapshot
 * entry sharing the longest id prefix (so e.g. "claude-sonnet-4-6" maps to the
 * closest "claude-sonnet-4-5"). An unknown model returns undefined → cost is
 * reported n/a, never guessed.
 */
function sharedPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

export function modelPricing(modelId: string): ModelPricing | undefined {
  const id = modelId.toLowerCase();
  const exact = MODEL_PRICES[id];
  if (exact) return exact;
  let best: { key: string; shared: number } | undefined;
  for (const key of Object.keys(MODEL_PRICES)) {
    const shared = sharedPrefix(id, key);
    if (shared >= 5 && (!best || shared > best.shared)) best = { key, shared };
  }
  return best ? MODEL_PRICES[best.key] : undefined;
}

/**
 * DeepSeek — speaks the Anthropic wire (for claude-code) and is a native AI SDK
 * provider. It does NOT drive codex: codex (>= ~0.135) requires the OpenAI
 * *Responses* wire, but DeepSeek only serves Chat Completions, so a direct
 * codex→DeepSeek connection is impossible without a Responses↔Chat proxy. Use
 * `openaiCompatible({ wireApi: "responses", baseURL: <proxy> })` for that.
 */
export function deepseek(opts: { apiKey?: string; model?: string } = {}): ModelProvider {
  const apiKey = resolveApiKey({
    providerId: "deepseek",
    explicit: opts.apiKey,
    envVars: ["DEEPSEEK_API_KEY"],
  })!;
  const model = opts.model ?? "deepseek-chat";
  const supportedRuntimes: RuntimeType[] = ["claude-code", "ai-sdk"];
  return {
    id: "deepseek",
    supportedRuntimes,
    configureFor(runtime): RuntimeConfig {
      switch (runtime) {
        case "claude-code":
          return {
            runtime,
            model,
            env: {
              ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC,
              ANTHROPIC_API_KEY: apiKey,
              ANTHROPIC_MODEL: model,
            },
          };
        case "ai-sdk":
          return { runtime, spec: { kind: "deepseek", apiKey, model } };
        case "codex":
          return unsupported(
            "deepseek",
            runtime,
            supportedRuntimes,
            "codex requires the OpenAI Responses wire; DeepSeek is Chat-only. " +
              "Use openaiCompatible({ wireApi: 'responses', baseURL: <responses-proxy> }).",
          );
        default:
          return unsupported("deepseek", runtime, supportedRuntimes);
      }
    },
    pricing: (modelId) => modelPricing(modelId),
  };
}

/** Anthropic (native) — Anthropic wire: claude-code + ai-sdk. */
export function anthropic(opts: { apiKey?: string; model?: string } = {}): ModelProvider {
  const apiKey = resolveApiKey({
    providerId: "anthropic",
    explicit: opts.apiKey,
    envVars: ["ANTHROPIC_API_KEY"],
  })!;
  const model = opts.model ?? "claude-sonnet-4-6";
  const supportedRuntimes: RuntimeType[] = ["claude-code", "ai-sdk"];
  return {
    id: "anthropic",
    supportedRuntimes,
    configureFor(runtime): RuntimeConfig {
      switch (runtime) {
        case "claude-code":
          return {
            runtime,
            model,
            env: {
              ANTHROPIC_BASE_URL: ANTHROPIC_BASE,
              ANTHROPIC_API_KEY: apiKey,
              ANTHROPIC_MODEL: model,
            },
          };
        case "ai-sdk":
          return { runtime, spec: { kind: "anthropic", apiKey, model } };
        default:
          return unsupported("anthropic", runtime, supportedRuntimes);
      }
    },
    pricing: (modelId) => modelPricing(modelId),
  };
}

/** OpenAI (native) — OpenAI wire: codex (Responses) + ai-sdk. */
export function openai(opts: {
  apiKey?: string;
  model?: string;
  wireApi?: "chat" | "responses";
} = {}): ModelProvider {
  const apiKey = resolveApiKey({
    providerId: "openai",
    explicit: opts.apiKey,
    envVars: ["OPENAI_API_KEY"],
  })!;
  const model = opts.model ?? "gpt-5.1";
  const supportedRuntimes: RuntimeType[] = ["codex", "ai-sdk"];
  return {
    id: "openai",
    supportedRuntimes,
    configureFor(runtime): RuntimeConfig {
      switch (runtime) {
        case "codex":
          return {
            runtime,
            model,
            env: { OPENAI_API_KEY: apiKey },
            // Note: codex reserves the id "openai", so define a distinct one.
            configOverrides: codexProviderOverrides({
              id: "openai-direct",
              name: "OpenAI",
              baseURL: OPENAI_BASE,
              envKey: "OPENAI_API_KEY",
              model,
              wireApi: opts.wireApi ?? "responses",
            }),
          };
        case "ai-sdk":
          return { runtime, spec: { kind: "openai", apiKey, model } };
        default:
          return unsupported("openai", runtime, supportedRuntimes);
      }
    },
    pricing: (modelId) => modelPricing(modelId),
  };
}

/** Any OpenAI-wire-compatible endpoint (codex + ai-sdk). */
export function openaiCompatible(opts: {
  id: string;
  apiKey?: string;
  baseURL: string;
  model: string;
  name?: string;
  /** Override the env var auto-discovery reads. Default `<ID>_API_KEY`. */
  apiKeyEnvVar?: string;
  /** codex wire: "responses" for codex >= 0.135; "chat" only on older codex. */
  wireApi?: "chat" | "responses";
  headers?: Record<string, string>;
}): ModelProvider {
  const discoveryVar = opts.apiKeyEnvVar ?? envVarFor(opts.id);
  const apiKey = resolveApiKey({
    providerId: opts.id,
    explicit: opts.apiKey,
    envVars: [discoveryVar],
  })!;
  const supportedRuntimes: RuntimeType[] = ["codex", "ai-sdk"];
  // The codex child receives the key under a stable, codex-side env_key.
  const codexEnvKey = envVarFor(opts.id);
  return {
    id: opts.id,
    supportedRuntimes,
    configureFor(runtime): RuntimeConfig {
      switch (runtime) {
        case "codex":
          return {
            runtime,
            model: opts.model,
            env: { [codexEnvKey]: apiKey },
            configOverrides: codexProviderOverrides({
              id: opts.id,
              name: opts.name ?? opts.id,
              baseURL: opts.baseURL,
              envKey: codexEnvKey,
              model: opts.model,
              wireApi: opts.wireApi ?? "responses",
            }),
          };
        case "ai-sdk":
          return {
            runtime,
            spec: {
              kind: "openai-compatible",
              name: opts.id,
              baseURL: opts.baseURL,
              apiKey,
              model: opts.model,
              ...(opts.headers ? { headers: opts.headers } : {}),
            },
          };
        default:
          return unsupported(opts.id, runtime, supportedRuntimes);
      }
    },
  };
}

/** Any Anthropic-wire-compatible endpoint (claude-code + ai-sdk). */
export function anthropicCompatible(opts: {
  id: string;
  apiKey?: string;
  baseURL: string;
  model: string;
  /** Override the env var auto-discovery reads. Default `<ID>_API_KEY`. */
  apiKeyEnvVar?: string;
  /** "x-api-key" (default) or "bearer" (Authorization: Bearer). */
  authStyle?: "x-api-key" | "bearer";
}): ModelProvider {
  const apiKey = resolveApiKey({
    providerId: opts.id,
    explicit: opts.apiKey,
    envVars: [opts.apiKeyEnvVar ?? envVarFor(opts.id)],
  })!;
  const supportedRuntimes: RuntimeType[] = ["claude-code", "ai-sdk"];
  const keyVar = opts.authStyle === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
  return {
    id: opts.id,
    supportedRuntimes,
    configureFor(runtime): RuntimeConfig {
      switch (runtime) {
        case "claude-code":
          return {
            runtime,
            model: opts.model,
            env: {
              ANTHROPIC_BASE_URL: opts.baseURL,
              [keyVar]: apiKey,
              ANTHROPIC_MODEL: opts.model,
            },
          };
        case "ai-sdk":
          return {
            runtime,
            spec: { kind: "anthropic", apiKey, baseURL: opts.baseURL, model: opts.model },
          };
        default:
          return unsupported(opts.id, runtime, supportedRuntimes);
      }
    },
  };
}

/**
 * Vercel AI Gateway — ai-sdk only; model is a "provider/model" string. The key
 * is optional: when omitted it's auto-discovered from `AI_GATEWAY_API_KEY`, and
 * if still absent the AI SDK gateway falls back to that same var itself — so this
 * provider never throws for a missing key.
 */
export function gateway(opts: { apiKey?: string; model: string }): ModelProvider {
  const apiKey = resolveApiKey({
    providerId: "gateway",
    explicit: opts.apiKey,
    envVars: ["AI_GATEWAY_API_KEY"],
    required: false,
  });
  const supportedRuntimes: RuntimeType[] = ["ai-sdk"];
  return {
    id: "gateway",
    supportedRuntimes,
    configureFor(runtime): RuntimeConfig {
      if (runtime !== "ai-sdk") return unsupported("gateway", runtime, supportedRuntimes);
      return {
        runtime,
        spec: { kind: "gateway", ...(apiKey ? { apiKey } : {}), model: opts.model },
      };
    },
  };
}
