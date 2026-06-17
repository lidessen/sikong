import { describe, expect, test } from "bun:test";
import { createTurnSession } from "../turn-registry";

describe("turn registry", () => {
  test("buffers events for resume subscribers", () => {
    const session = createTurnSession();
    session.publish({
      type: "turn.progress",
      turnId: session.turnId,
      segmentId: session.segmentId,
      phaseId: "agent",
      at: new Date().toISOString(),
    });

    const seen: string[] = [];
    session.attach((event) => {
      seen.push(event.type);
    }, -1);

    expect(seen).toEqual(["turn.progress"]);
  });
});
