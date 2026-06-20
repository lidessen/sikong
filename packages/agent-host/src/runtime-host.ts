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
  const worker = options.worker ?? runMockAgentWorker;
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
  const listener = Bun.listen<SocketState>({
    unix: socketPath,
    data: newSocketState(),
    socket: {
      open(socket) {
        socket.data = newSocketState();
      },
      data(socket, data) {
        const chunk = data.slice();
        socket.data.pending = socket.data.pending
          .then(() => {
            if (socket.data.shuttingDown) {
              return;
            }
            return handleSocketData(socket, chunk, worker, () => {
              if (socket.data.shuttingDown) {
                return;
              }
              socket.data.shuttingDown = true;
              socket.end();
              listener.stop(true);
              stopHost();
            });
          })
          .catch((error) => {
            socket.write(
              messageLine({ type: "error", id: "unknown", message: errorMessage(error) }),
            );
          });
      },
      error(socket, error) {
        socket.write(messageLine({ type: "error", id: "unknown", message: errorMessage(error) }));
      },
    },
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
  socket: Bun.Socket<SocketState>,
  data: Uint8Array,
  worker: RuntimeWorker,
  shutdown: () => void,
): Promise<void> {
  socket.data.buffer += socket.data.decoder.decode(data, { stream: true });

  let newlineIndex = socket.data.buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = socket.data.buffer.slice(0, newlineIndex);
    socket.data.buffer = socket.data.buffer.slice(newlineIndex + 1);
    const shouldStop = await handleLine(line, worker, (message) => {
      socket.write(messageLine(message));
    });
    if (shouldStop) {
      shutdown();
      return;
    }
    newlineIndex = socket.data.buffer.indexOf("\n");
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

  try {
    const result = await worker(message.request);
    writeMessage({ type: "result", id: message.id, result });
  } catch (error) {
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

function parseSocketPath(argv: string[]): string | undefined {
  const socketFlagIndex = argv.indexOf("--socket");
  if (socketFlagIndex < 0) {
    return undefined;
  }
  return argv[socketFlagIndex + 1];
}

function messageLine(message: AgentHostMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function writeStdout(text: string): void {
  Bun.write(Bun.stdout, text);
}

async function deleteIfExists(path: string): Promise<void> {
  const file = Bun.file(path);
  if (await file.exists()) {
    await file.delete();
  }
}
