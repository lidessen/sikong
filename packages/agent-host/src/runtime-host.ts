import { rm } from "node:fs/promises";
import { createServer, type Socket as NodeSocket } from "node:net";

import { createAgentLoopWorker } from "./agent-loop-worker";
import type { EffortLevel } from "agent-loop";
import { runMockAgentWorker } from "./mock-worker";
import {
  parseRuntimeClientMessage,
  type AgentHostMessage,
  type AgentRunRequest,
  type AgentRunResponse,
  type RuntimeClientMessage,
} from "./protocol";

export type RuntimeWorker = (request: AgentRunRequest) => Promise<AgentRunResponse>;

export interface RuntimeHostOptions {
  worker?: RuntimeWorker;
  socketPath?: string;
}

export async function runRuntimeHost(options: RuntimeHostOptions = {}): Promise<void> {
  const worker = options.worker ?? createRuntimeWorker(Bun.argv);
  if (options.socketPath) {
    await runSocketRuntimeHost(options.socketPath, worker);
    return;
  }

  for await (const line of readLines(Bun.stdin.stream())) {
    const shouldStop = await handleLine(line, worker, (message) => {
      writeStdout(messageLine(message));
    });
    if (shouldStop) {
      break;
    }
  }
}

async function runSocketRuntimeHost(socketPath: string, worker: RuntimeWorker): Promise<void> {
  await deleteIfExists(socketPath);

  let stopHost: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stopHost = resolve;
  });
  const listener = createServer((socket) => {
    const state = newSocketState();
    socket.on("data", (data) => {
      const chunk =
        typeof data === "string"
          ? new TextEncoder().encode(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
      state.pending = state.pending
        .then(() => {
          if (state.shuttingDown) {
            return;
          }
          return handleSocketData(socket, state, chunk, worker, () => {
            if (state.shuttingDown) {
              return;
            }
            state.shuttingDown = true;
            socket.end(() => {
              listener.close(() => {
                stopHost();
              });
            });
          });
        })
        .catch((error) => {
          writeSocketMessage(socket, {
            type: "error",
            id: "unknown",
            message: errorMessage(error),
          });
        });
    });
    socket.on("error", (error) => {
      if (!socket.destroyed) {
        writeSocketMessage(socket, {
          type: "error",
          id: "unknown",
          message: errorMessage(error),
        });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      listener.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      listener.off("error", onError);
      resolve();
    };
    listener.once("error", onError);
    listener.once("listening", onListening);
    listener.listen(socketPath);
  });

  await stopped;
  await deleteIfExists(socketPath);
}

interface SocketState {
  buffer: string;
  decoder: TextDecoder;
  pending: Promise<void>;
  shuttingDown: boolean;
}

function newSocketState(): SocketState {
  return {
    buffer: "",
    decoder: new TextDecoder(),
    pending: Promise.resolve(),
    shuttingDown: false,
  };
}

async function handleSocketData(
  socket: NodeSocket,
  state: SocketState,
  data: Uint8Array,
  worker: RuntimeWorker,
  shutdown: () => void,
): Promise<void> {
  state.buffer += state.decoder.decode(data, { stream: true });

  let newlineIndex = state.buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = state.buffer.slice(0, newlineIndex);
    state.buffer = state.buffer.slice(newlineIndex + 1);
    const shouldStop = await handleLine(line, worker, (message) => {
      writeSocketMessage(socket, message);
    });
    if (shouldStop) {
      shutdown();
      return;
    }
    newlineIndex = state.buffer.indexOf("\n");
  }
}

async function handleLine(
  line: string,
  worker: RuntimeWorker,
  writeMessage: (message: AgentHostMessage) => void,
): Promise<boolean> {
  if (!line.trim()) {
    return false;
  }

  let message: RuntimeClientMessage;
  try {
    message = parseRuntimeClientMessage(JSON.parse(line));
  } catch (error) {
    writeMessage({
      type: "error",
      id: "unknown",
      message: `invalid runtime message: ${errorMessage(error)}`,
    });
    return false;
  }

  if (message.type === "shutdown") {
    writeMessage({
      type: "result",
      id: message.id,
      result: { report: "agent host shutting down" },
    });
    return true;
  }

  const startedAt = performance.now();
  logHostEvent("run.start", {
    id: message.id,
    objective: message.request.objective,
    terminalToolSet: message.request.terminalToolSet,
  });

  try {
    const result = await worker(message.request);
    logHostEvent("run.complete", {
      id: message.id,
      durationMs: Math.round(performance.now() - startedAt),
      terminalTool: result.terminalCall?.name,
      toolCallCount: result.toolCalls?.length ?? 0,
      usage: result.usage,
    });
    writeMessage({ type: "result", id: message.id, result });
  } catch (error) {
    logHostEvent("run.error", {
      id: message.id,
      durationMs: Math.round(performance.now() - startedAt),
      error: errorMessage(error),
    });
    writeMessage({
      type: "error",
      id: message.id,
      message: errorMessage(error),
    });
  }
  return false;
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      yield buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield buffer;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  await runRuntimeHost({ socketPath: parseSocketPath(Bun.argv) });
}

function createRuntimeWorker(argv: string[]): RuntimeWorker {
  const worker = parseFlag(argv, "--worker") ?? Bun.env.SIKONG_AGENT_HOST_WORKER ?? "mock";
  if (worker === "agent-loop" || worker === "real" || worker === "kimi") {
    return createAgentLoopWorker({
      provider: parseAgentLoopProvider(argv),
      runtime: parseAgentLoopRuntime(argv),
      model: parseFlag(argv, "--model") ?? Bun.env.SIKONG_AGENT_HOST_MODEL,
      maxSteps: parsePositiveInt(parseFlag(argv, "--max-steps")),
      effort: parseAgentLoopEffort(argv),
    });
  }
  return runMockAgentWorker;
}

function parseAgentLoopProvider(argv: string[]): "deepseek" | "kimi" | undefined {
  const provider = parseFlag(argv, "--provider") ?? Bun.env.SIKONG_AGENT_HOST_PROVIDER;
  if (provider === "deepseek" || provider === "kimi") {
    return provider;
  }
  return undefined;
}

function parseAgentLoopRuntime(argv: string[]): "ai-sdk" | "claude-code" | undefined {
  const runtime = parseFlag(argv, "--runtime") ?? Bun.env.SIKONG_AGENT_HOST_RUNTIME;
  if (runtime === "ai-sdk" || runtime === "claude-code") {
    return runtime;
  }
  return undefined;
}

function parseAgentLoopEffort(argv: string[]): EffortLevel | undefined {
  const effort = parseFlag(argv, "--effort") ?? Bun.env.SIKONG_AGENT_HOST_EFFORT;
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "max") {
    return effort;
  }
  return undefined;
}

function parseSocketPath(argv: string[]): string | undefined {
  return parseFlag(argv, "--socket");
}

function parseFlag(argv: string[], name: string): string | undefined {
  const flagIndex = argv.indexOf(name);
  if (flagIndex < 0) {
    return undefined;
  }
  const value = argv[flagIndex + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function messageLine(message: AgentHostMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function writeSocketMessage(socket: NodeSocket, message: AgentHostMessage): void {
  socket.write(messageLine(message));
}

function writeStdout(text: string): void {
  Bun.write(Bun.stdout, text);
}

function logHostEvent(event: string, fields: Record<string, unknown>): void {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), source: "agent-host", event, ...fields }),
  );
}

async function deleteIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}
