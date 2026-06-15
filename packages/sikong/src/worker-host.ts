#!/usr/bin/env bun
/**
 * sikong-worker — JSON-RPC subprocess host for agent-loop wake execution.
 *
 * Spawned by the Go daemon for each wake (or reused across wakes in batch mode).
 * Communicates over stdin/stdout via the JSON-RPC protocol defined in
 * worker-protocol.ts.
 *
 *   bun packages/sikong/src/worker-host.ts
 *
 * Messages are newline-delimited JSON-RPC 2.0. The child sends `initialize`
 * on startup, the parent responds, then the child waits for `runWake` commands.
 */
import {
  aiSdkLoop,
  claudeCodeLoop,
  deepseek,
  anthropic,
  openai,
  type AgentLoop,
  type RunHandle,
  type ToolSet,
} from "agent-loop";
import type { RunWakeParams, RunWakeResult, WakeCommand, WakeTaskContext, WakeWorkerConfig } from "./worker-protocol";

/* -------------------------------------------------------------------------- */
/* JSON-RPC line reader/writer over stdio                                     */
/* -------------------------------------------------------------------------- */

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
}

const readline = require("node:readline") as typeof import("node:readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });

let currentWake: { run: RunHandle; controller: AbortController } | null = null;
let currentResolve: ((result: RunWakeResult) => void) | null = null;
let currentReject: ((err: Error) => void) | null = null;

function sendLine(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendNotify(method: string, params?: unknown): void {
  sendLine({ jsonrpc: "2.0", method, params });
}

function sendError(id: number | string | undefined, code: number, message: string): void {
  sendLine({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendResult(id: number | string | undefined, result: unknown): void {
  sendLine({ jsonrpc: "2.0", id, result });
}

/* -------------------------------------------------------------------------- */
/* Agent-loop wake execution                                                  */
/* -------------------------------------------------------------------------- */

function buildWorkerLoop(worker: WakeWorkerConfig): AgentLoop {
  const provider =
    worker.provider.id === "deepseek"
      ? deepseek({ model: worker.provider.model, ...(worker.provider.apiKey ? { apiKey: worker.provider.apiKey } : {}) })
      : worker.provider.id === "anthropic"
        ? anthropic({ model: worker.provider.model, ...(worker.provider.apiKey ? { apiKey: worker.provider.apiKey } : {}) })
        : openai({ model: worker.provider.model, ...(worker.provider.apiKey ? { apiKey: worker.provider.apiKey } : {}) });

  if (worker.runtime === "ai-sdk") {
    return aiSdkLoop({ provider });
  }

  return claudeCodeLoop({
    provider,
    cwd: worker.cwd,
    ...(worker.env ? { env: worker.env } : {}),
    ...(worker.permissionMode ? { permissionMode: worker.permissionMode as any } : {}),
  });
}

function commandFromTool(name: string, args: Record<string, unknown>): WakeCommand | undefined {
  switch (name) {
    case "set_field": {
      if (typeof args.field !== "string" || args.field.length === 0) return undefined;
      return { kind: "set_field", field: args.field, value: args.value };
    }
    case "request_transition":
      return {
        kind: "request_transition",
        ...(typeof args.reason === "string" && args.reason.length > 0 ? { reason: args.reason } : {}),
      };
    case "append_note":
      return typeof args.text === "string" && args.text.length > 0
        ? { kind: "append_note", text: args.text }
        : undefined;
    case "block":
      return typeof args.reason === "string" && args.reason.length > 0
        ? { kind: "block", reason: args.reason }
        : undefined;
    case "cancel":
      return {
        kind: "cancel",
        ...(typeof args.reason === "string" && args.reason.length > 0 ? { reason: args.reason } : {}),
      };
    default:
      return undefined;
  }
}

const COMMAND_TOOL_NAMES = new Set(["set_field", "request_transition", "append_note", "block", "cancel"]);

async function executeWake(task: WakeTaskContext, worker: WakeWorkerConfig): Promise<void> {
  const loop = buildWorkerLoop(worker);
  const controller = new AbortController();
  const commands: WakeCommand[] = [];

  // Build tools from the task context
  const tools: ToolSet = {};
  if (task.tools) {
    for (const [name, def] of Object.entries(task.tools)) {
      tools[name] = {
        description: def.description,
        inputSchema: def.inputSchema,
        ...(COMMAND_TOOL_NAMES.has(name)
          ? {
              execute: async (args: Record<string, unknown>) => {
                const command = commandFromTool(name, args);
                if (!command) {
                  return { acknowledged: false, error: `invalid ${name} arguments` };
                }
                commands.push(command);
                sendNotify("wake.command", { command });
                return { acknowledged: true };
              },
            }
          : {}),
      };
    }
  }

  const handle = loop.run({
    system: task.systemPrompt,
    prompt: task.userPrompt,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    maxSteps: task.maxSteps,
    effort: task.effort,
    signal: controller.signal,
  });

  currentWake = { run: handle, controller };
  let fullText = "";
  let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let finalStatus: "completed" | "cancelled" | "error" = "completed";
  let finalError: string | undefined;

  try {
    // Stream events to parent
    for await (const ev of handle) {
      switch (ev.type) {
        case "text":
          fullText += ev.text;
          sendNotify("wake.text", { delta: ev.text });
          break;
        case "thinking":
          sendNotify("wake.thinking", { delta: ev.text });
          break;
        case "tool_call_start":
          sendNotify("wake.tool_call_start", { name: ev.name, callId: ev.callId, args: ev.args });
          break;
        case "tool_call_end":
          sendNotify("wake.tool_call_end", { name: ev.name, callId: ev.callId, result: ev.result, error: ev.error, durationMs: ev.durationMs });
          break;
        case "usage":
          finalUsage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, totalTokens: ev.totalTokens };
          sendNotify("wake.usage", { ...finalUsage, source: ev.source, contextWindow: ev.contextWindow, usedRatio: ev.usedRatio });
          break;
        case "error":
          finalStatus = "error";
          finalError = ev.error.message;
          sendNotify("wake.error", { message: ev.error.message });
          break;
      }
    }

    const result = await handle.result;
    finalStatus = result.status === "cancelled" ? "cancelled" : result.status === "error" ? "error" : "completed";
    finalUsage = finalUsage.totalTokens > 0 ? finalUsage : result.usage;
  } catch (err) {
    finalStatus = "error";
    finalError = err instanceof Error ? err.message : String(err);
    sendNotify("wake.error", { message: finalError });
  } finally {
    currentWake = null;
    // Cleanup adapter
    await loop.dispose().catch(() => {});
  }

  const wakeResult: RunWakeResult = {
    usage: finalUsage,
    durationMs: 0, // filled by the parent from timing
    status: finalStatus,
    text: fullText,
    ...(commands.length > 0 ? { commands } : {}),
    ...(finalError ? { error: finalError } : {}),
  };

  currentResolve?.(wakeResult);
  currentResolve = null;
  currentReject = null;
}

/* -------------------------------------------------------------------------- */
/* Message dispatcher                                                          */
/* -------------------------------------------------------------------------- */

async function handleRequest(msg: JsonRpcMessage): Promise<void> {
  const method = msg.method;
  const id = msg.id;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "initialize": {
      sendResult(id, {
        protocolVersion: "1.0",
        capabilities: { steer: true, cancel: true, usage: true },
      });
      break;
    }

    case "runWake": {
      if (currentWake) {
        sendError(id, -32000, "a wake is already running");
        return;
      }
      const p = params as unknown as RunWakeParams;
      // Execute the wake and wait for completion
      const result = await new Promise<RunWakeResult>((resolve, reject) => {
        currentResolve = resolve;
        currentReject = reject;
        executeWake(p.task, p.worker).catch(reject);
      });
      sendNotify("wake.end", {});
      sendResult(id, result);
      break;
    }

    case "steer": {
      if (!currentWake) {
        sendError(id, -32000, "no active wake to steer");
        return;
      }
      const steerMsg = (params as { message?: string }).message ?? "";
      await currentWake.run.steer(steerMsg);
      sendResult(id, { mode: "live" });
      break;
    }

    case "cancel": {
      currentWake?.run.cancel("parent requested cancel");
      sendResult(id, { cancelled: true });
      break;
    }

    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Main loop                                                                   */
/* -------------------------------------------------------------------------- */

// Send initialize notification on startup
sendNotify("initialize", {
  protocolVersion: "1.0",
  clientInfo: { name: "sikong-worker", version: "1.0.0" },
});

// Process incoming JSON-RPC messages from stdin
rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed) as JsonRpcMessage;
    if (msg.method && msg.id !== undefined) {
      // Request from parent
      void handleRequest(msg);
    }
    // Notifications from parent are ignored (we don't send requests that need notification responses)
  } catch (err) {
    sendNotify("worker.error", { message: `invalid JSON-RPC: ${(err as Error).message}` });
  }
});

rl.on("close", () => {
  // Parent closed stdin — shut down
  currentWake?.run.cancel("parent disconnected");
  process.exit(0);
});
