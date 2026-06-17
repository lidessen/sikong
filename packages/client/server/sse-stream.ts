import type { TurnStreamEvent } from "../src/types";

/**
 * Emitter interface returned inside the startStream callback.
 * Provides idempotent send/close operations guarded by an internal closed flag.
 */
export interface SseEmitter {
  /** Send a structured TurnStreamEvent. Returns false if the stream is already closed. */
  send(event: TurnStreamEvent): boolean;
  /** Close the stream gracefully. Idempotent — safe to call multiple times. */
  close(): void;
}

/**
 * Create an SSE Response backed by a ReadableStream.
 *
 * The startStream callback receives an {@link SseEmitter} and should fire
 * async work in a void context (e.g. `void (async () => { ... })()`).
 * The stream's cancel() handler sets an internal closed flag that guards
 * against double-close / enqueue-after-close scenarios.
 *
 * @param startStream  Synchronous callback that receives the emitter.
 * @param heartbeatMs  Interval for SSE comment heartbeats (default 5000ms).
 * @param extraHeaders Additional HTTP headers merged into the response.
 */
export function createSseResponse(
  startStream: (emit: SseEmitter) => void,
  heartbeatMs = 5_000,
  extraHeaders: Record<string, string> = {},
  onCancel?: () => void,
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeatHandle: ReturnType<typeof setInterval> | undefined;

  const clearHeartbeat = () => {
    if (heartbeatHandle === undefined) return;
    clearInterval(heartbeatHandle);
    heartbeatHandle = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (payload: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(payload));
          return true;
        } catch {
          closed = true;
          clearHeartbeat();
          return false;
        }
      };

      const emit: SseEmitter = {
        send(event: TurnStreamEvent): boolean {
          return write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        },
        close() {
          if (closed) return;
          closed = true;
          clearHeartbeat();
          try {
            controller.close();
          } catch {
            // Stream may have been closed by the consumer already.
          }
        },
      };

      heartbeatHandle = setInterval(() => {
        write(`: heartbeat ${new Date().toISOString()}\n\n`);
      }, heartbeatMs);

      startStream(emit);
    },
    cancel() {
      closed = true;
      clearHeartbeat();
      onCancel?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...extraHeaders,
    },
  });
}
