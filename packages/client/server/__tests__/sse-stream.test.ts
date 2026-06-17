import { describe, test, expect } from "bun:test";
import { createSseResponse } from "../sse-stream";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Unit tests for createSseResponse
// ---------------------------------------------------------------------------

describe("createSseResponse: idempotent close", () => {
  test("calling close() multiple times via the emitter does not throw", async () => {
    const response = createSseResponse((emit) => {
      emit.close();
      expect(() => emit.close()).not.toThrow();
      expect(() => emit.close()).not.toThrow();
    });

    const reader = response.body!.getReader();
    const first = await reader.read();
    // Stream was closed inside start(), so first read may return done
    // (the close was synchronous)
    if (!first.done) {
      const next = await reader.read();
      expect(next.done).toBe(true);
    }
  });

  test("send() after close() returns false", () => {
    createSseResponse((emit) => {
      emit.close();
      const result = emit.send({
        type: "turn.started",
        turnId: "test",
        segmentId: "seg",
        startedAt: new Date().toISOString(),
        phaseId: "prepare",
      });
      expect(result).toBe(false);
    });
  });

  test("close + cancel does not throw", async () => {
    const response = createSseResponse((emit) => {
      emit.close();
      // Stream is already closed; cancel arrives later from consumer
    });

    const reader = response.body!.getReader();
    // Cancel after close — should be a no-op, not throw
    await reader.cancel();
  });
});

describe("createSseResponse: cancel callback", () => {
  test("onCancel fires when the consumer cancels the stream", async () => {
    let cancelCalled = false;

    const response = createSseResponse(
      (emit) => {
        // Start a long-running async operation
        void (async () => {
          await sleep(2000);
          emit.close();
        })();
      },
      5000,
      {},
      () => {
        cancelCalled = true;
      },
    );

    const reader = response.body!.getReader();
    // Cancel mid-stream
    await reader.cancel();
    expect(cancelCalled).toBe(true);
  });
});

describe("createSseResponse: heartbeat", () => {
  test(
    "heartbeat comments appear during a long turn",
    async () => {
      const response = createSseResponse(
        (emit) => {
          // Start a long turn that takes 500ms
          void (async () => {
            await sleep(600);
            emit.send({
              type: "turn.completed",
              turnId: "hbtest",
              segmentId: "seg",
              response: { text: "done", status: "completed" } as any,
              at: new Date().toISOString(),
            });
            emit.close();
          })();
        },
        100, // fast heartbeat (100ms)
      );

      const reader = response.body!.getReader();
      let buffer = "";
      let heartbeatCount = 0;
      let gotCompleted = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: !done });
        // Count heartbeats in accumulated buffer
        heartbeatCount = (buffer.match(/: heartbeat/g) || []).length;
        if (buffer.includes("turn.completed")) gotCompleted = true;
      }

      // With 100ms heartbeat over 600ms, we should get 2-6 heartbeats
      expect(heartbeatCount).toBeGreaterThanOrEqual(1);
      expect(gotCompleted).toBe(true);
    },
    { timeout: 5_000 },
  );
});

describe("createSseResponse: happy path", () => {
  test("started → progress → completed flow", async () => {
    const response = createSseResponse((emit) => {
      void (async () => {
        emit.send({
          type: "turn.started",
          turnId: "flow",
          segmentId: "s",
          startedAt: new Date().toISOString(),
          phaseId: "prepare",
        });
        await sleep(10);
        emit.send({
          type: "turn.progress",
          turnId: "flow",
          segmentId: "s",
          phaseId: "agent",
          detail: "working",
          at: new Date().toISOString(),
        });
        await sleep(10);
        emit.send({
          type: "turn.completed",
          turnId: "flow",
          segmentId: "s",
          response: { text: "yay", status: "completed" } as any,
          at: new Date().toISOString(),
        });
        emit.close();
      })();
    });

    const reader = response.body!.getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: !done });
    }

    expect(buffer).toContain('"turn.started"');
    expect(buffer).toContain('"turn.progress"');
    expect(buffer).toContain('"turn.completed"');
    expect(buffer).not.toContain('"turn.error"');
  });
});
