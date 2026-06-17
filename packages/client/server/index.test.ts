import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __testSetDataDir, runTurnWorkflow } from "./index";

describe("SSE stream idempotency", () => {
  test("enqueue after controller close is caught and does not rethrow", async () => {
    const encoder = new TextEncoder();
    let closed = false;

    // Simulate the write/close pattern used in createSseResponse
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (payload: string): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(payload));
            return true;
          } catch {
            closed = true;
            return false;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed — idempotent
          }
        };

        // Normal write works
        expect(write("data: first\n\n")).toBe(true);

        // Close the controller
        close();
        expect(closed).toBe(true);

        // Native enqueue after close throws, but our wrapper handles it
        expect(() => write("data: after-close\n\n")).not.toThrow();
        expect(write("data: after-close\n\n")).toBe(false);
        expect(closed).toBe(true);
      },
    });

    // Consume the stream to completion
    const reader = stream.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toContain("first");

    // Stream should be done (controller was closed)
    const next = await reader.read();
    expect(next.done).toBe(true);
  });

  test("double close is idempotent and does not rethrow", () => {
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed
          }
        };

        // First close
        close();
        expect(closed).toBe(true);

        // Second close — should be a no-op
        expect(() => close()).not.toThrow();
        expect(closed).toBe(true);

        // Third close — also no-op
        expect(() => close()).not.toThrow();
      },
    });

    // Consume to clean up
    const reader = stream.getReader();
    reader.cancel();
  });

  test("write after stream cancel returns false silently", () => {
    // Verify that the write-check pattern handles stream cancel gracefully
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (payload: string): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(payload));
            return true;
          } catch {
            closed = true;
            return false;
          }
        };

        // Write succeeds before cancel
        expect(write("data: before\n\n")).toBe(true);

        // Simulate cancel setting closed = true (as createSseResponse does)
        closed = true;

        // Write after closed returns false
        expect(write("data: after\n\n")).toBe(false);
      },
    });

    const reader = stream.getReader();
    reader.cancel();
  });
});

describe("Turn cancellation via AbortSignal", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sikong-client-api-"));
    __testSetDataDir(tempDir);
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  test("runTurnWorkflow with already-aborted signal returns cancelled status", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const result = await runTurnWorkflow({ message: "test" }, undefined, abortController.signal);

    expect(result.status).toBe("cancelled");
    expect(result.text).toBe("");
    expect(result.context).toBeDefined();
    expect(result.message?.role).toBe("system");
  });

  test("runTurnWorkflow with different workspace params returns cancelled", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const result = await runTurnWorkflow(
      { message: "hello", workspaceId: "test-ws", taskId: "test-task" },
      undefined,
      abortController.signal,
    );

    expect(result.status).toBe("cancelled");
  });
});
