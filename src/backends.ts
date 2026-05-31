import type { AiSdkAdapterOptions } from "./adapters/ai-sdk";
import type { ClaudeAdapterOptions } from "./adapters/claude";
import type { CodexAdapterOptions } from "./adapters/codex";
import type { CursorAdapterOptions } from "./adapters/cursor";
import type { MockAdapterOptions } from "./adapters/mock";
import { AISDK_CAPS, CLAUDE_CAPS, CODEX_CAPS, CURSOR_CAPS, MOCK_CAPS } from "./caps";
import { makeLoop, type AgentLoop } from "./loop";

/**
 * Backend factories. Each returns the same `AgentLoop` interface; the only
 * difference is which backend runs. Adapters (and their SDKs) load lazily on
 * first use, so `import { aiSdkLoop } from "agent-loop"` does not require the
 * Claude / Codex / Cursor SDKs to be installed.
 *
 *   import { aiSdkLoop, claudeCodeLoop, codexLoop } from "agent-loop";
 *   const loop = aiSdkLoop({ model: deepseek("deepseek-chat") });
 *   const run = loop.run({ prompt, hooks });
 *   for await (const ev of run) { ... }
 *   await run.result;
 */

/** Vercel AI SDK backend. `model` is a constructed AI SDK `LanguageModel`. */
export function aiSdkLoop(options: AiSdkAdapterOptions): AgentLoop {
  return makeLoop("ai-sdk", AISDK_CAPS, async () => {
    const { AiSdkAdapter } = await import("./adapters/ai-sdk");
    return new AiSdkAdapter(options);
  });
}

/** Claude Agent SDK backend (`claude` / claude-code runtime). */
export function claudeCodeLoop(options: ClaudeAdapterOptions = {}): AgentLoop {
  return makeLoop("claude", CLAUDE_CAPS, async () => {
    const { ClaudeAdapter } = await import("./adapters/claude");
    return new ClaudeAdapter(options);
  });
}

/** Codex app-server backend (spawns the `codex` CLI over JSON-RPC/stdio). */
export function codexLoop(options: CodexAdapterOptions = {}): AgentLoop {
  return makeLoop("codex", CODEX_CAPS, async () => {
    const { CodexAdapter } = await import("./adapters/codex");
    return new CodexAdapter(options);
  });
}

/** Cursor Agent SDK backend. */
export function cursorLoop(options: CursorAdapterOptions = {}): AgentLoop {
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
