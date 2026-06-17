import { createSseResponse, type SseEmitter } from "../sse-stream";

// ---------------------------------------------------------------------------
// Test-server lifecycle
// ---------------------------------------------------------------------------

export interface TestServerHandle {
  url: string;
  stop: () => void;
}

export interface MockTurnConfig {
  /** How long the mock turn should run before completing (ms). 0 = instant. */
  workDelayMs?: number;
  /** If true, the mock throws a timeout error instead of completing. */
  shouldTimeout?: boolean;
  /** Custom error message emitted as turn.error (only when shouldTimeout is false). */
  errorMessage?: string;
  /** When true, wire up cancellation infrastructure like the real turnStreamResponse. */
  enableCancellation?: boolean;
}

/** Start a minimal Bun HTTP server that serves /api/turn/stream and /api/health. */
export function startTestServer(config?: MockTurnConfig): TestServerHandle {
  const config_ = config ?? {};
  const port = 0; // random available port

  const server = Bun.serve({
    port,
    async fetch(request) {
      const url_ = new URL(request.url);

      if (url_.pathname === "/api/turn/stream" && request.method === "POST") {
        // When enableCancellation is set, wire up proper abort infrastructure
        // (mirrors the real turnStreamResponse pattern)
        if (config_.enableCancellation) {
          const abortController = new AbortController();
          request.signal.addEventListener("abort", () => abortController.abort("cancelled"), {
            once: true,
          });

          return createSseResponse(
            (emit) => {
              void runMockTurnWithCancel(emit, abortController.signal, config_);
            },
            100,
            {},
            () => abortController.abort("cancelled"),
          );
        }

        return createSseResponse(
          (emit) => {
            runMockTurn(emit, config_);
          },
          100, // fast heartbeat (100ms) so tests don't wait long
        );
      }

      if (url_.pathname === "/api/health" && request.method === "GET") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// Mock turn runner
// ---------------------------------------------------------------------------

function runMockTurn(emit: SseEmitter, config: MockTurnConfig): void {
  const turnId = crypto.randomUUID();
  const segmentId = crypto.randomUUID();

  void (async () => {
    emit.send({
      type: "turn.started",
      turnId,
      segmentId,
      startedAt: new Date().toISOString(),
      phaseId: "prepare",
      detail: "Mock turn started.",
    });

    try {
      if (config.shouldTimeout) {
        // Simulate a bit of work then timeout
        await sleep(300);
        throw new Error("turn timed out after 1000ms");
      }

      if (config.errorMessage) {
        throw new Error(config.errorMessage);
      }

      if (config.workDelayMs && config.workDelayMs > 0) {
        const stepInterval = 500;
        const steps = Math.max(1, Math.floor(config.workDelayMs / stepInterval));
        for (let i = 0; i < steps; i++) {
          await sleep(stepInterval);
          emit.send({
            type: "turn.progress",
            turnId,
            segmentId,
            phaseId: "agent",
            detail: `Working... step ${i + 1}/${steps}`,
            at: new Date().toISOString(),
          });
        }
        // Wait any remaining ms
        const elapsed = steps * stepInterval;
        if (elapsed < config.workDelayMs) {
          await sleep(config.workDelayMs - elapsed);
        }
      }

      emit.send({
        type: "turn.completed",
        turnId,
        segmentId,
        response: {
          text: "Mock turn complete",
          status: "completed",
        } as any,
        at: new Date().toISOString(),
      });
    } catch (err) {
      emit.send({
        type: "turn.error",
        turnId,
        segmentId,
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      });
    } finally {
      emit.close();
    }
  })();
}

/** Like runMockTurn but checks AbortSignal and sends turn.cancelled on abort. */
function runMockTurnWithCancel(
  emit: SseEmitter,
  signal: AbortSignal,
  config: MockTurnConfig,
): void {
  const turnId = crypto.randomUUID();
  const segmentId = crypto.randomUUID();

  void (async () => {
    emit.send({
      type: "turn.started",
      turnId,
      segmentId,
      startedAt: new Date().toISOString(),
      phaseId: "prepare",
      detail: "Cancellable mock turn started.",
    });

    if (signal.aborted) {
      emit.send({
        type: "turn.cancelled",
        turnId,
        segmentId,
        reason: "cancelled",
        at: new Date().toISOString(),
      });
      emit.close();
      return;
    }

    const onAbort = (): void => {
      emit.send({
        type: "turn.cancelled",
        turnId,
        segmentId,
        reason: signal.reason === "timeout" ? "timeout" : "cancelled",
        at: new Date().toISOString(),
      });
      emit.close();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (config.shouldTimeout) {
        // Cancel via the cancellation path (sends turn.cancelled with reason "timeout")
        signal.removeEventListener("abort", onAbort);
        await sleep(300);
        if (signal.aborted) return;
        emit.send({
          type: "turn.cancelled",
          turnId,
          segmentId,
          reason: "timeout",
          at: new Date().toISOString(),
        });
        emit.close();
        return;
      }

      if (config.workDelayMs && config.workDelayMs > 0) {
        const stepInterval = 500;
        const steps = Math.max(1, Math.floor(config.workDelayMs / stepInterval));
        for (let i = 0; i < steps; i++) {
          await sleep(stepInterval);
          if (signal.aborted) return; // onAbort already sent turn.cancelled
          emit.send({
            type: "turn.progress",
            turnId,
            segmentId,
            phaseId: "agent",
            detail: `Working... step ${i + 1}/${steps}`,
            at: new Date().toISOString(),
          });
        }
        const elapsed = steps * stepInterval;
        if (elapsed < config.workDelayMs) {
          await sleep(config.workDelayMs - elapsed);
          if (signal.aborted) return;
        }
      }

      signal.removeEventListener("abort", onAbort);

      if (signal.aborted) return;

      emit.send({
        type: "turn.completed",
        turnId,
        segmentId,
        response: {
          text: "Mock turn complete",
          status: "completed",
        } as any,
        at: new Date().toISOString(),
      });
    } catch (err) {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return;
      emit.send({
        type: "turn.error",
        turnId,
        segmentId,
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      });
    } finally {
      emit.close();
    }
  })();
}

// ---------------------------------------------------------------------------
// SSE parser helpers
// ---------------------------------------------------------------------------

/** Parsed SSE frame — one `\n\n`-delimited block from the wire. */
export interface RawSseFrame {
  /** The `event:` field value, if present. */
  event?: string;
  /** The `data:` field value, if present. */
  data?: string;
  /** Comment-only frames (lines starting with `:`) are tracked here. */
  comment?: string;
}

/** Split raw chunk bytes into individual SSE frames. */
export function splitSseFrames(chunk: string): string[] {
  return chunk.split(/\r?\n\r?\n/).filter(Boolean);
}

/** Parse an SSE frame (single `\n\n`-delimited block). */
export function parseSseFrame(frame: string): RawSseFrame {
  const result: RawSseFrame = {};
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      result.event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      const datum = line.slice("data:".length).trimStart();
      result.data = result.data ? result.data + "\n" + datum : datum;
    } else if (line.startsWith(":")) {
      const comment = line.slice(1).trim();
      result.comment = result.comment ? result.comment + "\n" + comment : comment;
    }
  }
  return result;
}

/** Consume an SSE response body and return all parsed frames. */
export async function collectSseFrames(
  response: Response,
  signal?: AbortSignal,
): Promise<RawSseFrame[]> {
  if (!response.body) throw new Error("Response has no body");
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const frames: RawSseFrame[] = [];
  let buffer = "";

  for (;;) {
    if (signal?.aborted) throw signal.reason;
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const split = buffer.split(/\r?\n\r?\n/);
    buffer = split.pop() ?? "";
    for (const frame of split) {
      if (!frame.trim()) continue;
      frames.push(parseSseFrame(frame));
    }
    if (done) break;
  }

  // trailing data
  if (buffer.trim()) {
    frames.push(parseSseFrame(buffer));
  }

  return frames;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
