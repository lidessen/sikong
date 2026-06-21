import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { runRuntimeHost } from "./runtime-host";
import type { AgentHostMessage, AgentRunRequest } from "./protocol";

test("socket runtime host writes large responses completely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "siko-agent-host-test-"));
  const socketPath = join(dir, "agent-host.sock");
  const largeReport = "large-response:".repeat(2_000);
  const request = validRunRequest();
  const host = runRuntimeHost({
    socketPath,
    worker: async () => ({
      report: largeReport,
      toolCalls: [{ name: "finish", arguments: { ok: true } }],
      terminalCall: { name: "finish", arguments: { ok: true } },
      usage: { totalTokens: 1 },
    }),
  });

  try {
    await waitForSocket(socketPath);
    const client = await connectClient(socketPath);
    client.socket.write(`${JSON.stringify({ type: "run", id: "run_1", request })}\n`);

    const line = await client.readLine();
    const message = JSON.parse(line) as AgentHostMessage;
    expect(message.type).toBe("result");
    if (message.type !== "result") {
      throw new Error("expected result message");
    }
    expect(message.id).toBe("run_1");
    expect(message.result.report).toBe(largeReport);
    expect(message.result.terminalCall?.name).toBe("finish");

    client.socket.write(`${JSON.stringify({ type: "shutdown", id: "shutdown_1" })}\n`);
    await host;
    client.socket.end();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function validRunRequest(): AgentRunRequest {
  return {
    protocolVersion: 1,
    objective: "large socket response",
    prompt: [{ title: "Role", content: "Return a large response." }],
    input: {},
    tools: [
      {
        name: "finish",
        description: "Finish the run.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    terminalToolSet: ["finish"],
    runtimeProfile: "general",
  };
}

async function waitForSocket(socketPath: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    try {
      if ((await stat(socketPath)).isSocket()) {
        return;
      }
    } catch {
      // Retry until the host creates the socket.
    }
    await Bun.sleep(20);
  }
  throw new Error(`socket was not created: ${socketPath}`);
}

async function connectClient(socketPath: string): Promise<{
  socket: Bun.Socket<ClientState>;
  readLine: () => Promise<string>;
}> {
  let resolveLine: ((line: string) => void) | undefined;
  let rejectLine: ((error: Error) => void) | undefined;
  const line = new Promise<string>((resolve, reject) => {
    resolveLine = resolve;
    rejectLine = reject;
  });

  const socket = await Bun.connect<ClientState>({
    unix: socketPath,
    data: { buffer: "", decoder: new TextDecoder() },
    socket: {
      data(socket, data) {
        socket.data.buffer += socket.data.decoder.decode(data, { stream: true });
        const newlineIndex = socket.data.buffer.indexOf("\n");
        if (newlineIndex >= 0) {
          const firstLine = socket.data.buffer.slice(0, newlineIndex);
          socket.data.buffer = socket.data.buffer.slice(newlineIndex + 1);
          resolveLine?.(firstLine);
        }
      },
      error(_socket, error) {
        rejectLine?.(error instanceof Error ? error : new Error(String(error)));
      },
      close(_socket, error) {
        if (error) {
          rejectLine?.(error instanceof Error ? error : new Error(String(error)));
        }
      },
    },
  });

  return {
    socket,
    readLine: () => withTimeout(line, 5_000),
  };
}

interface ClientState {
  buffer: string;
  decoder: TextDecoder;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for socket line")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
