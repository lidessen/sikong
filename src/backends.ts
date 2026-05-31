import type { AiSdkAdapterOptions } from "./adapters/ai-sdk";
import type { ClaudeAdapterOptions } from "./adapters/claude";
import type { CodexAdapterOptions } from "./adapters/codex";
import type { CursorAdapterOptions } from "./adapters/cursor";
import type { MockAdapterOptions } from "./adapters/mock";
import { AISDK_CAPS, CLAUDE_CAPS, CODEX_CAPS, CURSOR_CAPS, MOCK_CAPS } from "./caps";
import { resolveRuntimeConfig, type ModelProvider } from "./core/provider";
import { makeLoop, type AgentLoop } from "./loop";

/**
 * Backend factories. Each returns the same `AgentLoop` interface; the only
 * difference is which runtime runs. A `ModelProvider` is orthogonal: pass the
 * same provider to any runtime it supports and the factory injects the right
 * launch config (env vars / `-c` overrides / in-process model) — credentials as
 * data, never via `process.env`. An unsupported runtime⊥provider pair throws
 * `ProviderRuntimeError` at factory-call time.
 *
 *   import { aiSdkLoop, claudeCodeLoop, deepseek } from "agent-loop";
 *   const provider = deepseek({ apiKey });
 *   const loop = claudeCodeLoop({ provider });   // claude-code runtime, DeepSeek model
 *   for await (const ev of loop.run({ prompt, hooks })) { ... }
 *
 * Adapters (and their SDKs) load lazily on first use, so importing one factory
 * does not require the others' dependencies.
 */

export interface AiSdkLoopOptions extends AiSdkAdapterOptions {
  /** A provider to drive the AI SDK runtime (alternative to `model`). */
  provider?: ModelProvider;
}

export interface ClaudeLoopOptions extends ClaudeAdapterOptions {
  /** A provider (Anthropic-wire) to inject as child-env credentials. */
  provider?: ModelProvider;
}

export interface CodexLoopOptions extends CodexAdapterOptions {
  /** A provider (OpenAI Responses-wire) to inject via `-c` overrides + child env. */
  provider?: ModelProvider;
}

export type CursorLoopOptions = CursorAdapterOptions;

/** Vercel AI SDK runtime. Supply a `provider` OR a constructed `model`. */
export function aiSdkLoop(options: AiSdkLoopOptions = {}): AgentLoop {
  const { provider, ...rest } = options;
  const opts: AiSdkAdapterOptions = { ...rest };
  if (provider) opts.spec = resolveRuntimeConfig(provider, "ai-sdk").spec;
  return makeLoop("ai-sdk", AISDK_CAPS, async () => {
    const { AiSdkAdapter } = await import("./adapters/ai-sdk");
    return new AiSdkAdapter(opts);
  });
}

/** Claude Agent SDK runtime (claude-code). */
export function claudeCodeLoop(options: ClaudeLoopOptions = {}): AgentLoop {
  const { provider, ...rest } = options;
  const opts: ClaudeAdapterOptions = { ...rest };
  if (provider) {
    const cfg = resolveRuntimeConfig(provider, "claude-code");
    opts.providerEnv = cfg.env;
    opts.providerModel = cfg.model;
    opts.hasInjectedProvider = true;
  }
  return makeLoop("claude", CLAUDE_CAPS, async () => {
    const { ClaudeAdapter } = await import("./adapters/claude");
    return new ClaudeAdapter(opts);
  });
}

/** Codex app-server runtime (spawns the `codex` CLI over JSON-RPC/stdio). */
export function codexLoop(options: CodexLoopOptions = {}): AgentLoop {
  const { provider, ...rest } = options;
  const opts: CodexAdapterOptions = { ...rest };
  if (provider) {
    const cfg = resolveRuntimeConfig(provider, "codex");
    opts.providerOverrides = cfg.configOverrides;
    opts.providerEnv = cfg.env;
    opts.providerModel = cfg.model;
    opts.hasInjectedProvider = true;
  }
  return makeLoop("codex", CODEX_CAPS, async () => {
    const { CodexAdapter } = await import("./adapters/codex");
    return new CodexAdapter(opts);
  });
}

/** Cursor Agent SDK runtime (native: credential is the Cursor cloud key). */
export function cursorLoop(options: CursorLoopOptions = {}): AgentLoop {
  return makeLoop("cursor", CURSOR_CAPS, async () => {
    const { CursorAdapter } = await import("./adapters/cursor");
    return new CursorAdapter(options);
  });
}

/** In-process backend with no SDK or network — for tests and demos. */
export function mockLoop(options: MockAdapterOptions = {}): AgentLoop {
  return makeLoop("mock", MOCK_CAPS, async () => {
    const { MockAdapter } = await import("./adapters/mock");
    return new MockAdapter(options);
  });
}
