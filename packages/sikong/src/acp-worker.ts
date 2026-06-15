#!/usr/bin/env bun
/**
 * acp-worker — Bun subprocess for ACP prompt execution, spawned by the Go
 * ACP server for each session. Communicates over stdin/stdout via JSON-RPC.
 *
 * Lifecycle:
 *   1. Go spawns: bun packages/sikong/src/acp-worker.ts
 *   2. Worker waits for "runPrompt" JSON-RPC request on stdin
 *   3. Worker creates AgentLoop, runs prompt, streams events to stdout as NDJSON
 *   4. Worker exits when stdin closes
 *
 * Each line on stdout is a JSON object: { type: "text"|"usage"|"error"|"end", data: {...} }
 */
import {
  aiSdkLoop,
  claudeCodeLoop,
  codexLoop,
  cursorLoop,
  deepseek,
  anthropic,
  openai,
  type AgentLoop,
  type RunHandle,
  type LoopEvent,
} from "agent-loop";

/* -------------------------------------------------------------------------- */
/* NDJSON event writer                                                        */
/* -------------------------------------------------------------------------- */

function sendEvent(kind: string, data: unknown): void {
  process.stdout.write(JSON.stringify({ type: kind, data }) + "\n");
}

/* -------------------------------------------------------------------------- */
/* Agent-loop execution                                                       */
/* -------------------------------------------------------------------------- */

interface AcpPromptParams {
  sessionId: string;
  prompt: string;
  workLog?: Array<{ role: string; text: string; summary?: string }>;
  worker: {
    runtime: string;
    provider: string;
    model?: string;
    apiKey?: string;
  };
}

function buildWorkerLoop(worker: AcpPromptParams["worker"]): AgentLoop {
  const provider =
    worker.provider === "deepseek"
      ? deepseek({ model: worker.model ?? "deepseek-chat", ...(worker.apiKey ? { apiKey: worker.apiKey } : {}) })
      : worker.provider === "anthropic"
        ? anthropic({ model: worker.model ?? "claude-sonnet-4-6", ...(worker.apiKey ? { apiKey: worker.apiKey } : {}) })
        : openai({ model: worker.model ?? "gpt-5.1", ...(worker.apiKey ? { apiKey: worker.apiKey } : {}) });

  switch (worker.runtime) {
    case "ai-sdk":
      return aiSdkLoop({ provider });
    case "claude-code":
      return claudeCodeLoop({ provider });
    case "codex":
      return codexLoop({ provider });
    case "cursor":
      return cursorLoop();
    default:
      throw new Error(`unsupported runtime: ${worker.runtime}`);
  }
}

async function runPrompt(params: AcpPromptParams): Promise<void> {
  const loop = buildWorkerLoop(params.worker);
  const controller = new AbortController();

  // Build prompt with work log context
  const contextParts: string[] = [];
  if (params.workLog && params.workLog.length > 0) {
    // Generate a compact work summary from the log
    const summaries = params.workLog
      .filter((e) => e.summary)
      .map((e) => `[${e.role}] ${e.summary}`);
    if (summaries.length > 0) {
      contextParts.push("Previous work:\n" + summaries.join("\n"));
    }
    // Include the last exchange for continuity (but keep it compact)
    const last = params.workLog.slice(-4);
    if (last.length > 0) {
      contextParts.push("Recent activity:\n" + last.map((e) => `[${e.role}] ${e.text.slice(0, 1000)}`).join("\n"));
    }
  }

  const systemAppend = contextParts.length > 0
    ? "\n\n[Context from previous work]\n" + contextParts.join("\n\n")
    : "";

  const handle = loop.run({
    prompt: params.prompt,
    system: systemAppend,
    signal: controller.signal,
  });

  let fullText = "";
  let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextWindow: 0 };

  try {
    for await (const ev of handle) {
      switch (ev.type) {
        case "text":
          fullText += ev.text;
          sendEvent("text", { text: ev.text });
          break;
        case "usage":
          finalUsage = {
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            totalTokens: ev.totalTokens,
            contextWindow: ev.contextWindow ?? 0,
          };
          sendEvent("usage", {
            totalTokens: ev.totalTokens,
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            contextWindow: ev.contextWindow,
          });
          break;
        case "error":
          sendEvent("error", { message: ev.error.message });
          break;
      }
    }

    const result = await handle.result;
    if (result.status === "cancelled") {
      sendEvent("error", { message: "cancelled" });
    }
  } catch (err) {
    sendEvent("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    await loop.dispose().catch(() => {});
  }

  sendEvent("end", { text: fullText, usage: finalUsage });
}

/* -------------------------------------------------------------------------- */
/* JSON-RPC line reader                                                       */
/* -------------------------------------------------------------------------- */

const readline = require("node:readline") as typeof import("node:readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });

interface JsonRpcMsg {
  id?: number | string;
  method?: string;
  params?: unknown;
}

function sendResult(id: number | string | undefined, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id: number | string | undefined, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed) as JsonRpcMsg;
    if (msg.method === "runPrompt") {
      const params = msg.params as AcpPromptParams;

      // Run the prompt asynchronously — events go to stdout,
      // and the final result is sent as a JSON-RPC response
      runPrompt(params)
        .then(() => {
          sendResult(msg.id, { ok: true });
        })
        .catch((err) => {
          sendError(msg.id, -32000, err.message);
        });
    } else {
      sendError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    sendError(undefined, -32700, `Invalid JSON: ${(err as Error).message}`);
  }
});

rl.on("close", () => {
  process.exit(0);
});
