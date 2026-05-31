import {
  codexProviderOverrides,
  ProviderRuntimeError,
  type ModelProvider,
  type RuntimeConfig,
  type RuntimeType,
} from "../core/provider";

/**
 * Built-in providers. Each is pure data describing an endpoint + credential and
 * how to translate itself into each runtime it supports. No `ai`/`@ai-sdk/*`
 * imports here — the AI SDK is loaded lazily by the ai-sdk adapter only.
 *
 *   import { deepseek, claudeCodeLoop, aiSdkLoop } from "agent-loop";
 *   const provider = deepseek({ apiKey });   // one key…
 *   claudeCodeLoop({ provider });            // …drives claude-code (Anthropic wire)
 *   aiSdkLoop({ provider });                 // …and ai-sdk (in-process)
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

/**
 * DeepSeek — speaks the Anthropic wire (for claude-code) and is a native AI SDK
 * provider. It does NOT drive codex: codex (>= ~0.135) requires the OpenAI
 * *Responses* wire, but DeepSeek only serves Chat Completions, so a direct
 * codex→DeepSeek connection is impossible without a Responses↔Chat proxy. Use
 * `openaiCompatible({ wireApi: "responses", baseURL: <proxy> })` for that.
 */
export function deepseek(opts: { apiKey: string; model?: string }): ModelProvider {
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
              ANTHROPIC_API_KEY: opts.apiKey,
              ANTHROPIC_MODEL: model,
            },
          };
        case "ai-sdk":
          return { runtime, spec: { kind: "deepseek", apiKey: opts.apiKey, model } };
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
  };
}

/** Anthropic (native) — Anthropic wire: claude-code + ai-sdk. */
export function anthropic(opts: { apiKey: string; model?: string }): ModelProvider {
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
              ANTHROPIC_API_KEY: opts.apiKey,
              ANTHROPIC_MODEL: model,
            },
          };
        case "ai-sdk":
          return { runtime, spec: { kind: "anthropic", apiKey: opts.apiKey, model } };
        default:
          return unsupported("anthropic", runtime, supportedRuntimes);
      }
    },
  };
}

/** OpenAI (native) — OpenAI wire: codex (Responses) + ai-sdk. */
export function openai(opts: {
  apiKey: string;
  model?: string;
  wireApi?: "chat" | "responses";
}): ModelProvider {
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
            env: { OPENAI_API_KEY: opts.apiKey },
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
          return { runtime, spec: { kind: "openai", apiKey: opts.apiKey, model } };
        default:
          return unsupported("openai", runtime, supportedRuntimes);
      }
    },
  };
}

/** Any OpenAI-wire-compatible endpoint (codex + ai-sdk). */
export function openaiCompatible(opts: {
  id: string;
  apiKey: string;
  baseURL: string;
  model: string;
  name?: string;
  /** codex wire: "responses" for codex >= 0.135; "chat" only on older codex. */
  wireApi?: "chat" | "responses";
  headers?: Record<string, string>;
}): ModelProvider {
  const supportedRuntimes: RuntimeType[] = ["codex", "ai-sdk"];
  const envKey = `${opts.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  return {
    id: opts.id,
    supportedRuntimes,
    configureFor(runtime): RuntimeConfig {
      switch (runtime) {
        case "codex":
          return {
            runtime,
            model: opts.model,
            env: { [envKey]: opts.apiKey },
            configOverrides: codexProviderOverrides({
              id: opts.id,
              name: opts.name ?? opts.id,
              baseURL: opts.baseURL,
              envKey,
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
              apiKey: opts.apiKey,
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
  apiKey: string;
  baseURL: string;
  model: string;
  /** "x-api-key" (default) or "bearer" (Authorization: Bearer). */
  authStyle?: "x-api-key" | "bearer";
}): ModelProvider {
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
              [keyVar]: opts.apiKey,
              ANTHROPIC_MODEL: opts.model,
            },
          };
        case "ai-sdk":
          return {
            runtime,
            spec: { kind: "anthropic", apiKey: opts.apiKey, baseURL: opts.baseURL, model: opts.model },
          };
        default:
          return unsupported(opts.id, runtime, supportedRuntimes);
      }
    },
  };
}

/** Vercel AI Gateway — ai-sdk only; model is a "provider/model" string. */
export function gateway(opts: { apiKey?: string; model: string }): ModelProvider {
  const supportedRuntimes: RuntimeType[] = ["ai-sdk"];
  return {
    id: "gateway",
    supportedRuntimes,
    configureFor(runtime): RuntimeConfig {
      if (runtime !== "ai-sdk") return unsupported("gateway", runtime, supportedRuntimes);
      return {
        runtime,
        spec: { kind: "gateway", ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), model: opts.model },
      };
    },
  };
}
