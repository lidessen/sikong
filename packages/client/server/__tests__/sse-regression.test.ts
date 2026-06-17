import { describe, test, expect } from "bun:test";
import { startTestServer, collectSseFrames } from "./helpers";

// ---------------------------------------------------------------------------
// Regression test suite: SSE long-running & disconnect scenarios
// ---------------------------------------------------------------------------

describe("SSE regression: slow turn", () => {
  test(
    "a 12s slow turn delivers heartbeats, progress, and turn.completed without interruption",
    async () => {
      const server = startTestServer({ workDelayMs: 12_000 });
      try {
        const start = Date.now();

        const response = await fetch(`${server.url}/api/turn/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "long turn test" }),
        });

        expect(response.ok).toBe(true);
        expect(response.headers.get("content-type")).toContain("text/event-stream");

        // Collect all SSE frames (may take ~12s)
        const frames = await collectSseFrames(response);
        const elapsed = Date.now() - start;

        // Sanity: entire interaction took at least the work delay
        expect(elapsed).toBeGreaterThanOrEqual(10_000);

        // Extract event frames and comment (heartbeat) frames
        const events = frames.filter((f) => f.event);
        const comments = frames.filter((f) => f.comment);
        const heartbeats = comments.filter((f) => f.comment?.startsWith("heartbeat"));

        // Heartbeats: with 100ms interval over ~12s we expect many
        expect(heartbeats.length).toBeGreaterThanOrEqual(20);

        // Progress events
        const progressEvents = events.filter((e) => e.event === "turn.progress");
        expect(progressEvents.length).toBeGreaterThanOrEqual(5);

        // Must have started and completed (no error)
        const eventTypes = events.map((e) => e.event);
        expect(eventTypes).toContain("turn.started");
        expect(eventTypes).toContain("turn.completed");
        expect(eventTypes).not.toContain("turn.error");

        // Completed is the last event
        const lastEvent = events[events.length - 1];
        expect(lastEvent?.event).toBe("turn.completed");

        // Verify completed event data is valid JSON
        const completedData = JSON.parse(lastEvent?.data ?? "{}");
        expect(completedData.type).toBe("turn.completed");
        expect(completedData.response?.status).toBe("completed");
      } finally {
        server.stop();
      }
    },
    { timeout: 25_000 },
  );
});

describe("SSE regression: client disconnect", () => {
  test(
    "aborting the reader mid-turn does not crash the server",
    async () => {
      const server = startTestServer({ workDelayMs: 5_000 });
      try {
        const ac = new AbortController();

        const response = await fetch(`${server.url}/api/turn/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "abort test" }),
          signal: ac.signal,
        });

        expect(response.ok).toBe(true);
        const reader = response.body!.getReader();

        // Read some initial data (heartbeats / started)
        const first = await reader.read();
        expect(first.done).toBe(false);

        // Abort mid-turn — this triggers stream cancel() on server
        ac.abort();

        // Give the server a moment to process the cancel
        await sleep(300);

        // Verify the server is still healthy and hasn't crashed
        const healthResponse = await fetch(`${server.url}/api/health`);
        expect(healthResponse.ok).toBe(true);
        const health = (await healthResponse.json()) as { ok: boolean };
        expect(health.ok).toBe(true);
      } finally {
        server.stop();
      }
    },
    { timeout: 15_000 },
  );

  test(
    "aborting immediately still keeps server healthy",
    async () => {
      const server = startTestServer({ workDelayMs: 10_000 });
      try {
        const ac = new AbortController();

        const response = await fetch(`${server.url}/api/turn/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "immediate abort" }),
          signal: ac.signal,
        });

        const reader = response.body!.getReader();

        // Abort almost immediately after getting response
        await sleep(50);
        ac.abort();

        // Server still healthy
        await sleep(200);
        const health = (await fetch(`${server.url}/api/health`).then((r) => r.json())) as {
          ok: boolean;
        };
        expect(health.ok).toBe(true);

        // Reader was disposed (we don't care about the error, just no crash)
        try {
          await reader.cancel();
        } catch {
          // ok
        }
      } finally {
        server.stop();
      }
    },
    { timeout: 15_000 },
  );
});

describe("SSE regression: server timeout", () => {
  test(
    "turn exceeding server timeout emits turn.error and closes the connection",
    async () => {
      const server = startTestServer({ shouldTimeout: true });
      try {
        const response = await fetch(`${server.url}/api/turn/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "timeout test" }),
        });

        expect(response.ok).toBe(true);

        const frames = await collectSseFrames(response);
        const events = frames.filter((f) => f.event);
        const eventTypes = events.map((e) => e.event);

        // Must have started
        expect(eventTypes).toContain("turn.started");

        // Must NOT have completed
        expect(eventTypes).not.toContain("turn.completed");

        // Must have error
        expect(eventTypes).toContain("turn.error");

        // Error event should mention timeout
        const errorEvent = events.find((e) => e.event === "turn.error");
        const errorData = JSON.parse(errorEvent?.data ?? "{}");
        expect(errorData.type).toBe("turn.error");
        expect(errorData.message?.toLowerCase()).toContain("timed out");

        // Stream is done — collectSseFrames consumed it until close
        expect(errorEvent?.data).toBeTruthy();

        // Error should be the last event before close
        expect(events[events.length - 1]?.event).toBe("turn.error");
      } finally {
        server.stop();
      }
    },
    { timeout: 15_000 },
  );
});

describe("SSE regression: turn cancellation event", () => {
  test(
    "aborting a turn mid-flight does not crash the server (cancellation mode)",
    async () => {
      const server = startTestServer({ workDelayMs: 8_000, enableCancellation: true });
      try {
        const ac = new AbortController();

        const response = await fetch(`${server.url}/api/turn/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "cancel test" }),
          signal: ac.signal,
        });

        expect(response.ok).toBe(true);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        // Read a couple frames then abort mid-turn
        for (let i = 0; i < 2; i++) {
          const { done, value } = await reader.read();
          if (done) break;
          decoder.decode(value, { stream: !done });
        }

        ac.abort();

        // Small delay for server to process cancellation
        await sleep(500);

        // Verify server is still healthy
        const health = (await fetch(`${server.url}/api/health`).then((r) => r.json())) as {
          ok: boolean;
        };
        expect(health.ok).toBe(true);
      } finally {
        server.stop();
      }
    },
    { timeout: 15_000 },
  );

  test(
    "server timeout sends turn.cancelled with reason 'timeout' when cancellation is enabled",
    async () => {
      const server = startTestServer({ shouldTimeout: true, enableCancellation: true });
      try {
        const response = await fetch(`${server.url}/api/turn/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "timeout cancel test" }),
        });

        expect(response.ok).toBe(true);

        const frames = await collectSseFrames(response);
        const events = frames.filter((f) => f.event);
        const eventTypes = events.map((e) => e.event);

        // Must have started and cancelled (not error)
        expect(eventTypes).toContain("turn.started");
        expect(eventTypes).toContain("turn.cancelled");
        expect(eventTypes).not.toContain("turn.completed");
        expect(eventTypes).not.toContain("turn.error");

        // Cancelled event should have reason "timeout"
        const cancelledEvent = events.find((e) => e.event === "turn.cancelled");
        const cancelledData = JSON.parse(cancelledEvent?.data ?? "{}");
        expect(cancelledData.type).toBe("turn.cancelled");
        expect(cancelledData.reason).toBe("timeout");

        // Cancelled should be the last event before close
        expect(events[events.length - 1]?.event).toBe("turn.cancelled");
      } finally {
        server.stop();
      }
    },
    { timeout: 10_000 },
  );
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
